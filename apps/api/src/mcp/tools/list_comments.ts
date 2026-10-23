import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pageInfoOf, pageArgs, result, type ToolContext } from './rest';

/**
 * `list_comments` — the comments on one work item (GET /v1/work-items/:workItemId/comments,
 * `work_item:view` on the item). Newest-page via the REST route's own cursor.
 */
export function registerListComments(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_comments',
    {
      title: 'List comments',
      description: 'The comments on one work item you can read. Paginated.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        workItemId: z.uuid().describe('The work item whose comments to list'),
        ...pageArgs,
      },
    },
    async ({ workItemId, limit, cursor }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: `/v1/work-items/${workItemId}/comments`,
        query: { ...(limit ? { limit } : {}), cursor },
      });
      const page = json as { data?: Record<string, unknown>[] };
      return result(statusCode, json, {
        comments: (page.data ?? []).map((c) => ({
          id: c['id'],
          authorId: c['authorId'],
          body: c['body'],
          isEdited: c['isEdited'],
          createdAt: c['createdAt'],
        })),
        ...pageInfoOf(json),
      });
    },
  );
}
