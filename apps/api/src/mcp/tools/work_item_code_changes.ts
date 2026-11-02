import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, type ToolContext } from './rest';

/** Both routes page at the REST max; anything past the caps is flagged, not fetched. */
export const MAX_CONNECTIONS = 50;
export const MAX_CHANGESETS = 100;

/** The two feeds, field-mapped; `truncated` when the route's own pageInfo says more exist. */
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
  // the route pages at exactly the caps, so only ITS hasNextPage can say more exist
  if (connectionsMore || changesetsMore) payload['truncated'] = true;
  return payload;
}

/** One page from a paged route: the rows plus whether the route says more exist. */
async function page(
  ctx: ToolContext,
  url: string,
  limit: number,
): Promise<{
  denial?: ReturnType<typeof denied>;
  rows: Record<string, unknown>[];
  hasMore: boolean;
}> {
  const res = await ctx.callRest(ctx.principal, {
    method: 'GET',
    url,
    query: { limit },
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
 * `rova_work_item_code_changes` — the SCM links (pull requests) and changesets of one work
 * item (GET /v1/work-items/:id/connections and /changesets, both `work_item:view` resolved
 * from the item, both cursor-paged). Each feed is fetched up to its cap (50 / 100) and
 * `truncated` comes from the route's own pageInfo — the tool fetches only what it returns.
 */
export function registerWorkItemCodeChanges(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_work_item_code_changes',
    {
      title: 'Work item code changes',
      description: 'The linked pull requests and code changesets of one work item you can read.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        workItemId: z.uuid().describe('The work item whose code changes to list'),
      },
    },
    async ({ workItemId }) => {
      const connections = await page(
        ctx,
        `/v1/work-items/${workItemId}/connections`,
        MAX_CONNECTIONS,
      );
      if (connections.denial) return connections.denial;
      const changesets = await page(ctx, `/v1/work-items/${workItemId}/changesets`, MAX_CHANGESETS);
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
