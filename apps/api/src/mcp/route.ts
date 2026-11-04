import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CacheService } from '@quynhonsemiconductor/platform-cache';
import { RateLimitedException } from '@platform';
import type { McpAccessPrincipal, McpAccessVerifier } from './access-verifier';
import { mintMcpCallToken, MCP_CALL_TOKEN_HEADER, type McpPrincipalContext } from '@platform';
import { registerTools } from './tools/register';
import {
  assertPostCarriesIdempotencyKey,
  assertReadCarriesNoWritePayload,
  idempotencyKeyFor,
  type McpRestCaller,
  type ToolContext,
} from './tools/rest';
import { createMcpAudit } from './audit';

/**
 * The `/mcp` route: stateless MCP transport — one request, one server, no session.
 *
 * Registered as a RAW Fastify route — outside `/v1`, the session guards, the CSRF gate and the
 * OpenAPI document — because its authentication is the Cloudflare Access identity, not a cookie,
 * and because the edge scopes the Access application to exactly this path (MCP-PLAN §5; §12
 * covers the discovery paths and the edge rate-limit row). MCP_ENABLED=false (the default
 * everywhere) registers nothing at all.
 *
 * With Access Managed OAuth the client's `Authorization` bearer is an OPAQUE Access OAuth token:
 * Access validates it at the edge and forwards the identity to the origin as the Access JWT in
 * the `Cf-Access-Jwt-Assertion` header, which is what this route verifies. A bearer is read only
 * when it is itself a JWT (direct clients and the existing tests); an opaque bearer alone is
 * never accepted.
 *
 * Per POST, in order:
 *  1. verify the Access JWT from `Cf-Access-Jwt-Assertion` (or a JWT-shaped bearer) via the
 *     {@link McpAccessVerifier} (the app-platform `identity/access-jwt` adapter; the
 *     unconfigured stub answers 503);
 *  2. resolve the principal ONCE — oid → rova user + bound workspace, by the adapter — and hold
 *     it as the one {@link McpPrincipalContext} for every tool call of this request;
 *  3. rate-limit PER PERSON from that principal (never per IP: `inject()` traffic arrives from
 *     loopback, where IP carries no security meaning — MCP-PLAN §4);
 *  4. build one stateless `McpServer` + transport (`sessionIdGenerator: undefined`, JSON
 *     responses; SDK pinned at the verified version) with the read-only tools.
 *
 * Each tool call mints a SINGLE-USE in-process call token for the same principal and carries
 * only that token on the `inject()` (AsyncLocalStorage cannot span an `inject()` — Fastify gives
 * every request a fresh async context by design; see principal.ts). `McpPrincipalGuard` consumes
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
  /**
   * Whether the WRITE catalogue mounts (MCP_WRITES_ENABLED). Absent reads as false, so every
   * existing caller and test stays read-only.
   */
  writesEnabled?: boolean;
  /**
   * HMAC key for the idempotency keys MCP creates send (MCP_IDEMPOTENCY_SECRET). Required when
   * writes are enabled (asserted at boot); never reaches a tool, only the key builder below.
   */
  idempotencySecret?: string;
}

