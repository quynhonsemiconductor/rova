import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { McpPrincipalContext } from '@platform';

/**
 * The plumbing shared by every MCP tool (ROVA-MCP-DESIGN §2/§7): tools reach rova ONLY through
 * in-process REST (`inject()` with the person as principal) — the HTTP layer is the authorization
 * point. One file per tool beside this one; `registry.ts` names every tool's REST route for the
 * ratchet; `register.ts` mounts them all.
 */

export type McpReadMethod = 'GET';
/** Every method a write tool may use. The REST-side allowlist decides which routes are reachable. */
export type McpWriteMethod = 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export type McpRestMethod = McpReadMethod | McpWriteMethod;

/**
 * One in-process REST call a tool composes. A tool NEVER builds a header — see the ratchet — it
 * names the one CONTRACT value the bridge is allowed to carry: `idempotencyKey` (a POST create)
 * or `ifMatch` (the optimistic-concurrency token on a PATCH). `route.ts` turns each into the
 * single header it owns.
 */
export interface McpRestCall {
  method: McpRestMethod;
  url: string;
  query?: Record<string, string | number | undefined>;
  /** The JSON body of a write. Never sent on GET. */
  body?: Record<string, unknown> | unknown[];
  /** Only for an idempotent POST create; see idempotencyKeyFor. */
  idempotencyKey?: string;
  /**
   * The `If-Match` value a PATCH sends: the ETag `"<version>"` read from a work-item response
   * (see {@link responseEtag}). Only a PATCH may carry it; the REST route compares it in the
   * UPDATE and answers 412 WORK_ITEM_STALE on a mismatch.
   */
  ifMatch?: string;
}

export interface McpRestResult {
  statusCode: number;
  json: unknown;
  /**
   * Response headers the REST layer returned. Tools read the ones that are the CONTRACT of a
   * route — `etag` (the work-item concurrency token) — and ignore the rest; the MCP response
   * never reflects them.
   */
  headers?: Record<string, string | string[] | number | undefined>;
}

/** Runs one call through `app.inject()` with the tool request's principal (built in route.ts). */
export type McpRestCaller = (
  principal: McpPrincipalContext,
  call: McpRestCall,
) => Promise<McpRestResult>;

/**
 * What a WRITE tool may report about its write for the audit line (design §6.7): ids/keys/field
 * NAMES only. `route.ts` sanitises it again before logging; a tool that passes a value or free
 * text loses it there. `reasonLength` is the one derived number a delete adds — the text itself
 * stays out of telemetry.
 */
export interface WriteAudit {
  targets?: string[];
  fields?: string[];
  count?: number;
  dryRun?: boolean;
  /** Length of the caller's stated reason; the reason text is never logged. */
  reasonLength?: number;
}

/** What register.ts hands every tool: the request's ONE principal and the caller. */
export interface ToolContext {
  principal: McpPrincipalContext;
  callRest: McpRestCaller;
  /** Tags the request's audit line with what the write touched; present whenever writes mount. */
  noteWrite?: (meta: WriteAudit) => void;
  /**
   * Builds the `Idempotency-Key` for one idempotent create, bound by route.ts to the principal
   * and the server's `MCP_IDEMPOTENCY_SECRET` (never exposed to a tool). Present whenever writes
   * are enabled; a write tool must refuse to create without it rather than send no key.
   */
  idempotencyKey?: (tool: string, args: unknown) => string;
  /**
   * The same builder with NO time bucket, for a create the caller keyed with its own `requestId`
   * ({@link clientIdempotencyKeyFor}; design §11 amendment). Also present whenever writes are
   * enabled; a tool sends the key ONLY when the model supplied a `requestId`.
   */
  clientIdempotencyKey?: (tool: string, args: unknown) => string;
}

/** A write is one of the four mutating methods; the guard and the ratchets share this predicate. */
export function isWriteMethod(method: string): method is McpWriteMethod {
  return method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';
}

