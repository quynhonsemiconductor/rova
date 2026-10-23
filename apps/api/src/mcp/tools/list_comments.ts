import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { result, type ToolContext } from './rest';

/**
 * `list_comments` — the comments on one work item (GET /v1/work-items/:workItemId/comments,
 * `work_item:view` on the item). The REST route returns ALL of an item's comments (no page
 * args yet); the tool trims the response instead — id, author, body, time.
 */
export function registerListComments(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'list_comments',
    {
      title: 'List comments',
      description: 'The comments on one work item you can read.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        workItemId: z.uuid().describe('The work item whose comments to list'),
      },
    },
    async ({ workItemId }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: `/v1/work-items/${workItemId}/comments`,
      });
      const comments = (json as Record<string, unknown>[]) ?? [];
      return result(statusCode, json, {
        comments: comments.map((c) => ({
          id: c['id'],
          authorId: c['authorId'],
          body: c['body'],
          isEdited: c['isEdited'],
          createdAt: c['createdAt'],
        })),
      });
    },
  );
}
