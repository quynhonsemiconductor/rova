import {
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
  NotFoundException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CacheService } from '@quynhonsemiconductor/platform-cache';
import { RequestContextService } from '@quynhonsemiconductor/observability';
import { enableCorrelationId } from '@quynhonsemiconductor/platform-http';
import {
  accessTokenOf,
  McpAccessDeniedError,
  McpModule,
  registerMcpRoute,
  UNCONFIGURED_MCP_ACCESS_VERIFIER,
} from './index';
import type { McpAccessVerifier } from './access-verifier';
import { GlobalExceptionFilter, mintMcpCallToken, MCP_CALL_TOKEN_HEADER, Public } from '@platform';
import { registerMcpWriteHook } from './write-hook';
import { MCP_READ_ROUTES, MCP_WRITE_ROUTES, setMcpWritesEnabled } from './write-policy';

/**
 * The fixture's write route is allowlisted ONLY for this file, so the positive path (writes on +
 * a listed route) can be exercised without adding a real write tool. The negative paths are
 * unaffected: everything else stays unlisted.
 */
vi.mock('./write-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./write-policy')>();
  return {
    ...actual,
    MCP_WRITE_ROUTES: new Set([
      ...actual.MCP_WRITE_ROUTES,
      actual.mcpWriteRouteKey('POST', '/v1/projects/fixture-writes'),
      actual.mcpWriteRouteKey('POST', '/raw-fixture-allowed'),
    ]),
  };
});

/**
 * `/mcp` against a live Fastify server (no port — `inject`), with the SAME wiring the bootstrap
 * uses (raw route + McpModule's global principal guard). The REST side is a fixture controller
 * standing in for the real modules: it sits behind the same guard pipeline, so these specs prove
 * the BRIDGE — same principal, same refusal, per-person rate-limit key — not project rules
 * (those are the modules' own specs; the gate-g parity run against real fixtures follows once
 * the access adapter ships).
 */

const VICTIM = '0194a000-0000-7000-8000-0000000000aa';
const ATTACKER = '0194a000-0000-7000-8000-0000000000ff';
const WORKSPACE = '0194a000-0000-7000-8000-000000000003';
const RESTRICTED = '0194a000-0000-7000-8000-000000000004';
// JWT-shaped on purpose: an opaque bearer alone is no longer accepted, and direct clients (this
// spec included) send the Access JWT itself as the bearer.
const VICTIM_TOKEN = 'victim-header.victim-payload.victim-signature';
const ATTACKER_TOKEN = 'attacker-header.attacker-payload.attacker-signature';

const verifier: McpAccessVerifier = {
  verify: async (bearer) => {
    if (bearer === VICTIM_TOKEN) return { userId: VICTIM, workspaceId: WORKSPACE };
    if (bearer === ATTACKER_TOKEN) return { userId: ATTACKER, workspaceId: WORKSPACE };
    return null;
  },
};

/** Records the keys the route asks for; always admits. */
const consumedKeys: string[] = [];
const cache = {
  consumeRateLimit: async (key: string) => {
    consumedKeys.push(key);
    return { allowed: true, remaining: 59, resetAt: 0 };
  },
} as unknown as CacheService;

/** Stands in for identity's global SessionGuard: no principal, no entry (the 401 the belt gives). */
@Injectable()
class RequirePrincipalGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ user?: { sub: string } }>();
    if (!req.user?.sub) throw new UnauthorizedException('Sign in required');
    return true;
  }
}

const UNKNOWN_ID = '00000000-0000-7000-8000-0000000000e1';

/** Names rows after the principal the guard pipeline actually delivered — no way to guess it. */
@Controller('projects')
@UseGuards(RequirePrincipalGuard)
class FixtureProjectsController {
  /**
   * A write route the fixture offers to prove the REST belt: it is NOT in the MCP write
   * allowlist, so a bridged POST is refused before this handler runs.
   */
  @Post('fixture-writes')
  createForbiddenWrite() {
    return { created: true };
  }

  /**
   * A @Public() POST: the principal guard returns before it consumes the call token, which is
   * exactly the case the write gate must still fail closed on.
   */
  @Post('fixture-public')
  @Public()
  createPublic() {
    return { created: true };
  }