/**
 * The one way a tool may put a value into a PATH: percent-encode it. Query values go through the
 * inject `query` object (never string-built), and a body is JSON, so this is the only place an
 * argument touches a URL. `/`, `?`, `#` and `%` become inert, dots are encoded too, and an empty
 * or dot-only segment (`.` / `..`) is refused outright — `encodeURIComponent` leaves those as
 * path traversal, which is exactly what must not reach the router.
 */
export function pathSegment(value: string): string {
  if (value === '' || value === '.' || value === '..') {
    throw new Error('MCP bridge: an empty or dot-only path segment is refused');
  }
  return encodeURIComponent(value).replace(/\./g, '%2E');
}

/**
 * Refuses, at RUNTIME, a read that carries write payload: only the TS types say a GET has no
 * body, no idempotency key and no If-Match, and a tool is free to build its `McpRestCall`
 * however it likes. Callers (route.ts) convert the throw into the tool's error result.
 */
export function assertReadCarriesNoWritePayload(call: McpRestCall): void {
  if (isWriteMethod(call.method)) return;
  if (call.body !== undefined || call.idempotencyKey !== undefined || call.ifMatch !== undefined) {
    throw new Error(
      `MCP bridge: ${call.method} ${call.url} carries a body, an Idempotency-Key or an If-Match`,
    );
  }
}

/**
 * Refuses an If-Match on anything but a PATCH: the concurrency contract exists on
 * `PATCH /v1/work-items/:id` alone, and a value attached to another method would be a header the
 * route never reads — a silent no-op that looks like an optimistic write.
 */
export function assertIfMatchOnlyOnPatch(call: McpRestCall): void {
  if (call.ifMatch !== undefined && call.method !== 'PATCH') {
    throw new Error(`MCP bridge: ${call.method} ${call.url} carries an If-Match`);
  }
}

const CANONICAL_STRING = (value: string) => value.normalize('NFC');

/**
 * The canonical form hashed for idempotency: strings and object KEYS NFC-normalized (the same
 * text typed as composed or decomposed Unicode must hash the same), keys sorted at every depth,
 * `undefined` object fields dropped, objects with a NULL prototype (a JSON-parsed `__proto__` key
 * cannot then mutate anything). `undefined` inside an ARRAY is REFUSED: dropping it would
 * renumber a list (and [a, undefined, b] would collide with [a, b]).
 */
export function canonicalize(value: unknown): unknown {
  if (typeof value === 'string') return CANONICAL_STRING(value);
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item === undefined) {
        throw new TypeError('MCP idempotency: an undefined array element has no canonical form');
      }
      return canonicalize(item);
    });
  }
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const entries = Object.keys(source)
    .map((key) => [CANONICAL_STRING(key), source[key]] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [key, item] of entries) {
    if (item !== undefined) sorted[key] = canonicalize(item);
  }
  return sorted;
}

/** The idempotency window: a retry of the same call inside one bucket replays the first result. */
export const MCP_IDEMPOTENCY_BUCKET_MS = 10 * 60 * 1000;

/**
 * WHY HMAC and not a bare hash: the key is stored in Valkey and, on a dedup hit, the first
 * response is replayed. A plain sha256 of low-entropy arguments ({"body":"lgtm"}) is guessable,
 * so someone able to write that cache could pre-plant a response for a key the model would
 * later compute. Without the secret the key cannot be predicted.
 */
function signIdempotencyKey(secret: string, body: unknown): string {
  if (!secret) throw new Error('MCP idempotency: MCP_IDEMPOTENCY_SECRET is not set');
  return createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
}

/**
 * The `Idempotency-Key` an MCP create sends: HMAC-SHA256, keyed by the server-only
 * `MCP_IDEMPOTENCY_SECRET`, over {principal, tool, canonical arguments, 10-minute bucket}.
 *
 * The model never supplies the key, so an LLM retry of the SAME call replays the first response
 * instead of creating a duplicate. KNOWN, ACCEPTED: the bucket is wall-clock aligned, so the
 * same call made across a :59 -> :00 boundary produces two keys and can create twice; the
 * window is a duplicate-reduction measure, not a uniqueness guarantee.
 */
