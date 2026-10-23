import {
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  Req,
  UnauthorizedException,
  UseGuards,
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
import { McpModule, registerMcpRoute, UNCONFIGURED_MCP_ACCESS_VERIFIER } from './index';
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

/** Names the row after the principal the guard pipeline actually delivered — no way to guess it. */
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
}

@Module({
  imports: [McpModule],
  controllers: [FixtureProjectsController],
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
      'get_work_item',
      'list_comments',
      'list_iterations',
      'list_projects',
      'my_work',
      'search_work_items',
      'whoami',
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
    expect(tools.length).toBe(7);
    for (const tool of tools) {
      expect(
        JSON.stringify(tool.inputSchema).match(/workspace/i),
        `${tool.name} must not take a workspace argument`,
      ).toBeNull();
    }
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
