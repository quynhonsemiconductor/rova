import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { result, type ToolContext } from './rest';

/**
 * `release_tracking` — the Release Tracking report for one project and release
 * (GET /v1/reports/release-tracking, `report:view` from the `projectId` query): the grid's
 * Status rows plus the burnup chart data — relayed as-is. Paged by the route.
 */
export function registerReleaseTracking(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'release_tracking',
    {
      title: 'Release tracking',
      description:
        'The Release Tracking report for one project and release: per-item status rows and the burnup chart. Paged.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        projectId: z.uuid().describe('The project the report runs for'),
        releaseId: z.uuid().describe('The release the report runs for'),
        teamId: z.uuid().optional().describe('Scope to one team'),
        unit: z.enum(['points', 'count']).optional().describe('Chart unit (default points)'),
        bucket: z.enum(['direct', 'derived', 'unparented']).optional(),
        page: z.number().int().min(1).optional(),
      },
    },
    async ({ projectId, releaseId, teamId, unit, bucket, page }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/reports/release-tracking',
        query: {
          projectId,
          releaseId,
          ...(teamId ? { teamId } : {}),
          ...(unit ? { unit } : {}),
          ...(bucket ? { bucket } : {}),
          ...(page ? { page } : {}),
        },
      });
      return result(statusCode, json, json);
    },
  );
}