export function idempotencyKeyFor(
  secret: string,
  principalId: string,
  tool: string,
  args: unknown,
  nowMs: number = Date.now(),
): string {
  const bucket = Math.floor(nowMs / MCP_IDEMPOTENCY_BUCKET_MS);
  return signIdempotencyKey(secret, { principalId, tool, bucket, args: canonicalize(args) });
}

/**
 * The `Idempotency-Key` an MCP create sends for a CLIENT-SUPPLIED request id (design §11
 * amendment, revised 2026-11-04 after review): the same HMAC over {principal, tool, canonical
 * arguments} and **no wall-clock bucket**.
 *
 * WHY a client id and NOT a hash of the content: content is not an identity. Two test cases with
 * the same name under one story, or two identical runs of one test case against one build, are
 * both legitimate — a content hash would answer the second with the first one's row for the
 * cache's whole 24-hour TTL, and a wall-clock bucket only makes the collision harder to predict.
 * The CALLER therefore decides when two calls are "the same request": generate an id once per
 * user request and send the SAME value on a retry. A tool with no `requestId` sends NO key, and
 * its description says a retry may then duplicate the row.
 *
 * The interceptor's `IDEMPOTENCY_KEY_REUSED` (same key, different body) remains the guard: a
 * reused id with a different body is a client error, never a silent replay.
 */
export function clientIdempotencyKeyFor(
  secret: string,
  principalId: string,
  tool: string,
  args: unknown,
): string {
  return signIdempotencyKey(secret, { principalId, tool, args: canonicalize(args) });
}

/** Tools cap the page below the REST max: an agent re-asks with a cursor rather than reading 100 rows. */
export const MCP_TOOL_PAGE_LIMIT = 20;

/**
 * A real calendar date (`YYYY-MM-DD`) in 2000–2100 — the same rule the REST date schemas state.
 * The shape alone is not enough: `2026-02-30` matches the regex and `new Date` would roll it into
 * March, so the components are read back and compared.
 */
export function isRealCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 2000 || year > 2100) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** Shared list-tool page args: `limit` + `cursor`, mirroring the REST `PageQuerySchema`. */
export const pageArgs = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(MCP_TOOL_PAGE_LIMIT)
    .optional()
    .describe(`Page size (default ${MCP_TOOL_PAGE_LIMIT})`),
  cursor: z.string().optional().describe('Opaque cursor from the previous page'),
};

/**
 * The strong ETag a REST response carried (`"<n>"`), read from the result's headers. Lives here
 * — and nowhere else in this package — because the tool-file ratchet bans a tool from touching
 * headers; this is the ONE sanctioned read (a RESPONSE header, never a request one).
 */
export function responseEtag(result: McpRestResult): string | undefined {
  // HTTP header names are case-insensitive, and the controllers set `ETag` (capitalised); the
  // lookup must not depend on which spelling a runtime preserves.
  const headers = result.headers ?? {};
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'etag');
  const raw = key ? headers[key] : undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : undefined;
}

/**
 * True when the REST layer answered from the idempotency cache instead of running the handler:
 * the marker `@UseIdempotency` sets on a replay (`idempotency-replayed: true`). A write tool
 * relays it so the model can tell "created" from "this is the row your earlier identical call
 * created". Read here, and only here, for the same reason as the ETag.
 */
export function replayedFrom(result: McpRestResult): boolean {
  const headers = result.headers ?? {};
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'idempotency-replayed');
  const raw = key ? headers[key] : undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === 'true';
}

/**
 * The integer version inside the strong ETag a work-item response carries (`"<version>"`).
 * `undefined` when the header is missing or not the contract's strong form — a write tool must
 * not send an If-Match it could not derive.
 */
export function versionFromEtag(result: McpRestResult): number | undefined {
  const etag = responseEtag(result);
  const match = etag ? /^"(0|[1-9][0-9]*)"$/.exec(etag) : null;
  return match ? Number(match[1]) : undefined;
}

/** A tool-level refusal (an unresolvable reference, an ambiguous name): an MCP error result. */
export function toolError(message: string) {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
  };
}