  @Get()
  list(@Req() req: { user: { sub: string; workspaceId: string } }) {
    if (req.user.workspaceId === RESTRICTED) {
      // what PolicyGuard answers for a workspace the person cannot read
      throw new ForbiddenException('Forbidden resource');
    }
    return {
      data: [
        {
          id: '0194a000-0000-7000-8000-000000000101',
          workspaceId: req.user.workspaceId,
          principal: req.user.sub,
          key: 'OBSE',
          name: 'Infrastructure',
          status: 'active',
          leadId: null,
          leadName: null,
        },
      ],
      pageInfo: { hasNextPage: false },
    };
  }

  @Get(':id')
  getOne(@Req() req: { user: { workspaceId: string } }, @Param('id') id: string) {
    if (req.user.workspaceId === RESTRICTED || id === UNKNOWN_ID)
      throw new ForbiddenException('Forbidden resource');
    return { id, key: 'OBSE', name: 'Infrastructure', status: 'active', leadName: null };
  }

  @Get(':id/members')
  members(@Req() req: { user: { workspaceId: string } }, @Param('id') id: string) {
    return this.optionsOrMembers(req, id);
  }

  @Get(':id/member-options')
  options(@Req() req: { user: { workspaceId: string } }, @Param('id') id: string) {
    return this.optionsOrMembers(req, id);
  }

  private optionsOrMembers(req: { user: { workspaceId: string } }, id: string) {
    if (req.user.workspaceId === RESTRICTED || id === UNKNOWN_ID)
      throw new ForbiddenException('Forbidden resource');
    return [
      {
        userId: '0194a000-0000-7000-8000-000000000201',
        displayName: 'Member One',
        email: 'member.one@qnsc.dev',
        avatarUrl: null,
      },
    ];
  }
}

const UNKNOWN_ITEM = '00000000-0000-7000-8000-0000000000e2';
const UNKNOWN_ITERATION = '00000000-0000-7000-8000-0000000000e3';

@Controller('work-items')
@UseGuards(RequirePrincipalGuard)
class FixtureWorkItemsController {
  @Get('by-key')
  byKey(@Req() req: { user: { workspaceId: string } }, @Query('itemKey') itemKey?: string) {
    if (req.user.workspaceId === RESTRICTED) throw new ForbiddenException('Forbidden resource');
    if (itemKey === 'MISSING-1') throw new NotFoundException('Not found');
    return {
      id: '0194a000-0000-7000-8000-000000000102',
      itemKey: 'OBSE-42',
      title: 'Fix the flume',
      type: 'task',
      scheduleState: 'in_progress',
      priority: 'high',
      assigneeName: 'Member One',
      iterationId: null,
    };
  }

  @Get('backlog')
  backlog(@Req() req: { user: { workspaceId: string } }) {
    if (req.user.workspaceId === RESTRICTED) throw new ForbiddenException('Forbidden resource');
    return {
      data: [
        {
          id: '0194a000-0000-7000-8000-000000000103',
          itemKey: 'OBSE-7',
          title: 'Backlog story',
          type: 'story',
          scheduleState: 'proposed',
          priority: 'low',
          assigneeName: null,
          iterationId: null,
        },
      ],
      pageInfo: { hasNextPage: false },
    };
  }

  @Get(':id/comments')
  comments(@Req() req: { user: { workspaceId: string } }, @Param('id') id: string) {
    if (req.user.workspaceId === RESTRICTED || id === UNKNOWN_ITEM)
      throw new ForbiddenException('Forbidden resource');
    return [];
  }

  @Get(':id/activity')
  activity(@Req() req: { user: { workspaceId: string } }, @Param('id') id: string) {
    if (req.user.workspaceId === RESTRICTED) throw new ForbiddenException('Forbidden resource');
    if (id === UNKNOWN_ITEM) throw new NotFoundException('Not found');
    return [
      {
        id: '0194a000-0000-7000-8000-000000000104',
        createdAt: '2026-10-24T10:00:00.000Z',
        actorName: 'Member One',
        action: 'work_item.created',
      },
    ];
  }
}

@Controller('iterations')
@UseGuards(RequirePrincipalGuard)
class FixtureIterationsController {
  @Get('options')
  options(@Req() req: { user: { workspaceId: string } }) {
    if (req.user.workspaceId === RESTRICTED) throw new ForbiddenException('Forbidden resource');
    return [
      {
        id: '0194a000-0000-7000-8000-000000000105',
        name: 'Sprint 1',
        iterationKey: 'IT-1',
        state: 'active',
        startDate: '2026-10-01',
        endDate: '2026-10-15',
        teamId: null,
      },
    ];
  }

