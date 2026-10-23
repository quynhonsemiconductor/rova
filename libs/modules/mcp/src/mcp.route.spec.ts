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
import type { CacheService } from '@quynhonsemiconductor/platform-cache';
import { afterEach, describe, expect, it } from 'vitest';
import { RequestContextService } from '@quynhonsemiconductor/observability';
import { enableCorrelationId } from '@quynhonsemiconductor/platform-http';
import { McpModule, registerMcpRoute, UNCONFIGURED_MCP_ACCESS_VERIFIER } from './index';
import type { McpAccessVerifier } from './mcp-access-verifier';
import { mintMcpCallToken, MCP_CALL_TOKEN_HEADER } from './mcp-principal';

/**
 * `/mcp` against a live Fastify server (no port — `inject`), with the SAME wiring the bootstrap
 * uses (raw route + McpModule's global principal guard). The REST side is a fixture controller
 * standing in for `ProjectsController`: it sits behind the same guard pipeline, so these specs
 * prove the BRIDGE — same principal, same refusal — not project rules (those are the modules'
 * own specs; the gate-g parity run against real fixtures follows once the access adapter ships).
 */

const VICTIM = '0194a000-0000-7000-8000-0000000000aa';
const ATTACKER = '0194a000-0000-7000-8000-0000000000ff';
const WORKSPACE = '0194a000-0000-7000-8000-000000000003';
const RESTRICTED = '0194a000-0000-7000-8000-000000000004';
const VICTIM_TOKEN = 'access.victim.token';
const ATTACKER_TOKEN = 'access.attacker.token';

const verifier: McpAccessVerifier = {
  verify: async (bearer) => {
    if (bearer === VICTIM_TOKEN) return { userId: VICTIM };
    if (bearer === ATTACKER_TOKEN) return { userId: ATTACKER };
    return null;
  },
};

/** The one method `registerMcpRoute` uses; the rest of CacheService is never touched. */
const cache = {
  consumeRateLimit: async () => ({ allowed: true, remaining: 59, resetAt: 0 }),
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

afterEach(async () => {
  await app?.close();
  app = undefined;
});

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
  return res.json<InitializeResponse>();
}

/** Minimal JSON-RPC response shape the specs read. */
interface ToolCallResponse {
  result?: { isError?: boolean; content?: { type: string; text: string }[] };
}

interface InitializeResponse {
  result?: { serverInfo?: { name?: string }; sessionId?: string };
}

async function callTool(
  fastify: FastifyInstance,
  name: string,
  args: object,
  token = VICTIM_TOKEN,
): Promise<{ statusCode: number; body: ToolCallResponse }> {
  await initialize(fastify, token);
  const res = await rpc(fastify, 'tools/call', { name, arguments: args }, token);
  return { statusCode: res.statusCode, body: res.json<ToolCallResponse>() };
}

describe('/mcp (stateless; MCP_ENABLED gates the registration in the bootstrap)', () => {
  it('initializes statelessly and lists only the read-only tools', async () => {
    const fastify = await boot();
    const init = await initialize(fastify);
    expect(init.result!.serverInfo!.name).toBe('rova');
    expect(init.result).not.toHaveProperty('sessionId');

    const list = await rpc(fastify, 'tools/list');
    interface ToolListResponse {
      result?: { tools?: { name: string; annotations?: { readOnlyHint?: boolean } }[] };
    }
    const tools = list.json<ToolListResponse>().result!.tools!;
    expect(tools.map((t) => t.name).sort()).toEqual(['get_project', 'list_projects']);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it('a tool returns exactly what the same person sees via the same REST route', async () => {
    const fastify = await boot();

    // An in-process call with NO MCP context is refused — the context is not ambient.
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
    const { statusCode, body } = await callTool(fastify, 'list_projects', {
      workspaceId: WORKSPACE,
      limit: 5,
    });
    expect(statusCode).toBe(200);
    const rest = direct.json();
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
    const fastify = await boot();
    const { body } = await callTool(fastify, 'list_projects', { workspaceId: RESTRICTED });
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
    // the forged headers name the victim; the verifier names the attacker
    const { body } = await callTool(
      fastify,
      'list_projects',
      { workspaceId: WORKSPACE },
      ATTACKER_TOKEN,
    );
    const out = JSON.parse(body.result!.content![0].text);
    // the fixture names each row after the principal the guard pipeline delivered
    expect(JSON.stringify(out)).not.toContain(VICTIM);
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

  it('stateless: GET and DELETE answer 405', async () => {
    const fastify = await boot();
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await fastify.inject({ method, url: '/mcp' });
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe('POST');
    }
  });
});
