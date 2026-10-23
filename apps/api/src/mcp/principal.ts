import { randomBytes } from 'node:crypto';

/**
 * The in-process principal an MCP tool runs its REST calls as.
 *
 * `userId` is the identity user id the Cloudflare Access JWT mapped to; `workspaceId` is the
 * workspace the TOOL CALL named (never a hard-coded id — the same guard/service path resolves
 * scope as the session path does); `sessionId` names the credential in audit rows — the /mcp
 * request id, since MCP is stateless and there is no session.
 *
 * WHY NOT AsyncLocalStorage (MCP-PLAN §4 expected one): Fastify deliberately gives every request
 * a FRESH async context — its content-type parser wraps the request in a new `AsyncResource`
 * (`fastify/lib/content-type-parser.js:206`, verified empirically: an ALS store set around
 * `inject()` is `undefined` inside the injected request's hooks and guards, plain Fastify and
 * Nest alike). ALS cannot span an `inject()` boundary, here or in production.
 *
 * The bridge is instead a SINGLE-USE, in-process call token:
 *
 *  - `mintMcpCallToken` (only mcp.route.ts, per tool call) stores the principal under a 256-bit
 *    random token, TTL seconds;
 *  - `callRest` carries ONLY the token — never the principal — in an inject() header;
 *  - `McpPrincipalGuard` `consume`s the token: one read deletes it, so it cannot be replayed,
 *    and a request that presents an unknown token simply has no MCP context (session path).
 *
 * Nothing network-visible ever carries the principal: a token exists only inside the process,
 * is shown to nobody, and dies on first use. A network request cannot forge or replay it, and
 * the ratchet keeps TOOL files free of any header reference — only the transport (mcp.route.ts)
 * mints and attaches the token.
 */

export interface McpPrincipalContext {
  userId: string;
  workspaceId: string;
  sessionId: string;
}

/** Header the in-process call token travels in (between mcp.route.ts and the guard, never stored). */
export const MCP_CALL_TOKEN_HEADER = 'x-rova-mcp-call';

/** A token outlives its one inject() by seconds, not minutes. */
const TOKEN_TTL_MS = 5_000;

/** Bound on pending tokens: far above anything one person can pipeline, swept when exceeded. */
const MAX_PENDING = 1_000;

const pending = new Map<string, { principal: McpPrincipalContext; expiresAt: number }>();

/** Mints a single-use token standing for `principal`. Called ONLY by the MCP transport. */
export function mintMcpCallToken(principal: McpPrincipalContext): string {
  if (pending.size >= MAX_PENDING) {
    const now = Date.now();
    for (const [key, entry] of pending) {
      if (entry.expiresAt <= now) pending.delete(key);
    }
  }
  const token = randomBytes(32).toString('base64url');
  pending.set(token, { principal, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

/**
 * Exchanges a token for its principal, ONCE: the token is deleted on this read, whether or not
 * the exchange succeeds. `undefined` means no (or an already-used, unknown or expired) token —
 * the request carries no MCP context and falls through to the session path.
 */
export function consumeMcpCallToken(token: string | undefined): McpPrincipalContext | undefined {
  if (!token) return undefined;
  const entry = pending.get(token);
  pending.delete(token);
  if (!entry || entry.expiresAt <= Date.now()) return undefined;
  return entry.principal;
}
