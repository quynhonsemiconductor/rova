import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CacheService } from '@quynhonsemiconductor/platform-cache';
import { RateLimitedException } from '@platform';
import type { McpAccessVerifier } from './mcp-access-verifier';
import { mintMcpCallToken, MCP_CALL_TOKEN_HEADER } from './mcp-principal';
import { registerRovaTools, type McpRestCaller } from './tools/rova-tools';

/**
 * The `/mcp` route: stateless MCP transport, one request, one server, no session.
 *
 * Registered as a RAW Fastify route — outside `/v1`, the session guards, the CSRF gate and the
 * OpenAPI document — because its authentication is the Cloudflare Access JWT, not a cookie, and
 * because the edge scopes the Access application to exactly this path (MCP-PLAN §5; §12 covers
 * the discovery paths and the edge rate-limit row). MCP_ENABLED=false (the default everywhere)
 * registers nothing at all.
 *
 * Per POST: verify the Access JWT via the {@link McpAccessVerifier} (the app-platform
 * `identity/access-jwt` adapter; the unconfigured stub answers 503) → rate-limit PER PERSON from
 * that principal (never per IP: `inject()` traffic arrives from loopback, where IP carries no
 * security meaning — MCP-PLAN §4) → build one stateless `McpServer` + transport
 * (`sessionIdGenerator: undefined`, JSON responses; MCP SDK pinned at the verified version) with
 * the read-only tools → hand the raw req/res to the transport.
 *
 * A tool call mints a SINGLE-USE in-process call token for the verified person and carries only
 * that token on the `inject()` (AsyncLocalStorage cannot span an `inject()` — Fastify gives every
 * request a fresh async context by design; see mcp-principal.ts). `McpPrincipalGuard` consumes
 * the token and writes the principal where the guards already read it, so the injected request
 * crosses the same guards as the person's own session.
 */

/** Per-person MCP budget, tighter than the REST DEFAULT tier: one agent turn is dozens of calls. */
const MCP_RATE_LIMIT = { limit: 60, windowSeconds: 60 };

export interface McpRouteDeps {
  app: NestFastifyApplication;
  fastify: FastifyInstance;
  verifier: McpAccessVerifier;
  cache: CacheService;
  /** Server version reported at `initialize` — the rova package version. */
  serverVersion: string;
}

export function registerMcpRoute(deps: McpRouteDeps): void {
  const { app, fastify, verifier, cache } = deps;

  // The transport wants the raw req/res; Fastify must not touch the reply after we hand it over.
  // The call token is minted HERE (never in a tool) and is the ONLY thing the inject() carries.
  const callRest: McpRestCaller = async (principal, rest) => {
    const injected = await app.inject({
      method: rest.method,
      url: rest.url,
      ...(rest.query
        ? {
            query: Object.fromEntries(
              Object.entries(rest.query).filter(([, v]) => v !== undefined),
            ) as Record<string, string>,
          }
        : {}),
      headers: { [MCP_CALL_TOKEN_HEADER]: mintMcpCallToken(principal) },
    });
    let json: unknown;
    try {
      json = injected.json();
    } catch {
      json = undefined;
    }
    return { statusCode: injected.statusCode, json };
  };

  fastify.post('/mcp', async (request, reply) => {
    const bearer = bearerOf(request.headers['authorization']);
    if (!bearer) {
      return reply.code(401).send({ error: 'MCP requires a Cloudflare Access bearer token' });
    }

    let principal: { userId: string };
    try {
      const verified = await verifier.verify(bearer);
      if (!verified) return reply.code(401).send({ error: 'Unverified Access token' });
      principal = verified;
    } catch (err) {
      if ((err as Error)?.name === 'McpAccessNotConfiguredError') {
        return reply.code(503).send({ error: (err as Error).message });
      }
      throw err;
    }

    // Per person, from the VERIFIED principal — never per IP (MCP-PLAN §4). Fails closed:
    // `consumeRateLimit` fails open only when the cache is disabled (dev), like the REST tiers.
    const { allowed, resetAt } = await cache.consumeRateLimit(
      `mcp:uid:${principal.userId}`,
      MCP_RATE_LIMIT.limit,
      MCP_RATE_LIMIT.windowSeconds,
    );
    if (!allowed) {
      throw new RateLimitedException(
        `Rate limit exceeded (MCP). Retry after ${Math.max(resetAt - Math.floor(Date.now() / 1000), 1)}s.`,
      );
    }

    // Stateless: one McpServer + transport per request, no session id ever issued. The sessionId
    // that names this request in audit rows is Fastify's request id, not an MCP session.
    const server = new McpServer(
      { name: 'rova', version: deps.serverVersion },
      { instructions: 'Rova — read-only tools. Every result is what the person themselves sees.' },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    registerRovaTools(server, {
      userId: principal.userId,
      sessionId: `mcp:${request.id}`,
      callRest,
    });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw, request.body);
    return reply;
  });

  // GET (server-initiated SSE stream) and DELETE (session termination) exist only in stateful
  // mode; stateless answers 405, as the Streamable HTTP transport does for them itself.
  for (const method of ['GET', 'DELETE'] as const) {
    fastify.route({
      method,
      url: '/mcp',
      handler: (_req, reply) => {
        reply.code(405).header('Allow', 'POST').send({
          error: 'The rova MCP endpoint is stateless: only POST is supported',
        });
      },
    });
  }
}

function bearerOf(authorization: string | string[] | undefined): string | undefined {
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  if (typeof value !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1];
}
