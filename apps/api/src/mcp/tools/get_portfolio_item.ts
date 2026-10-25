import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, result, type ToolContext } from './rest';

/**
 * `get_portfolio_item` — one Epic or Feature with its rollups
 * (GET /v1/portfolio-items/:id, `portfolio:view` resolved from the row — a bad id is a clean 404).
 */
export function registerGetPortfolioItem(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'get_portfolio_item',
    {
      title: 'Get portfolio item',
      description:
        'One Epic or Feature by id, with its points rollups — what its detail page shows you.',
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
      const points = p['points'] as Record<string, unknown> | undefined;
      const counts = p['count'] as Record<string, unknown> | undefined;
      return result(statusCode, json, {
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
        points: points ? { value: points['value'], tier: points['tier'] } : undefined,
        count: counts ? { value: counts['value'], tier: counts['tier'] } : undefined,
        rollupPoints: p['rollupPoints'],
        acceptedPoints: p['acceptedPoints'],
      });
    },
  );
}
