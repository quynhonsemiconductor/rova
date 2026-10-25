import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, type ToolContext } from './rest';

/**
 * `get_portfolio_item` — one Epic or Feature with its estimate/rollup/progress, plus the
 * capped children feed for Features (GET /v1/portfolio-items/:id + :id/children —
 * `portfolio:view` resolved from the row; a bad id is a clean 404). Children are capped at
 * 50 with `truncated`.
 */
export function registerGetPortfolioItem(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'get_portfolio_item',
    {
      title: 'Get portfolio item',
      description:
        'One Epic or Feature by id — estimates, rollups, progress — plus its children for Features (capped at 50).',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        portfolioItemId: z.uuid().describe('The Epic or Feature id'),
      },
    },
    async ({ portfolioItemId }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: `/v1/portfolio-items/${portfolioItemId}`,
      });
      if (statusCode >= 400 || json === null || typeof json !== 'object' || Array.isArray(json))
        return denied(statusCode, json);
      const p = json as Record<string, unknown>;
      const estimate = p['estimate'] as Record<string, unknown> | undefined;
      const rollup = p['rollup'] as Record<string, unknown> | undefined;
      const progress = p['progress'] as Record<string, unknown> | undefined;

      // children exist only for Features; Epics have none
      const children = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: `/v1/portfolio-items/${portfolioItemId}/children`,
        query: { limit: 50 },
      });
      const childRows =
        children.statusCode < 400 && Array.isArray(children.json)
          ? (children.json as Record<string, unknown>[])
          : [];

      const payload: Record<string, unknown> = {
        id: p['id'],
        itemKey: p['itemKey'],
        type: p['type'],
        name: p['name'],
        state: p['state'],
        parentKey: p['parentKey'] ?? null,
        ownerName: p['ownerName'] ?? null,
        projectName: p['projectName'] ?? null,
        plannedStartDate: p['plannedStartDate'] ?? null,
        plannedEndDate: p['plannedEndDate'] ?? null,
        estimate: estimate
          ? {
              points: estimate['points'],
              count: estimate['count'],
            }
          : undefined,
        rollup: rollup
          ? {
              rollupPoints: rollup['rollupPoints'],
              rollupCount: rollup['rollupCount'],
              acceptedPoints: rollup['acceptedPoints'],
              acceptedCount: rollup['acceptedCount'],
            }
          : undefined,
        progress: progress
          ? {
              percentDoneByPlanEstimate: progress['percentDoneByPlanEstimate'] ?? null,
              percentDoneByCount: progress['percentDoneByCount'] ?? null,
            }
          : undefined,
        children: childRows.map((c) => ({
          id: c['id'],
          itemKey: c['itemKey'],
          type: c['type'],
          title: c['title'],
          scheduleState: c['scheduleState'],
        })),
      };
      if (childRows.length >= 50) payload['truncated'] = true;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
      };
    },
  );
}