  @Get(':id/status')
  status(@Req() req: { user: { workspaceId: string } }, @Param('id') id: string) {
    if (req.user.workspaceId === RESTRICTED) throw new ForbiddenException('Forbidden resource');
    if (id === UNKNOWN_ITERATION) throw new NotFoundException('Not found');
    return {
      iteration: {
        name: 'Sprint 1',
        state: 'active',
        startDate: '2026-10-01',
        endDate: '2026-10-15',
      },
      metrics: {
        plannedVelocity: 40,
        acceptedPoints: 12,
        acceptedPercent: 30,
        daysLeft: 3,
        defectCount: 1,
        taskCount: 8,
      },
      items: [
        {
          workItemId: '0194a000-0000-7000-8000-000000000103',
          itemKey: 'OBSE-7',
          type: 'story',
          title: 'Backlog story',
          scheduleState: 'proposed',
          isBlocked: false,
          planEstimate: 5,
        },
      ],
      pageInfo: { hasNextPage: false },
    };
  }
}

/**
 * The REAL filter, so a refusal is asserted in the envelope a client actually receives:
 * `{ error: { code, message, details, correlationId } }`. It is constructed unbound, which the
 * filter supports (it reads the request context store itself).
 */
const globalFilter = new GlobalExceptionFilter();

/** The fixture's kill switch, published to the process-wide flag the guard reads. */
const fixtureConfig = { writesEnabled: false };

@Module({
  imports: [McpModule],
  controllers: [FixtureProjectsController, FixtureWorkItemsController, FixtureIterationsController],
  providers: [
    RequestContextService,
    RequirePrincipalGuard,
    { provide: APP_FILTER, useValue: globalFilter },
  ],
})
class TestModule {}

let app: NestFastifyApplication | undefined;

async function boot(
  routeVerifier: McpAccessVerifier = verifier,
  options: { writesEnabled?: boolean; hook?: boolean } = {},
): Promise<FastifyInstance> {
  fixtureConfig.writesEnabled = options.writesEnabled ?? false;
  setMcpWritesEnabled(fixtureConfig.writesEnabled);
  app = await NestFactory.create<NestFastifyApplication>(TestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('v1');
  enableCorrelationId(app);
  await app.init();
  const fastify = app.getHttpAdapter().getInstance();
  // The bootstrap registers this hook for RAW Fastify routes; the fixture mirrors that so the
  // raw-route test exercises the real behaviour. One test turns it off to exercise the GUARD
  // (and the real GlobalExceptionFilter) alone.
  if (options.hook !== false)
    registerMcpWriteHook(fastify, {
      writesEnabled: fixtureConfig.writesEnabled,
      reads: MCP_READ_ROUTES,
      writes: MCP_WRITE_ROUTES,
    });
  fastify.post('/raw-fixture', async () => ({ raw: true }));
  fastify.post('/raw-fixture-allowed', async () => ({ raw: true }));
  registerMcpRoute({
    app,
    fastify,
    verifier: routeVerifier,
    cache,
    serverVersion: '0.0.0-test',
    writesEnabled: fixtureConfig.writesEnabled,
    idempotencySecret: 'x'.repeat(32),
  });
  await fastify.ready();
  return fastify;
}

// ── JSON-RPC helpers ─────────────────────────────────────────────────────────

let rpcId = 0;
function rpc(
  fastify: FastifyInstance,
  method: string,
  params?: object,
  token = VICTIM_TOKEN,
  accessJwt?: string,
) {
  rpcId += 1;
  return fastify.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'content-type': 'application/json',
      // the Streamable HTTP transport refuses (406) without both media types
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(accessJwt ? { 'cf-access-jwt-assertion': accessJwt } : {}),
    },
    payload: { jsonrpc: '2.0', id: rpcId, method, ...(params ? { params } : {}) },
  });
}

interface InitializeResponse {
  result?: { serverInfo?: { name?: string }; sessionId?: string };
}

