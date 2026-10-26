import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listResult, type ToolContext } from './rest';

/**
 * `iteration_options` — the reference feed of every iteration in one project
 * (GET /v1/iterations/options, `iteration:view` from the `projectId` query). Identity plus
 * window — the picker feed, for resolving iteration ids to names.
 */
export function registerIterationOptions(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_iteration_options',
    {
      title: 'Iteration options',
      description:
        'Every iteration in one project you can read — id, name, state and window — for resolving iteration ids.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        projectId: z.uuid().describe('The project to list iterations from'),
        teamId: z.uuid().optional().describe('Filter by team'),
      },
    },
    async ({ projectId, teamId }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/iterations/options',
        query: { projectId, ...(teamId ? { teamId } : {}) },
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
          teamId: it['teamId'] ?? null,
        }),
        'iterations',
      );
    },
  );
}
