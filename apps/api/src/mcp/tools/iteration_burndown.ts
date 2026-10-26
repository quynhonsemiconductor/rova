import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { result, type ToolContext } from './rest';

/**
 * `rova_iteration_burndown` — the Iteration Burndown report of one project
 * (GET /v1/reports/iteration-burndown, `report:view` from the `projectId` query). The route's
 * payload is the bounded daily series for one iteration — relayed as-is.
 */
export function registerIterationBurndown(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_iteration_burndown',
    {
      title: 'Iteration burndown',
      description:
        'The Iteration Burndown report for one project: daily Remaining To Do, Accepted Points and the Ideal line.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        projectId: z.uuid().describe('The project the report runs for'),
        iterationId: z.uuid().describe('The iteration the report runs for'),
        teamId: z.uuid().optional().describe('Scope to one team (omit for All Teams)'),
      },
    },
    async ({ projectId, iterationId, teamId }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/reports/iteration-burndown',
        query: { projectId, iterationId, ...(teamId ? { teamId } : {}) },
      });
      return result(statusCode, json, json);
    },
  );
}