export function registerMcpRoute(deps: McpRouteDeps): void {
  const { app, fastify, verifier, cache } = deps;
  const writesEnabled = deps.writesEnabled ?? false;
  // One audit sink per app: the instruments are process-wide and the logger is the shared pino
  // instance, so a per-request copy would only rebuild the same instruments.
  const audit = createMcpAudit();

  // Runs each tool's REST call with the request's ONE principal. The call token is minted here
  // (never in a tool) and is the only credential the inject() carries. A write's body and the
  // idempotency key (built by the tool through idempotencyKeyFor) travel with it; this is the
  // ONLY place a header is built, so no tool file can set one.
  const callRest: McpRestCaller = async (principal, rest) => {
    // The TS types already say a GET carries neither, but a tool can build its call object
    // freely; refuse at runtime rather than silently dropping the payload.
    assertReadCarriesNoWritePayload(rest);
    assertPostCarriesIdempotencyKey(rest);
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
      ...(rest.body !== undefined ? { payload: rest.body } : {}),
      headers: {
        [MCP_CALL_TOKEN_HEADER]: mintMcpCallToken(principal),
        ...(rest.idempotencyKey !== undefined ? { 'idempotency-key': rest.idempotencyKey } : {}),
      },
    });
    let json: Record<string, unknown> | unknown[] | undefined;
    try {
      json = injected.json();
    } catch {
      json = undefined;
    }
    return { statusCode: injected.statusCode, json, headers: injected.headers };
  };

  fastify.post('/mcp', async (request, reply) => {
    const token = accessTokenOf(request.headers);
    if (!token) {
      return reply.code(401).send({ error: 'MCP requires a Cloudflare Access identity' });
    }

    // The principal is resolved ONCE, here: Access JWT → rova user + bound workspace. Nothing
    // downstream re-resolves it, and no tool argument can widen it.
    // Batching was removed in the 2025-06-18 protocol and the pinned SDK still ACCEPTS an array
    // body — one POST would be up to 100 tool calls while costing one rate-limit unit. One
    // message per POST, enforced here.
    if (Array.isArray(request.body)) {
      return reply.code(400).send({
        error: 'JSON-RPC batching is not supported: send one message per POST',
      });
    }

    let verified: McpAccessPrincipal;
    try {
      const result = await verifier.verify(token);
      if (!result) return reply.code(401).send({ error: 'Unverified Access token' });
      verified = result;
    } catch (err) {
      // The adapter refuses an unknown or offboarded employee: one uniform 403, already logged
      // inside the adapter with the Access `sub`, never distinguishing unknown from offboarded.
      if ((err as Error)?.name === 'McpAccessDeniedError') {
        return reply.code(403).send({ error: 'Forbidden' });
      }
      // Everything else a verifier can raise is infra, not the caller: an unconfigured adapter, a
      // JWKS fetch that failed. One uniform 503; never a 500, never a distinguishing 401.
      if ((err as Error)?.name === 'McpAccessNotConfiguredError') {
        return reply.code(503).send({ error: (err as Error).message });
      }
      return reply.code(503).send({ error: 'MCP access verifier unavailable' });
    }
    const principal: McpPrincipalContext = {
      userId: verified.userId,
      workspaceId: verified.workspaceId,
      // The /mcp request id names this exchange in audit rows: MCP is stateless, no session.
      sessionId: `mcp:${request.id}`,
    };

    // Per person, from the VERIFIED principal — never per IP (MCP-PLAN §4).
    const { allowed, resetAt } = await cache.consumeRateLimit(
      `mcp:uid:${principal.userId}`,
      MCP_RATE_LIMIT.limit,
      MCP_RATE_LIMIT.windowSeconds,
    );
    if (!allowed) {
      audit.onRateLimited(principal.userId, MCP_RATE_LIMIT.limit, MCP_RATE_LIMIT.windowSeconds);
      throw new RateLimitedException(
        `Rate limit exceeded (MCP). Retry after ${Math.max(resetAt - Math.floor(Date.now() / 1000), 1)}s.`,
      );
    }

    // Stateless: one McpServer + transport per request, no session id ever issued.
    const server = new McpServer(
      { name: 'rova', version: deps.serverVersion },
      {
        instructions: writesEnabled
          ? 'Rova. Writes act as you, with your permissions; confirm destructive or bulk changes with the user first. Every result is what the person themselves sees.'
          : 'Rova — read-only tools. Every result is what the person themselves sees.',
      },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    // The tool context: one principal, the REST bridge, and — only when writes are enabled and
    // the secret is configured — a key builder bound to THIS request's principal. The secret
    // itself never reaches a tool.
    const secret = deps.idempotencySecret;
    const toolCtx: ToolContext = {
      principal,
      callRest,
      ...(writesEnabled && secret
        ? {
            idempotencyKey: (tool: string, args: unknown) =>
              idempotencyKeyFor(secret, principal.userId, tool, args),
          }
        : {}),
    };
    registerTools(server, toolCtx, (event) => audit.onToolCall(event), {
      writes: writesEnabled,
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

/**
 * The token the verifier checks. Cloudflare Access forwards the user identity to the origin as
 * the Access JWT in `Cf-Access-Jwt-Assertion` (under Managed OAuth the client's own bearer is an
 * opaque Access OAuth token the edge consumes, not a JWT this origin can verify). PRESENCE is
 * final: Cloudflare only forwards this header for a request Access authenticated, so a forged,
 * repeated (an array: no canonical order) or blank header fails closed and never falls back to
 * the bearer. Direct clients that send the Access JWT itself as a bearer keep working, but only
 * when that value is JWT-shaped (three base64url segments); an opaque bearer alone is never
 * accepted.
 */
export function accessTokenOf(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const assertion = headers['cf-access-jwt-assertion'];
  if (assertion !== undefined) {
    if (typeof assertion !== 'string') return undefined;
    const value = assertion.trim();
    return value === '' ? undefined : value;
  }
  const bearer = bearerOf(headers['authorization']);
  return bearer && isJwtShaped(bearer) ? bearer : undefined;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first.trim() !== '' ? first.trim() : undefined;
}

function isJwtShaped(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

function bearerOf(authorization: string | string[] | undefined): string | undefined {
  const value = firstHeader(authorization);
  if (!value) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1];
}
