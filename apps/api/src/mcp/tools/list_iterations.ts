import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listResult, pageArgs, type ToolContext } from './rest';

/**
 * `list_iterations` — the iterations of one project the person can read
 * (GET /v1/iterations, `timebox:view` from the `projectId` query).
 */
export function registerListIterations(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_list_iterations',
    {
      title: 'List iterations',
      description: 'The iterations of one project you can read. Paginated.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        projectId: z.uuid().describe('The project to list iterations from'),
        ...pageArgs,
      },
    },
    async ({ projectId, limit, cursor }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/iterations',
        query: { projectId, limit: limit ?? 20, cursor },
      });
      return listResult(
        statusCode,
        json,
        (it) => ({
          id: it['id'],
          name: it['name'],
          iterationKey: it['iterationKey'] ?? null,
          state: it['state'],
          startDate: it['startDate'] ?? null,
          endDate: it['endDate'] ?? null,
        }),
        'iterations',
      );
    },
  );
}
