import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { result, type ToolContext } from './rest';

/**
 * `unread_notifications` — the caller's unread notification count
 * (GET /v1/notifications/unread-count, SelfScoped).
 */
export function registerUnreadNotifications(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'unread_notifications',
    {
      title: 'Unread notifications',
      description: 'How many unread notifications you have.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {},
    },
    async () => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/notifications/unread-count',
      });
      const body = json as Record<string, unknown>;
      return result(statusCode, json, { count: body['count'] });
    },
  );
}
