import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listResult, pageArgs, type ToolContext } from './rest';

/** The NotificationResponseDto fields an agent acts on (metadata left to REST). */
export function shapeNotification(n: Record<string, unknown>) {
  return {
    id: n['id'],
    type: n['type'],
    title: n['title'],
    body: n['body'] ?? null,
    resourceType: n['resourceType'] ?? null,
    resourceId: n['resourceId'] ?? null,
    isRead: n['isRead'],
    readAt: n['readAt'] ?? null,
    createdAt: n['createdAt'],
  };
}

/**
 * `rova_list_notifications` — the caller's own notifications (GET /v1/notifications/paged,
 * @SelfScoped). The route is cursor-paged; the tool pages at the shared tool cap and relays
 * the route's own pageInfo, so a full page means re-ask with the cursor, never a guess.
 */
export function registerListNotifications(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_list_notifications',
    {
      title: 'List notifications',
      description:
        'Your own notifications, newest first. Filter to unread only or one category. Paginated.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        ...pageArgs,
        unreadOnly: z.boolean().optional().describe('Only unread notifications (default all)'),
        category: z
          .enum(['assigned', 'mentions'])
          .optional()
          .describe('Only one category (default all)'),
      },
    },
    async ({ unreadOnly, category, limit, cursor }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/notifications/paged',
        query: {
          limit: limit ?? 20,
          cursor,
          ...(unreadOnly ? { unreadOnly: 'true' } : {}),
          ...(category ? { category } : {}),
        },
      });
      return listResult(statusCode, json, shapeNotification, 'notifications');
    },
  );
}
