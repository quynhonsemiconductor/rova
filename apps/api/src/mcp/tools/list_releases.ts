import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, type ToolContext } from './rest';

/**
 * `list_releases` — the releases of one project the person can read
 * (GET /v1/releases, `release:view` from the `projectId` query). The REST route does not
 * paginate, so the tool caps the feed and sets `truncated`.
 */
export function registerListReleases(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'list_releases',
    {
      title: 'List releases',
      description: 'The releases of one project you can read (capped at 100).',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        projectId: z.uuid().describe('The project to list releases from'),
      },
    },
    async ({ projectId }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/releases',
        query: { projectId },
      });
      if (statusCode >= 400) return denied(statusCode, json);
      // the paged route wraps rows in { data, pageInfo }
      const rows = Array.isArray(json) ? json : (json as { data?: unknown } | null)?.data;
      if (!Array.isArray(rows)) return denied(statusCode, json);
      const all = rows as Record<string, unknown>[];
      const capped = all.slice(0, 100);
      const payload: Record<string, unknown> = {
        releases: capped.map((r) => ({
          id: r['id'],
          releaseKey: r['releaseKey'],
          name: r['name'],
          status: r['status'],
          startDate: r['startDate'] ?? null,
          releaseDate: r['releaseDate'] ?? null,
        })),
      };
      if (all.length > 100) payload['truncated'] = true;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
      };
    },
  );
}
