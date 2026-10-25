import { z } from 'zod';
import type { McpPrincipalContext } from '@platform';

/**
 * The plumbing shared by every MCP tool (ROVA-MCP-DESIGN §2/§7): tools reach rova ONLY through
 * in-process REST (`inject()` with the person as principal) — the HTTP layer is the authorization
 * point. One file per tool beside this one; `registry.ts` names every tool's REST route for the
 * ratchet; `register.ts` mounts them all.
 */

/** One in-process REST call a tool composes. No headers, ever — see the ratchet. */
export interface McpRestCall {
  method: 'GET';
  url: string;
  query?: Record<string, string | number | undefined>;
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

/** Fields a paged REST response may carry; `pageInfo` is passed through untouched. */
export function pageInfoOf(json: unknown): Record<string, unknown> {
  const page = json as { pageInfo?: unknown };
  return page.pageInfo === undefined ? {} : { pageInfo: page.pageInfo };
}
