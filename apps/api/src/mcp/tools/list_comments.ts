import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, type ToolContext } from './rest';

/** The REST comments route is unpaginated, so the tool caps the feed itself. */
const MAX_COMMENTS = 100;
const MAX_BODY_CHARS = 4_000;

/**
 * Sorts newest-first, caps to 100, truncates long bodies (flagging it), and maps the
 * CommentResponseDto fields an agent acts on.
 */
export function shapeComments(all: Record<string, unknown>[]) {
  const sorted = [...all].sort((a, b) =>
    String(b['createdAt']).localeCompare(String(a['createdAt'])),
  );
  const capped = sorted.slice(0, MAX_COMMENTS);
  let truncated = sorted.length > MAX_COMMENTS;
  const comments = capped.map((c) => {
    const body = c['body'];
    if (typeof body === 'string' && body.length > MAX_BODY_CHARS) {
      truncated = true;
      c['body'] = `${body.slice(0, MAX_BODY_CHARS)}…`;
    }
    return {
      id: c['id'],
      authorId: c['authorId'],
      parentId: c['parentId'] ?? null,
      body: c['body'],
      isEdited: c['isEdited'],
      editedAt: c['editedAt'] ?? null,
      createdAt: c['createdAt'],
    };
  });
  return { truncated, comments };
}

/**
 * `rova_list_comments` — the comments on one work item (GET /v1/work-items/:workItemId/comments,
 * `work_item:view` on the item). The REST route returns ALL of an item's comments (no page
 * args, no ordering guarantee), so the tool sorts newest-first, caps to 100, truncates
 * bodies, and sets `truncated`.
 */
export function registerListComments(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_list_comments',
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
      if (statusCode >= 400 || !Array.isArray(json)) return denied(statusCode, json);
      const { truncated, comments } = shapeComments(json as Record<string, unknown>[]);
      const payload: Record<string, unknown> = { comments };
      if (truncated) payload['truncated'] = true;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
      };
    },
  );
}
