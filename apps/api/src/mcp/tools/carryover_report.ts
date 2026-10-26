import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { result, type ToolContext } from './rest';

/**
 * `carryover_report` — the Carryover report for one project and iteration
 * (GET /v1/reports/carryover, `report:view` from the `projectId` query): Carry In / Out,
 * transferred To Do, rate, trend and rows — relayed as-is.
 */
export function registerCarryoverReport(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_carryover_report',
    {
      title: 'Carryover report',
      description:
        'The Carryover report for one project and iteration: what carried in/out, transferred To Do, rate and trend.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        projectId: z.uuid().describe('The project the report runs for'),
        iterationId: z.uuid().describe('The iteration the report runs for'),
        teamId: z.uuid().optional().describe('Scope to one team'),
        direction: z
          .enum(['in', 'out', 'all'])
          .optional()
          .describe('Narrow the rows to carry-in or carry-out (default all)'),
      },
    },
    async ({ projectId, iterationId, teamId, direction }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/reports/carryover',
        query: {
          projectId,
          iterationId,
          ...(teamId ? { teamId } : {}),
          ...(direction && direction !== 'all' ? { direction } : {}),
        },
      });
      return result(statusCode, json, json);
    },
  );
}
