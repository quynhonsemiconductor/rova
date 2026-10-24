import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { result, type ToolContext } from './rest';
import { toToolWorkItem } from './search_work_items';

/**
 * `get_work_item_by_key` — one work item by its human key (e.g. `OBSE-42`)
 * (GET /v1/work-items/by-key?itemKey=…, `work_item:view` on the item).
 */
export function registerGetWorkItemByKey(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'get_work_item_by_key',
    {
      title: 'Get work item by key',
      description: 'One work item by its human key (e.g. OBSE-42), what its detail page shows you.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        itemKey: z.string().min(1).max(64).describe('The work item key, e.g. OBSE-42'),
      },
    },
    async ({ itemKey }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/work-items/by-key',
        query: { itemKey },
      });
      const p = json as Record<string, unknown>;
      return result(statusCode, json, toToolWorkItem(p));
    },
  );
}
