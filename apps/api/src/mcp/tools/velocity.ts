import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { result, type ToolContext } from './rest';

/**
 * `velocity` — the Velocity report of one project (GET /v1/reports/velocity, `report:view`
 * from the `projectId` query): Accepted During / After / Not Accepted per completed timebox.
 * The route's payload is bounded by the window (5 or 10 timeboxes) — relayed as-is.
 */
export function registerVelocity(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_velocity',
    {
      title: 'Velocity report',
      description:
        'The Velocity report for one project: Accepted During / After / Not Accepted per completed timebox, over the last 5 or 10 timeboxes.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        projectId: z.uuid().describe('The project the report runs for'),
        window: z
          .union([z.literal(5), z.literal(10)])
          .optional()
          .describe('How many completed timeboxes (default: the route default)'),
        teamId: z.uuid().optional().describe('Scope to one team (omit for All Teams)'),
      },
    },
    async ({ projectId, window, teamId }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/reports/velocity',
        query: { projectId, ...(window ? { window } : {}), ...(teamId ? { teamId } : {}) },
      });
      return result(statusCode, json, json);
    },
  );
}
