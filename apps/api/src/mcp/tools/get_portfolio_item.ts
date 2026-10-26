import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, type ToolContext } from './rest';

/** Shapes the detail body + paged children wrapper into the tool's small payload. */
export function shapePortfolioDetail(
  detail: Record<string, unknown>,
  childrenPage: { data?: Record<string, unknown>[]; pageInfo?: { hasNextPage?: boolean } },
): Record<string, unknown> {
  const estimate = detail['estimate'] as Record<string, unknown> | undefined;
  const rollup = detail['rollup'] as Record<string, unknown> | undefined;
  const progress = detail['progress'] as Record<string, unknown> | undefined;
  const childRows = Array.isArray(childrenPage.data) ? childrenPage.data : [];
  const capped = childRows.slice(0, 50);
  const payload: Record<string, unknown> = {
    id: detail['id'],
    itemKey: detail['itemKey'],
    type: detail['type'],
    name: detail['name'],
    state: detail['state'],
    parentKey: detail['parentKey'] ?? null,
    ownerName: detail['ownerName'] ?? null,
    projectName: detail['projectName'] ?? null,
    plannedStartDate: detail['plannedStartDate'] ?? null,
    plannedEndDate: detail['plannedEndDate'] ?? null,
    estimate: estimate
      ? {
          points: estimate['points'],
          count: estimate['count'],
        }
      : undefined,
    // estimate.points / estimate.count are { value, tier } objects — not plain numbers.
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
    children: capped.map((c) => ({
      id: c['id'],
      itemKey: c['itemKey'],
      type: c['type'],
      title: c['title'],
      scheduleState: c['scheduleState'],
    })),
  };
  if (childrenPage.pageInfo?.hasNextPage === true || childRows.length > 50)
    payload['truncated'] = true;
  return payload;
}

/**
 * `get_portfolio_item` — one Epic or Feature with its estimate/rollup/progress, plus the
 * capped children feed for Features (GET /v1/portfolio-items/:id + :id/children —
 * `portfolio:view` resolved from the row; a bad id is a clean 404). Children are capped at
 * 50 with `truncated`.
 */
export function registerGetPortfolioItem(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_get_portfolio_item',
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
      const detail = json as Record<string, unknown>;

      // children exist only for Features; Epics have none. The route returns the paged
      // wrapper { data, pageInfo } (@ApiPagedResponse(PortfolioChildResponseDto)).
      const children = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: `/v1/portfolio-items/${portfolioItemId}/children`,
        query: { limit: 50 },
      });
      if (children.statusCode >= 400 || children.json === null || typeof children.json !== 'object')
        return denied(children.statusCode, children.json);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(shapePortfolioDetail(detail, children.json)),
          },
        ],
      };
    },
  );
}
