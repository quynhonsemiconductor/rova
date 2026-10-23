import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pageInfoOf, pageArgs, result, type ToolContext } from './rest';

/** The small work-item shape the search/get tools return. */
export function toToolWorkItem(p: Record<string, unknown>) {
  return {
    id: p['id'],
    itemKey: p['itemKey'],
    title: p['title'],
    type: p['type'],
    scheduleState: p['scheduleState'],
    priority: p['priority'],
    assigneeName: p['assigneeName'] ?? null,
    iterationId: p['iterationId'] ?? null,
  };
}

/**
 * `search_work_items` — filtered list in one project (GET /v1/work-items, `work_item:view` from
 * the `projectId` query). Filters mirror the REST `WorkItemQueryDto` subset an agent needs.
 */
export function registerSearchWorkItems(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'search_work_items',
    {
      title: 'Search work items',
      description:
        'Search the work items of one project you can read, with optional filters. Paginated.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        projectId: z.uuid().describe('The project to search in'),
        q: z.string().optional().describe('Free-text search over title and key'),
        assigneeId: z.uuid().optional().describe('Filter by assignee'),
        iterationId: z.uuid().optional().describe('Filter by iteration'),
        statusId: z.uuid().optional().describe('Filter by workflow status'),
        priority: z.string().optional().describe('Filter by priority'),
        ...pageArgs,
      },
    },
    async ({ projectId, q, assigneeId, iterationId, statusId, priority, limit, cursor }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/work-items',
        query: {
          projectId,
          q,
          assigneeId,
          iterationId,
          statusId,
          priority,
          limit: limit ?? 20,
          cursor,
        },
      });
      const page = json as { data?: Record<string, unknown>[] };
      return result(statusCode, json, {
        items: (page.data ?? []).map(toToolWorkItem),
        ...pageInfoOf(json),
      });
    },
  );
}
