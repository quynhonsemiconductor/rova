import {
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  Param,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
  NotFoundException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { CacheService } from '@quynhonsemiconductor/platform-cache';
import { RequestContextService } from '@quynhonsemiconductor/observability';
import { enableCorrelationId } from '@quynhonsemiconductor/platform-http';
import {
  McpAccessDeniedError,
  McpModule,
  registerMcpRoute,
  UNCONFIGURED_MCP_ACCESS_VERIFIER,
} from './index';
import type { McpAccessVerifier } from './access-verifier';
import { mintMcpCallToken, MCP_CALL_TOKEN_HEADER } from '@platform';

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
const VICTIM_TOKEN = 'access.victim.token';
const ATTACKER_TOKEN = 'access.attacker.token';

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

@Module({
  imports: [McpModule],
  controllers: [FixtureProjectsController, FixtureWorkItemsController, FixtureIterationsController],
  providers: [RequestContextService, RequirePrincipalGuard],
})
class TestModule {}

let app: NestFastifyApplication | undefined;

async function boot(routeVerifier: McpAccessVerifier = verifier): Promise<FastifyInstance> {
  app = await NestFactory.create<NestFastifyApplication>(TestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('v1');
  enableCorrelationId(app);
  await app.init();
  const fastify = app.getHttpAdapter().getInstance();
  registerMcpRoute({ app, fastify, verifier: routeVerifier, cache, serverVersion: '0.0.0-test' });
  await fastify.ready();
  return fastify;
}

// ── JSON-RPC helpers ─────────────────────────────────────────────────────────

let rpcId = 0;
function rpc(fastify: FastifyInstance, method: string, params?: object, token = VICTIM_TOKEN) {
  rpcId += 1;
  return fastify.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'content-type': 'application/json',
      // the Streamable HTTP transport refuses (406) without both media types
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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
      'get_project',
      'get_work_item',
      'get_work_item_by_key',
      'iteration_burndown',
      'iteration_options',
      'iteration_status',
      'list_backlog',
      'list_comments',
      'list_iterations',
      'list_milestones',
      'list_project_members',
      'list_projects',
      'list_releases',
      'my_work',
      'search_work_items',
      'team_capacity',
      'unread_notifications',
      'velocity',
      'whoami',
      'work_item_activity',
    ]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
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
    const { statusCode, body } = await callTool(fastify, 'list_projects', { limit: 5 });
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
    const { body } = await callTool(onRestricted, 'list_projects', {});
    expect(body.result!.isError).toBe(true);
    const relayed = JSON.parse(body.result!.content![0].text);
    expect(relayed.statusCode).toBe(403);
    expect(relayed.error).toEqual({
      statusCode: 403,
      message: 'Forbidden resource',
      error: 'Forbidden',
    });
  });

  it('an external request cannot forge the in-process principal: tools act as the VERIFIED person', async () => {
    const fastify = await boot();
    // the request carries no principal headers at all; the verifier alone decides who acts
    const { body } = await callTool(fastify, 'list_projects', {}, ATTACKER_TOKEN);
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
    const bad = await rpc(fastify, 'initialize', { protocolVersion: '2025-06-18' }, 'garbage');
    expect(bad.statusCode).toBe(401);
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
    expect(tools.length).toBe(20);
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
    { name: 'list_projects', args: {}, notFoundArg: {} },
    { name: 'get_project', args: { projectId: KNOWN_ID }, notFoundArg: { projectId: UNKNOWN_ID } },
    {
      name: 'list_project_members',
      args: { projectId: KNOWN_ID },
      notFoundArg: { projectId: UNKNOWN_ID },
    },
    {
      name: 'list_comments',
      args: { workItemId: KNOWN_ITEM },
      notFoundArg: { workItemId: UNKNOWN_ITEM },
    },
    {
      name: 'get_work_item_by_key',
      args: { itemKey: 'OBSE-42' },
      notFoundArg: { itemKey: 'MISSING-1' },
    },
    { name: 'list_backlog', args: { projectId: KNOWN_ID }, notFoundArg: { projectId: UNKNOWN_ID } },
    {
      name: 'work_item_activity',
      args: { workItemId: KNOWN_ITEM },
      notFoundArg: { workItemId: UNKNOWN_ITEM },
    },
    {
      name: 'iteration_status',
      args: { iterationId: KNOWN_ITERATION },
      notFoundArg: { iterationId: UNKNOWN_ITERATION },
    },
    {
      name: 'iteration_options',
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
        ['get_work_item_by_key', 'work_item_activity', 'iteration_status'].includes(c.name),
      );
      expect(NOT_FOUND_CASES.length).toBe(3);
      for (const { name, notFoundArg } of NOT_FOUND_CASES) {
        await expectErrorRelay(verifier, name, notFoundArg, 404);
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
