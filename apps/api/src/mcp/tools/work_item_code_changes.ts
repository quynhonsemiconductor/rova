import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, type ToolContext } from './rest';

/** Both routes page at the REST max; anything past the caps is flagged, not fetched. */
export const MAX_CONNECTIONS = 50;
export const MAX_CHANGESETS = 100;
const REST_PAGE_LIMIT = 100;

/** The two feeds, capped and field-mapped; `truncated` when a cap or the route's page bit. */
export function shapeCodeChanges(
  connections: Record<string, unknown>[],
  connectionsMore: boolean,
  changesets: Record<string, unknown>[],
  changesetsMore: boolean,
) {
  const payload: Record<string, unknown> = {
    connections: connections.slice(0, MAX_CONNECTIONS).map((c) => ({
      id: c['id'],
      provider: c['provider'],
      type: c['type'],
      name: c['name'],
      url: c['url'],
      state: c['state'],
      authorName: c['authorName'],
    })),
    changesets: changesets.slice(0, MAX_CHANGESETS).map((c) => ({
      id: c['id'],
      provider: c['provider'],
      revision: c['revision'],
      name: c['name'],
      message: c['message'],
      uri: c['uri'],
      authorName: c['authorName'],
      committedAt: c['committedAt'] ?? null,
    })),
  };
  if (
    connectionsMore ||
    connections.length > MAX_CONNECTIONS ||
    changesetsMore ||
    changesets.length > MAX_CHANGESETS
  )
    payload['truncated'] = true;
  return payload;
}

/** One page from a paged route: the rows plus whether the route says more exist. */
async function page(
  ctx: ToolContext,
  url: string,
): Promise<{
  denial?: ReturnType<typeof denied>;
  rows: Record<string, unknown>[];
  hasMore: boolean;
}> {
  const res = await ctx.callRest(ctx.principal, {
    method: 'GET',
    url,
    query: { limit: REST_PAGE_LIMIT },
  });
  if (
    res.statusCode >= 400 ||
    res.json === null ||
    typeof res.json !== 'object' ||
    Array.isArray(res.json)
  )
    return { denial: denied(res.statusCode, res.json), rows: [], hasMore: false };
  const body = res.json as { data?: unknown; pageInfo?: { hasNextPage?: boolean } };
  if (!Array.isArray(body.data))
    return { denial: denied(res.statusCode, res.json), rows: [], hasMore: false };
  return {
    rows: body.data as Record<string, unknown>[],
    hasMore: body.pageInfo?.hasNextPage === true,
  };
}

/**
 * `work_item_code_changes` — the SCM links (pull requests) and changesets of one work item
 * (GET /v1/work-items/:id/connections and /changesets, both `work_item:view` resolved from
 * the item, both cursor-paged). Connections are capped at 50, changesets at 100 — past the cap
 * the payload carries `truncated` instead of more rows (an agent re-asks through REST, not by
 * paging an unbounded feed).
 */
export function registerWorkItemCodeChanges(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'work_item_code_changes',
    {
      title: 'Work item code changes',
      description: 'The linked pull requests and code changesets of one work item you can read.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        workItemId: z.uuid().describe('The work item whose code changes to list'),
      },
    },
    async ({ workItemId }) => {
      const connections = await page(ctx, `/v1/work-items/${workItemId}/connections`);
      if (connections.denial) return connections.denial;
      const changesets = await page(ctx, `/v1/work-items/${workItemId}/changesets`);
      if (changesets.denial) return changesets.denial;

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              shapeCodeChanges(
                connections.rows,
                connections.hasMore,
                changesets.rows,
                changesets.hasMore,
              ),
            ),
          },
        ],
      };
    },
  );
}