async function initialize(
  fastify: FastifyInstance,
  token = VICTIM_TOKEN,
): Promise<InitializeResponse> {
  const res = await rpc(
    fastify,
    'initialize',
    {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'spec', version: '0.0.0' },
    },
    token,
  );
  expect(res.statusCode).toBe(200);
  return res.json();
}

interface ToolCallResponse {
  result?: { isError?: boolean; content?: { type: string; text: string }[] };
}

async function callTool(
  fastify: FastifyInstance,
  name: string,
  args: object,
  token = VICTIM_TOKEN,
): Promise<{ statusCode: number; body: ToolCallResponse }> {
  await initialize(fastify, token);
  const res = await rpc(fastify, 'tools/call', { name, arguments: args }, token);
  return { statusCode: res.statusCode, body: res.json() };
}

interface ToolListResponse {
  result?: {
    tools?: { name: string; annotations?: { readOnlyHint?: boolean }; inputSchema?: unknown }[];
  };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('/mcp (stateless; MCP_ENABLED gates the registration in the bootstrap)', () => {
  it('initializes statelessly and lists exactly the P1 read-only tools', async () => {
    const fastify = await boot();
    const init = await initialize(fastify);
    expect(init.result!.serverInfo!.name).toBe('rova');
    expect(init.result).not.toHaveProperty('sessionId');

    const list = await rpc(fastify, 'tools/list');
    const tools = list.json<ToolListResponse>().result!.tools!;
    expect(tools.map((t) => t.name).sort()).toEqual([
      'rova_carryover_report',
      'rova_get_milestone',
      'rova_get_portfolio_item',
      'rova_get_project',
      'rova_get_release',
      'rova_get_test_case_by_key',
      'rova_get_work_item',
      'rova_get_work_item_by_key',
      'rova_iteration_burndown',
      'rova_iteration_options',
      'rova_iteration_status',
      'rova_list_backlog',
      'rova_list_comments',
      'rova_list_iterations',
      'rova_list_milestones',
      'rova_list_notifications',
      'rova_list_portfolio_items',
      'rova_list_project_members',
      'rova_list_projects',
      'rova_list_releases',
      'rova_list_teams',
      'rova_list_test_cases',
      'rova_my_work',
      'rova_project_health',
      'rova_quality_defects',
      'rova_release_tracking',
      'rova_search_work_items',
      'rova_team_capacity',
      'rova_team_status',
      'rova_unread_notifications',
      'rova_velocity',
      'rova_whoami',
      'rova_work_item_activity',
      'rova_work_item_code_changes',
    ]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  function beltToken(session: string) {
    return {
      [MCP_CALL_TOKEN_HEADER]: mintMcpCallToken({
        userId: VICTIM,
        workspaceId: WORKSPACE,
        sessionId: session,
      }),
    };
  }

  it('refuses a bridged write while writes are OFF, even for an allowlisted route', async () => {
    const fastify = await boot(verifier, { writesEnabled: false });
    const response = await fastify.inject({
      method: 'POST',
      url: '/v1/projects/fixture-writes',
      payload: {},
      headers: beltToken('mcp:belt-off'),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'MCP_WRITE_NOT_ALLOWED' });
  });

  it('the GUARD alone (hook off) refuses through the real GlobalExceptionFilter', async () => {
    const fastify = await boot(verifier, { writesEnabled: false, hook: false });
    const response = await fastify.inject({
      method: 'POST',
      url: '/v1/projects/fixture-writes',
      payload: {},
      headers: beltToken('mcp:guard-only'),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'MCP_WRITE_NOT_ALLOWED' } });
  });

  it('allows an allowlisted write through the full chain when writes are ON', async () => {
    const fastify = await boot(verifier, { writesEnabled: true });
    const response = await fastify.inject({
      method: 'POST',
      url: '/v1/projects/fixture-writes',
      payload: {},
      headers: beltToken('mcp:belt-on'),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ created: true });
  });

  it('fails closed on a @Public write that skips the principal guard', async () => {
    const fastify = await boot(verifier, { writesEnabled: true });
    const response = await fastify.inject({
      method: 'POST',
      url: '/v1/projects/fixture-public',
      payload: {},
      headers: beltToken('mcp:public'),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'MCP_WRITE_NOT_ALLOWED' });
  });

  it('fails closed on a RAW non-GET route (the onRequest hook, not a Nest guard)', async () => {
    const fastify = await boot(verifier, { writesEnabled: true });
    const response = await fastify.inject({
      method: 'POST',
      url: '/raw-fixture',
      payload: {},
      headers: beltToken('mcp:raw'),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'MCP_WRITE_NOT_ALLOWED' });
  });

  it('lets a NORMAL raw POST through: the hook only judges a carried MCP token', async () => {
    const fastify = await boot(verifier, { writesEnabled: false });
    const response = await fastify.inject({ method: 'POST', url: '/raw-fixture', payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ raw: true });
  });

  it('allows an allowlisted raw POST when writes are ON', async () => {
    const fastify = await boot(verifier, { writesEnabled: true });
    const response = await fastify.inject({
      method: 'POST',
      url: '/raw-fixture-allowed',
      payload: {},
      headers: beltToken('mcp:raw-allowed'),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ raw: true });
  });

  it('lets a bridged HEAD through as a read', async () => {
    const fastify = await boot(verifier, { writesEnabled: false });
    const response = await fastify.inject({
      method: 'HEAD',
      url: '/v1/projects',
      headers: beltToken('mcp:head'),
    });
    expect(response.statusCode).toBe(200);
  });

  it('a tool returns exactly what the same person sees via the same REST route', async () => {
    const fastify = await boot();

    // An in-process call with NO call token is refused — the principal is not ambient.
    const anonymous = await fastify.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { authorization: `Bearer ${VICTIM_TOKEN}` },
    });
    expect(anonymous.statusCode).toBe(401);

    // The MCP tool and a direct in-process REST call AS THE SAME PERSON agree: the direct call
    // rides the same single-use call-token bridge the tool's inject() uses.
    const direct = await fastify.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: {
        [MCP_CALL_TOKEN_HEADER]: mintMcpCallToken({
          userId: VICTIM,
          workspaceId: WORKSPACE,
          sessionId: 'mcp:direct',
        }),
      },
    });
    expect(direct.statusCode).toBe(200);
    const rest = direct.json();
    const { statusCode, body } = await callTool(fastify, 'rova_list_projects', { limit: 5 });
    expect(statusCode).toBe(200);
    const out = JSON.parse(body.result!.content![0].text);
    expect(out.projects).toEqual([
      {
        id: rest.data[0].id,
        key: rest.data[0].key,
        name: rest.data[0].name,
        status: rest.data[0].status,
        leadName: rest.data[0].leadName,
      },
    ]);
    expect(out.pageInfo).toEqual(rest.pageInfo);
  });