/** Passes a REST denial through unchanged: the same status and body the person's REST call gets. */
export function denied(statusCode: number, json: unknown) {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: JSON.stringify({ statusCode, error: json }) }],
  };
}

/** Wraps a tool result: denial pass-through, else a small JSON payload. */
export function result(statusCode: number, json: unknown, payload: unknown) {
  if (statusCode >= 400) return denied(statusCode, json);
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

/**
 * Wraps a LIST tool result. The denial check happens BEFORE any shaping: on a 403/404 the REST
 * body is a Nest error OBJECT, and mapping it as an array would throw `x.map is not a function`
 * straight to the client. A non-array success body (contract drift) is relayed, not shaped.
 */
export function listResult(
  statusCode: number,
  json: unknown,
  mapItem: (item: Record<string, unknown>) => Record<string, unknown>,
  listKey: string,
) {
  if (statusCode >= 400) return denied(statusCode, json);
  // Paged routes wrap rows in { data, pageInfo }; bare-array routes (my_work, comments,
  // reference feeds) return the rows directly. Anything else is contract drift — relayed.
  const rows = Array.isArray(json) ? json : (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) return denied(statusCode, json);
  const pageInfo =
    Array.isArray(json) || (json as { pageInfo?: unknown }).pageInfo === undefined
      ? {}
      : { pageInfo: (json as { pageInfo: unknown }).pageInfo };
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ [listKey]: rows.map(mapItem), ...pageInfo }),
      },
    ],
  };
}

/**
 * The async twin of {@link listResult}, for a list whose rows carry ids resolved through a
 * reference feed before they are relayed (refs.ts). The denial check still happens FIRST, so a
 * 403 never reaches the mapper.
 */
export async function listResultExpanded(
  statusCode: number,
  json: unknown,
  mapItem: (item: Record<string, unknown>) => Promise<Record<string, unknown>>,
  listKey: string,
) {
  if (statusCode >= 400) return denied(statusCode, json);
  const rows = Array.isArray(json) ? json : (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) return denied(statusCode, json);
  const pageInfo =
    Array.isArray(json) || (json as { pageInfo?: unknown }).pageInfo === undefined
      ? {}
      : { pageInfo: (json as { pageInfo: unknown }).pageInfo };
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          [listKey]: await Promise.all((rows as Record<string, unknown>[]).map(mapItem)),
          ...pageInfo,
        }),
      },
    ],
  };
}

/** What one finished tool call reports to the audit sink (see ../audit.ts). */
export interface ToolCallObservation {
  tool: string;
  principalId: string;
  durationMs: number;
  outcome: 'ok' | 'error';
}

export type ToolCallObserver = (observation: ToolCallObservation) => void;

/**
 * Times one tool handler and reports it, whatever it returns or throws. `isError` results are
 * reported as an error outcome: MCP marks a REST denial that way, and the error count should
 * track refusals as well as failures.
 *
 * Lives here, not in ../audit.ts, because the tool-file ratchet only lets files in this
 * directory import `./sibling` modules; the audit sink itself is built in route.ts.
 */
export function instrumentToolHandler<Args extends unknown[], Result>(
  tool: string,
  principalId: string,
  handler: (...args: Args) => Promise<Result>,
  observe: ToolCallObserver,
): (...args: Args) => Promise<Result> {
  return async (...args: Args) => {
    const startedAt = Date.now();
    let outcome: ToolCallObservation['outcome'] = 'ok';
    try {
      const result = await handler(...args);
      if (result !== null && typeof result === 'object' && 'isError' in result) {
        if ((result as { isError?: unknown }).isError === true) outcome = 'error';
      }
      return result;
    } catch (error) {
      outcome = 'error';
      throw error;
    } finally {
      observe({ tool, principalId, durationMs: Date.now() - startedAt, outcome });
    }
  };
}

/** Fields a paged REST response may carry; `pageInfo` is passed through untouched. */
export function pageInfoOf(json: unknown): Record<string, unknown> {
  const page = json as { pageInfo?: unknown };
  return page.pageInfo === undefined ? {} : { pageInfo: page.pageInfo };
}
