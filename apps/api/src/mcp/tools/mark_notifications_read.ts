import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, pathSegment, result, toolError, type ToolContext } from './rest';

/**
 * `rova_mark_notifications_read` — mark ONE of the caller's notifications read, or all of them
 * (W13). Self-scoped routes: the service refuses an id the caller does not own, so the tool needs
 * no ownership check of its own.
 *
 * Idempotent by nature (marking an already-read row is a no-op), which the annotation states.
 */
export function registerMarkNotificationsRead(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_mark_notifications_read',
    {
      title: 'Mark notifications read',
      description:
        "WRITES: marks one of your notifications read (id) or all of them (all: true), as you. Idempotent. Use only on the user's explicit request.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        notificationId: z.uuid().optional().describe('The notification to mark read'),
        all: z.literal(true).optional().describe('Mark every notification read'),
      },
    },
    async ({ notificationId, all }) => {
      if ((notificationId === undefined) === (all === undefined)) {
        return toolError('Pass exactly one of notificationId or all: true.');
      }
      if (!ctx.idempotencyKey) return toolError('Writes are not enabled on this endpoint.');
      const idempotencyKey = ctx.idempotencyKey('rova_mark_notifications_read', {
        notificationId,
        all,
      });
      const res =
        notificationId !== undefined
          ? await ctx.callRest(ctx.principal, {
              method: 'POST',
              url: `/v1/notifications/${pathSegment(notificationId)}/read`,
              idempotencyKey,
            })
          : await ctx.callRest(ctx.principal, {
              method: 'POST',
              url: '/v1/notifications/read-all',
              idempotencyKey,
            });
      if (res.statusCode >= 400) return denied(res.statusCode, res.json);
      return result(res.statusCode, res.json, {
        marked: true,
        ...(notificationId !== undefined ? { notificationId } : { all: true }),
      });
    },
  );
}
