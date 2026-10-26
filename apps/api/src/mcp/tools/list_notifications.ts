import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, type ToolContext } from './rest';

/** The tool's page stays under the REST max; one extra row detects more without a second call. */
export const MAX_LIMIT = 20;

/** One page of the feed; `truncated` when the route returned more than `take` rows. */
export function shapeNotifications(rows: Record<string, unknown>[], take: number) {
  const payload: Record<string, unknown> = {
    notifications: rows.slice(0, take).map(shapeNotification),
  };
  if (rows.length > take) payload['truncated'] = true;
  return payload;
}

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
 * `list_notifications` — the caller's own notifications (GET /v1/notifications, @SelfScoped).
 * The route answers a bare array capped by its `limit` (newest first); the tool pages at 20 and
 * fetches one extra row to set `truncated` when more exist.
 */
export function registerListNotifications(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'list_notifications',
    {
      title: 'List notifications',
      description:
        'Your own notifications, newest first (capped at 20 per page). Filter to unread only or one category.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        unreadOnly: z.boolean().optional().describe('Only unread notifications (default all)'),
        category: z
          .enum(['assigned', 'mentions'])
          .optional()
          .describe('Only one category (default all)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .describe(`Page size (default ${MAX_LIMIT})`),
      },
    },
    async ({ unreadOnly, category, limit }) => {
      const take = limit ?? MAX_LIMIT;
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/notifications',
        query: {
          ...(unreadOnly ? { unreadOnly: 'true' } : {}),
          ...(category ? { category } : {}),
          limit: take + 1, // one extra row: the route's own cap says whether more exist
        },
      });
      if (statusCode >= 400 || !Array.isArray(json)) return denied(statusCode, json);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(shapeNotifications(json as Record<string, unknown>[], take)),
          },
        ],
      };
    },
  );
}
