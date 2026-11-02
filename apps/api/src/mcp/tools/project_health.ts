import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listResult, type ToolContext } from './rest';

/** The ProjectHealthResponseDto row, as the Home widget renders it. */
export function shapeHealthRow(p: Record<string, unknown>) {
  return {
    id: p['id'],
    key: p['key'],
    name: p['name'],
    leadName: p['leadName'] ?? null,
    activeSprintName: p['activeSprintName'] ?? null,
    progressPercent: p['progressPercent'],
    openDefects: p['openDefects'],
    blockedCount: p['blockedCount'],
  };
}

/**
 * `rova_project_health` — the bounded, attention-sorted per-project health rollup
 * (GET /v1/projects/health, scoped by AccessService.listReadableProjectIds like list_projects:
 * a no-role member gets an EMPTY list, not a denial). The route reads `@Query('limit')` only
 * and answers a bare array.
 */
export function registerProjectHealth(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_project_health',
    {
      title: 'Project health',
      description:
        'The per-project health rollup (attention-sorted) across the projects you can read.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('How many rows (default 10, max 50 — the route clamps to the same window)'),
      },
    },
    async ({ limit }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/projects/health',
        query: { ...(limit ? { limit } : {}) },
      });
      return listResult(statusCode, json, shapeHealthRow, 'projects');
    },
  );
}