  it('a denied action is denied identically: the REST refusal passes through unchanged', async () => {
    // the verifier binds THIS session to the restricted workspace; the REST refusal is the
    // person's own 403, relayed untouched
    const restrictedVerifier: McpAccessVerifier = {
      verify: async () => ({ userId: VICTIM, workspaceId: RESTRICTED }),
    };
    const onRestricted = await boot(restrictedVerifier);
    const { body } = await callTool(onRestricted, 'rova_list_projects', {});
    expect(body.result!.isError).toBe(true);
    const relayed = JSON.parse(body.result!.content![0].text);
    expect(relayed.statusCode).toBe(403);
    // The REAL GlobalExceptionFilter envelope, relayed untouched (the tool adds no wrapper of
    // its own beyond the status).
    expect(relayed.error).toMatchObject({
      error: { code: 'FORBIDDEN', message: 'Forbidden resource' },
    });
  });

  it('an external request cannot forge the in-process principal: tools act as the VERIFIED person', async () => {
    const fastify = await boot();
    // the request carries no principal headers at all; the verifier alone decides who acts
    const { body } = await callTool(fastify, 'rova_list_projects', {}, ATTACKER_TOKEN);
    const out = JSON.parse(body.result!.content![0].text);
    // the fixture names each row after the principal the guard pipeline delivered
    expect(JSON.stringify(out)).not.toContain(VICTIM);

    // and with no bearer at all: 401 before any tool runs
    const anon = await rpc(fastify, 'tools/list', undefined, '');
    expect(anon.statusCode).toBe(401);
  });

  it('rate limiting keys PER PERSON: the bucket is mcp:uid:<verified id>, one per person', async () => {
    consumedKeys.length = 0;
    const fastify = await boot();
    await initialize(fastify, VICTIM_TOKEN);
    await initialize(fastify, ATTACKER_TOKEN);
    expect(consumedKeys).toEqual([`mcp:uid:${VICTIM}`, `mcp:uid:${ATTACKER}`]);
  });

