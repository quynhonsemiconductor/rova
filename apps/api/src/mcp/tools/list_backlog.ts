import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pageInfoOf, pageArgs, result, type ToolContext } from './rest';
import { toToolWorkItem } from './search_work_items';

/**
 * `list_backlog` — the backlog (stories + defects) of one project the person can read
 * (GET /v1/work-items/backlog, `work_item:view` from the `projectId` query).
 */
export function registerListBacklog(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'list_backlog',
    {
      title: 'List backlog',
      description:
        'The backlog (stories and defects) of one project you can read, with optional filters. Paginated.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        projectId: z.uuid().describe('The project whose backlog to list'),
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
        url: '/v1/work-items/backlog',
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
