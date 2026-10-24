import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pageInfoOf, pageArgs, result, type ToolContext } from './rest';

/**
 * `list_milestones` — the milestones of one project the person can read
 * (GET /v1/milestones, `milestone:view` from the `projectId` query).
 */
export function registerListMilestones(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'list_milestones',
    {
      title: 'List milestones',
      description: 'The milestones of one project you can read. Paginated.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        projectId: z.uuid().describe('The project to list milestones from'),
        ...pageArgs,
      },
    },
    async ({ projectId, limit, cursor }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/milestones',
        query: { projectId, limit: limit ?? 20, cursor },
      });
      const page = json as { data?: Record<string, unknown>[] };
      return result(statusCode, json, {
        milestones: (page.data ?? []).map((m) => ({
          id: m['id'],
          milestoneKey: m['milestoneKey'],
          name: m['name'],
          status: m['status'],
          targetStartDate: m['targetStartDate'] ?? null,
          targetEndDate: m['targetEndDate'] ?? null,
        })),
        ...pageInfoOf(json),
      });
    },
  );
}
