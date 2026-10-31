import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, result, type ToolContext } from './rest';

/**
 * `rova_work_item_activity` — the revision history of one work item
 * (GET /v1/work-items/:id/activity, `work_item:view` on the item). The REST route pages by
 * page/pageSize (no cursor); the tool caps the page and relays the total.
 */
const MAX_PAGE_SIZE = 25;

export function registerWorkItemActivity(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_work_item_activity',
    {
      title: 'Work item activity',
      description: 'The revision history of one work item you can read, newest page first.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        workItemId: z.uuid().describe('The work item whose history to list'),
        page: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe('Page number (1 = newest entries)'),
      },
    },
    async ({ workItemId, page }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: `/v1/work-items/${workItemId}/activity`,
        query: { page: page ?? 1, pageSize: MAX_PAGE_SIZE },
      });
      if (statusCode >= 400 || json === null || typeof json !== 'object' || Array.isArray(json))
        return denied(statusCode, json);
      const body = json as { data?: Record<string, unknown>[]; total?: number; page?: number };
      return result(statusCode, json, {
        activity: (body.data ?? []).map((a) => ({
          createdAt: a['createdAt'],
          actorName: a['actorName'] ?? null,
          action: a['action'],
          changes: a['changes'] ?? null,
        })),
        total: body.total,
        page: body.page,
        pageSize: MAX_PAGE_SIZE,
      });
    },
  );
}
