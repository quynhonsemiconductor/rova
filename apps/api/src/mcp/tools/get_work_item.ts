import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { result, type ToolContext } from './rest';

/**
 * `get_work_item` — one work item by id, if the person can read it
 * (GET /v1/work-items/:id, `work_item:view` on the item).
 */
export function registerGetWorkItem(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_work_item',
    {
      title: 'Get work item',
      description: 'One work item by id, exactly what its detail page shows you.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        workItemId: z.uuid().describe('The work item id'),
      },
    },
    async ({ workItemId }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: `/v1/work-items/${workItemId}`,
      });
      const p = json as Record<string, unknown>;
      return result(statusCode, json, {
        id: p['id'],
        itemKey: p['itemKey'],
        title: p['title'],
        type: p['type'],
        description: p['description'] ?? null,
        scheduleState: p['scheduleState'],
        priority: p['priority'],
        assigneeName: p['assigneeName'] ?? null,
        storyPoints: p['storyPoints'] ?? null,
        iterationId: p['iterationId'] ?? null,
        acceptanceCriteria: p['acceptanceCriteria'] ?? null,
      });
    },
  );
}
