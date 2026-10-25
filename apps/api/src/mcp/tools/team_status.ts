import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, type ToolContext } from './rest';

/**
 * `team_status` — the Team Status board of one project for one iteration
 * (GET /v1/team-status, `team_status:view` from the `projectId` query): per-member
 * capacity and task progress, grouped by member.
 */
export function registerTeamStatus(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'team_status',
    {
      title: 'Team status',
      description:
        'The Team Status board for one project and iteration: per-member capacity, task counts and progress.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        projectId: z.uuid().describe('The project the board runs for'),
        iterationId: z.uuid().describe('The iteration the board runs for'),
        teamId: z.uuid().optional().describe('Scope to one team'),
      },
    },
    async ({ projectId, iterationId, teamId }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/team-status',
        query: { projectId, iterationId, ...(teamId ? { teamId } : {}) },
      });
      if (statusCode >= 400 || json === null || typeof json !== 'object' || Array.isArray(json))
        return denied(statusCode, json);
      const body = json as {
        iteration?: Record<string, unknown>;
        totals?: Record<string, unknown>;
        groups?: Record<string, unknown>[];
      };
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              iteration: body.iteration
                ? {
                    name: body.iteration['name'],
                    startDate: body.iteration['startDate'] ?? null,
                    endDate: body.iteration['endDate'] ?? null,
                  }
                : undefined,
              totals: body.totals ?? undefined,
              members: (body.groups ?? []).map((g) => ({
                displayName: g['displayName'] ?? null,
                capacityHours: g['capacityHours'],
                taskCount: g['taskCount'],
                estimateHours: g['estimateHours'],
                todoHours: g['todoHours'],
                actualHours: g['actualHours'],
                progressPercent: g['progressPercent'],
              })),
            }),
          },
        ],
      };
    },
  );
}
