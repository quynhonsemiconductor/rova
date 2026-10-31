import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listResult, type ToolContext } from './rest';

/**
 * `rova_list_portfolio_items` — Epics or Features across the projects the person can read
 * (GET /v1/portfolio-items, AccessService-scoped: `listReadableProjectIds` — a no-role
 * member gets an EMPTY page, not a denial). `type` is REQUIRED by the REST route.
 */
export function registerListPortfolioItems(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_list_portfolio_items',
    {
      title: 'List portfolio items',
      description:
        'Epics or Features across the projects you can read. `type` picks Epics or Features — there is no combined view. Paginated.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        type: z.enum(['epic', 'feature']).describe('Epic or Feature'),
        projectId: z.uuid().optional().describe('Scope to one project'),
        teamId: z.uuid().optional().describe('Scope to one team'),
        search: z.string().max(255).optional().describe('Free-text search over name'),
        limit: z.number().int().min(1).max(50).optional().describe('Page size (default 20)'),
        cursor: z.string().optional().describe('Opaque cursor from the previous page'),
      },
    },
    async ({ type, projectId, teamId, search, limit, cursor }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/portfolio-items',
        query: {
          type,
          ...(projectId ? { projectId } : {}),
          ...(teamId ? { teamId } : {}),
          ...(search ? { search } : {}),
          limit: limit ?? 20,
          cursor,
        },
      });
      return listResult(
        statusCode,
        json,
        (it) => ({
          id: it['id'],
          itemKey: it['itemKey'],
          type: it['type'],
          name: it['name'],
          state: it['state'],
          projectName: it['projectName'] ?? null,
          parentKey: it['parentKey'] ?? null,
          ownerName: it['ownerName'] ?? null,
        }),
        'portfolioItems',
      );
    },
  );
}
