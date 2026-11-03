import { createHash } from 'node:crypto';
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
 * One in-process REST call a tool composes. NO headers, ever — see the ratchet. A write carries
 * a `body`, and an idempotent create carries the key {@link idempotencyKeyFor} builds; `route.ts`
 * turns that key into the one header the bridge may add.
 */
export interface McpRestCall {
  method: McpRestMethod;
  url: string;
  query?: Record<string, string | number | undefined>;
  /** The JSON body of a write. Never sent on GET. */
  body?: Record<string, unknown> | unknown[];
  /** Only for an idempotent POST create; see idempotencyKeyFor. */
  idempotencyKey?: string;
}

export interface McpRestResult {
  statusCode: number;
  json: unknown;
}

/** Runs one call through `app.inject()` with the tool request's principal (built in route.ts). */
export type McpRestCaller = (
  principal: McpPrincipalContext,
  call: McpRestCall,
) => Promise<McpRestResult>;

/** What register.ts hands every tool: the request's ONE principal and the caller. */
export interface ToolContext {
  principal: McpPrincipalContext;
  callRest: McpRestCaller;
}

/** A write is one of the four mutating methods; the guard and the ratchets share this predicate. */
export function isWriteMethod(method: string): method is McpWriteMethod {
  return method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';
}

/** Object keys sorted at every depth, so the same arguments always hash the same. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] !== undefined) sorted[key] = canonical(source[key]);
  }
  return sorted;
}

/** The idempotency window: a retry of the same call inside one bucket replays the first result. */
export const MCP_IDEMPOTENCY_BUCKET_MS = 10 * 60 * 1000;

/**
 * The `Idempotency-Key` an MCP create sends: sha256 of principal + tool + canonical arguments +
 * the current 10-minute bucket. The model never supplies it, so an LLM retry of the SAME call
 * replays the first response instead of creating a duplicate; a deliberate second create (a
 * minute later in a new bucket, or with different arguments) gets a fresh key.
 */
export function idempotencyKeyFor(
  principalId: string,
  tool: string,
  args: unknown,
  nowMs: number = Date.now(),
): string {
  const bucket = Math.floor(nowMs / MCP_IDEMPOTENCY_BUCKET_MS);
  return createHash('sha256')
    .update(JSON.stringify({ principalId, tool, bucket, args: canonical(args) }))
    .digest('hex');
}

/** Tools cap the page below the REST max: an agent re-asks with a cursor rather than reading 100 rows. */
export const MCP_TOOL_PAGE_LIMIT = 20;

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
