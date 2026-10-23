import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { result, type ToolContext } from './rest';

/** The REST comments route is unpaginated, so the tool caps the feed itself. */
const MAX_COMMENTS = 100;
const MAX_BODY_CHARS = 4_000;

/**
 * `list_comments` — the comments on one work item (GET /v1/work-items/:workItemId/comments,
 * `work_item:view` on the item). The REST route returns ALL of an item's comments (no page
 * args yet), so the tool caps to the newest 100, truncates bodies, and says so.
 */
export function registerListComments(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'list_comments',
    {
      title: 'List comments',
      description: 'The comments on one work item you can read (newest first, capped at 100).',
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
      const all = (json as Record<string, unknown>[]) ?? [];
      const capped = all.slice(0, MAX_COMMENTS);
      let truncated = all.length > MAX_COMMENTS;
      return result(statusCode, json, {
        comments: capped.map((c) => {
          const body = c['body'];
          if (typeof body === 'string' && body.length > MAX_BODY_CHARS) {
            truncated = true;
            c['body'] = `${body.slice(0, MAX_BODY_CHARS)}…`;
          }
          return {
            id: c['id'],
            authorId: c['authorId'],
            body: c['body'],
            isEdited: c['isEdited'],
            createdAt: c['createdAt'],
          };
        }),
        truncated,
      });
    },
  );
}
