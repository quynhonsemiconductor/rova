import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pageInfoOf, pageArgs, result, type ToolContext } from './rest';

/**
 * `list_releases` — the releases of one project the person can read
 * (GET /v1/releases, `release:view` from the `projectId` query).
 */
export function registerListReleases(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'list_releases',
    {
      title: 'List releases',
      description: 'The releases of one project you can read. Paginated.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        projectId: z.uuid().describe('The project to list releases from'),
        ...pageArgs,
      },
    },
    async ({ projectId, limit, cursor }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/releases',
        query: { projectId, limit: limit ?? 20, cursor },
      });
      const page = json as { data?: Record<string, unknown>[] };
      return result(statusCode, json, {
        releases: (page.data ?? []).map((r) => ({
          id: r['id'],
          releaseKey: r['releaseKey'],
          name: r['name'],
          status: r['status'],
          startDate: r['startDate'] ?? null,
          releaseDate: r['releaseDate'] ?? null,
        })),
        ...pageInfoOf(json),
      });
    },
  );
}