  it('an unverified Access token is one uniform 401', async () => {
    const fastify = await boot();
    const bad = await rpc(fastify, 'initialize', { protocolVersion: '2025-06-18' }, 'garbage.x.y');
    expect(bad.statusCode).toBe(401);
  });

  describe('Access identity source (Cf-Access-Jwt-Assertion under Managed OAuth)', () => {
    const INITIALIZE = { protocolVersion: '2025-06-18', capabilities: {} };

    /** A raw POST, so a test can send header values the `rpc` helper's truthiness checks skip. */
    function postRaw(fastify: FastifyInstance, headers: Record<string, string | string[]>) {
      return fastify.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
        payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: INITIALIZE },
      });
    }

    it('the header JWT is accepted and verified', async () => {
      consumedKeys.length = 0;
      const fastify = await boot();
      const res = await rpc(fastify, 'initialize', INITIALIZE, '', VICTIM_TOKEN);
      expect(res.statusCode).toBe(200);
      expect(consumedKeys).toEqual([`mcp:uid:${VICTIM}`]);
    });

    it('an opaque bearer without the header is refused 401 before the verifier', async () => {
      consumedKeys.length = 0;
      const seen: string[] = [];
      const recording: McpAccessVerifier = {
        verify: async (value) => {
          seen.push(value);
          return { userId: VICTIM, workspaceId: WORKSPACE };
        },
      };
      const fastify = await boot(recording);
      // an Access OAuth token under Managed OAuth is opaque: it is not the JWT this origin verifies
      const res = await rpc(fastify, 'initialize', INITIALIZE, 'opaque-access-oauth-token');
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error?: string }>().error).toBe(
        'MCP requires a Cloudflare Access identity',
      );
      expect(seen).toEqual([]);
      expect(consumedKeys).toEqual([]);
    });

    it('the header wins over a bearer', async () => {
      consumedKeys.length = 0;
      const fastify = await boot();
      const res = await rpc(fastify, 'initialize', INITIALIZE, ATTACKER_TOKEN, VICTIM_TOKEN);
      expect(res.statusCode).toBe(200);
      expect(consumedKeys).toEqual([`mcp:uid:${VICTIM}`]);
    });

    it('a forged header JWT is refused 401 BY the verifier (no fallback to the bearer)', async () => {
      const seen: string[] = [];
      const rejecting: McpAccessVerifier = {
        verify: async (value) => {
          seen.push(value);
          return null;
        },
      };
      const fastify = await boot(rejecting);
      const res = await rpc(fastify, 'initialize', INITIALIZE, VICTIM_TOKEN, 'forged.a.b');
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error?: string }>().error).toBe('Unverified Access token');
      // the header alone was checked — the valid bearer was not tried as a fallback
      expect(seen).toEqual(['forged.a.b']);
    });

    it('a JWT-shaped bearer without the header is still verified (direct clients)', async () => {
      consumedKeys.length = 0;
      const fastify = await boot();
      const res = await rpc(fastify, 'initialize', INITIALIZE, VICTIM_TOKEN);
      expect(res.statusCode).toBe(200);
      expect(consumedKeys).toEqual([`mcp:uid:${VICTIM}`]);
    });

    it('accepts a lowercase bearer scheme (scheme names are case-insensitive)', async () => {
      const fastify = await boot();
      const res = await postRaw(fastify, { authorization: `bearer ${VICTIM_TOKEN}` });
      expect(res.statusCode).toBe(200);
    });

    it.each(['a.b', 'a.b.c.d', 'a..c', 'a.b.', 'a.b.c d'])(
      'a bearer that is not JWT-shaped (%j) is refused 401 before the verifier',
      async (token) => {
        const seen: string[] = [];
        const recording: McpAccessVerifier = {
          verify: async (value) => {
            seen.push(value);
            return { userId: VICTIM, workspaceId: WORKSPACE };
          },
        };
        const fastify = await boot(recording);
        const res = await postRaw(fastify, { authorization: `Bearer ${token}` });
        expect(res.statusCode).toBe(401);
        expect(res.json<{ error?: string }>().error).toBe(
          'MCP requires a Cloudflare Access identity',
        );
        expect(seen).toEqual([]);
      },
    );

    it.each(['', '   '])(
      'a present-but-blank header (%j) is refused 401, never the valid bearer behind it',
      async (blank) => {
        const seen: string[] = [];
        const recording: McpAccessVerifier = {
          verify: async (value) => {
            seen.push(value);
            return { userId: VICTIM, workspaceId: WORKSPACE };
          },
        };
        const fastify = await boot(recording);
        const res = await postRaw(fastify, {
          authorization: `Bearer ${VICTIM_TOKEN}`,
          'cf-access-jwt-assertion': blank,
        });
        expect(res.statusCode).toBe(401);
        expect(res.json<{ error?: string }>().error).toBe(
          'MCP requires a Cloudflare Access identity',
        );
        expect(seen).toEqual([]);
      },
    );

    it('a repeated header (an array) yields no token, never its first value', async () => {
      // Node joins a duplicate header into one comma-separated string before Fastify sees it, so
      // the array shape is pinned on the reader directly; the request below pins the wire path.
      expect(
        accessTokenOf({ 'cf-access-jwt-assertion': [VICTIM_TOKEN, ATTACKER_TOKEN] }),
      ).toBeUndefined();

      const fastify = await boot();
      const res = await postRaw(fastify, {
        'cf-access-jwt-assertion': [VICTIM_TOKEN, ATTACKER_TOKEN],
      });
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error?: string }>().error).toBe('Unverified Access token');
    });
  });

  it('the unconfigured verifier (no identity/access-jwt adapter yet) answers 503', async () => {
    const off = await boot(UNCONFIGURED_MCP_ACCESS_VERIFIER);
    const res = await rpc(off, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'spec', version: '0.0.0' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/identity\/access-jwt/);
  });

  it('a JSON-RPC BATCH is refused 400: one message per POST', async () => {
    consumedKeys.length = 0;
    const fastify = await boot();
    // batching was removed in protocol 2025-06-18, but the pinned SDK still accepts an array —
    // one POST would be up to 100 tool calls for one rate-limit unit
    const res = await fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${VICTIM_TOKEN}`,
      },
      payload: [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error?: string }>().error).toMatch(/batching is not supported/);
    // nothing was consumed before the refusal: no rate-limit bucket, no tool call
    expect(consumedKeys).toEqual([]);
  });

  it('an unknown or offboarded employee (adapter denial) is one uniform 403', async () => {
    const denying: McpAccessVerifier = {
      verify: async () => {
        throw new McpAccessDeniedError();
      },
    };
    const withDenial = await boot(denying);
    const res = await rpc(withDenial, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'spec', version: '0.0.0' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error?: string }>().error).toBe('Forbidden');
  });

  it('a verifier that RAISES (e.g. jwks fetch failed) is a 503, never a 500 or a 401', async () => {
    const broken: McpAccessVerifier = {
      verify: () => {
        throw new Error('jwks_unavailable: cannot reach https://team.cloudflareaccess.com/certs');
      },
    };
    const withBroken = await boot(broken);
    const res = await rpc(withBroken, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'spec', version: '0.0.0' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error?: string }>().error).toMatch(/verifier unavailable/);
  });

  it('no tool names a workspace in its input schema (ROVA-MCP-DESIGN §3: bound at sign-in)', async () => {
    const fastify = await boot();
    await initialize(fastify);
    const list = await rpc(fastify, 'tools/list');
    const tools = list.json().result!.tools!;
    expect(tools.length).toBe(34);
    for (const tool of tools) {
      expect(
        JSON.stringify(tool.inputSchema).match(/workspace/i),
        `${tool.name} must not take a workspace argument`,
      ).toBeNull();
    }
  });

  const KNOWN_ID = '0194a000-0000-7000-8000-000000000101';
  const KNOWN_ITEM = '0194a000-0000-7000-8000-000000000103';
  const KNOWN_ITERATION = '0194a000-0000-7000-8000-000000000105';
  const UNKNOWN_ID = '00000000-0000-7000-8000-0000000000e1';
  const UNKNOWN_ITEM = '00000000-0000-7000-8000-0000000000e2';
  const UNKNOWN_ITERATION = '00000000-0000-7000-8000-0000000000e3';

  // ERROR-SHAPE matrix: every object-typed tool relays the route's own 403 and 404 as
  // isError with the statusCode — no `.map` crashes, no shaped stubs on errors.
  const ERROR_MATRIX: Array<{
    name: string;
    args: Record<string, unknown>;
    notFoundArg: Record<string, unknown>;
  }> = [
    { name: 'rova_list_projects', args: {}, notFoundArg: {} },
    {
      name: 'rova_get_project',
      args: { projectId: KNOWN_ID },
      notFoundArg: { projectId: UNKNOWN_ID },
    },
    {
      name: 'rova_list_project_members',
      args: { projectId: KNOWN_ID },
      notFoundArg: { projectId: UNKNOWN_ID },
    },
    {
      name: 'rova_list_comments',
      args: { workItemId: KNOWN_ITEM },
      notFoundArg: { workItemId: UNKNOWN_ITEM },
    },
    {
      name: 'rova_get_work_item_by_key',
      args: { itemKey: 'OBSE-42' },
      notFoundArg: { itemKey: 'MISSING-1' },
    },
    {
      name: 'rova_list_backlog',
      args: { projectId: KNOWN_ID },
      notFoundArg: { projectId: UNKNOWN_ID },
    },
    {
      name: 'rova_work_item_activity',
      args: { workItemId: KNOWN_ITEM },
      notFoundArg: { workItemId: UNKNOWN_ITEM },
    },
    {
      name: 'rova_iteration_status',
      args: { iterationId: KNOWN_ITERATION },
      notFoundArg: { iterationId: UNKNOWN_ITERATION },
    },
    {
      name: 'rova_iteration_options',
      args: { projectId: KNOWN_ID },
      notFoundArg: { projectId: UNKNOWN_ID },
    },
  ];
  // The fixtures deny (403) only when the verifier binds the caller to the RESTRICTED workspace.
  const restrictedVerifier: McpAccessVerifier = {
    verify: async () => ({ userId: VICTIM, workspaceId: RESTRICTED }),
  };

  async function expectErrorRelay(
    verifier: McpAccessVerifier,
    name: string,
    args: Record<string, unknown>,
    statusCode: number,
  ) {
    const f = await boot(verifier);
    const { body } = await callTool(f, name, args);
    expect(
      body.result!.isError,
      `${name}: expected isError — got ${JSON.stringify(body.result).slice(0, 260)}`,
    ).toBe(true);
    const relayed = JSON.parse(body.result!.content![0].text);
    expect(relayed.statusCode, `${name}: status relayed`).toBe(statusCode);
    expect(relayed.error).toBeTruthy();
  }

  describe('per-tool error-shape relay (all object/list tools)', () => {
    it('a 403 from the route is relayed as isError with statusCode', async () => {
      for (const { name, args } of ERROR_MATRIX) {
        await expectErrorRelay(restrictedVerifier, name, args, 403);
      }
    });

    it('a 404 from the route is relayed as isError with statusCode', async () => {
      // only tools whose REST route can 404 on the referenced resource; bare lists have no
      // not-found case (they deny 403 or return empty).
      // get_project and list_project_members 403 instead (PolicyGuard denies before the
      // lookup — no existence leak). by-key/activity/status resolve first and 404.
      // list_comments is resource-tier too but resolves the item like activity — its 403
      // case above already covers the denial shape; the SelfScoped my_work 200s empty.
      const NOT_FOUND_CASES = ERROR_MATRIX.filter((c) =>
        ['rova_get_work_item_by_key', 'rova_work_item_activity', 'rova_iteration_status'].includes(
          c.name,
        ),
      );
      expect(NOT_FOUND_CASES.length).toBe(3);
      for (const { name, notFoundArg } of NOT_FOUND_CASES) {
        await expectErrorRelay(verifier, name, notFoundArg, 404);
      }

      // unknown-id -> 403 (no existence leak) for the routes PolicyGuard guards before lookup
      for (const [name, args] of [
        ['rova_get_project', { projectId: UNKNOWN_ID }],
        ['rova_list_project_members', { projectId: UNKNOWN_ID }],
      ] as const) {
        await expectErrorRelay(verifier, name, args, 403);
      }
    });
  });

  it('stateless: GET and DELETE answer 405', async () => {
    const fastify = await boot();
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await fastify.inject({ method, url: '/mcp' });
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe('POST');
    }
  });
});
