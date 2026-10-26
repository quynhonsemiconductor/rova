import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, type ToolContext } from './rest';

/** Shapes the Team Status board body into the tool's small payload. */
export function shapeTeamStatus(body: Record<string, unknown>): Record<string, unknown> {
  const allGroups = (body['groups'] as Record<string, unknown>[] | undefined) ?? [];
  const groups = allGroups.slice(0, 100);
  const members = groups.map((g) => {
    const owner = g['owner'] as Record<string, unknown> | undefined;
    return {
      displayName: owner?.['displayName'] ?? null,
      capacityHours: g['capacityHours'],
      taskCount: g['taskCount'],
      estimateHours: g['estimateHours'],
      todoHours: g['todoHours'],
      actualHours: g['actualHours'],
      progressPercent: g['progressPercent'],
    };
  });
  const iteration = body['iteration'] as Record<string, unknown> | undefined;
  const payload: Record<string, unknown> = {
    iteration: iteration
      ? {
          name: iteration['name'],
          startDate: iteration['startDate'] ?? null,
          endDate: iteration['endDate'] ?? null,
        }
      : undefined,
    totals: body['totals'] ?? undefined,
    members,
  };
  if (allGroups.length > 100) payload['truncated'] = true;
  return payload;
}

/**
 * `team_status` — the Team Status board of one project for one iteration
 * (GET /v1/team-status, `team_status:view` from the `projectId` query): per-member
 * task status and progress. (Hours live in the team_capacity report.)
 */
export function registerTeamStatus(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_team_status',
    {
      title: 'Team status',
      description:
        'The Team Status board for one project and iteration: per-member task status and progress. (Hours live in the team_capacity report.)',
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
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(shapeTeamStatus(json as Record<string, unknown>)),
          },
        ],
      };
    },
  );
}
