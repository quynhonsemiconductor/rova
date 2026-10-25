import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { result, type ToolContext } from './rest';

/**
 * `team_capacity` — the Team Capacity report of one project (GET /v1/reports/team-capacity,
 * `report:view` from the `projectId` query): a read-only projection of Team Status hours,
 * bounded by the team roster — relayed as-is.
 */
export function registerTeamCapacity(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'team_capacity',
    {
      title: 'Team capacity',
      description:
        'The Team Capacity report for one project: per-member hours from Team Status for the iteration.',
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
        url: '/v1/reports/team-capacity',
        query: { projectId, iterationId, ...(teamId ? { teamId } : {}) },
      });
      return result(statusCode, json, json);
    },
  );
}
