import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, type ToolContext } from './rest';

/**
 * `list_milestones` — the milestones of one project the person can read
 * (GET /v1/milestones, `milestone:view` from the `projectId` query). The REST route does not
 * paginate, so the tool caps the feed and sets `truncated`.
 */
export function registerListMilestones(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'list_milestones',
    {
      title: 'List milestones',
      description: 'The milestones of one project you can read (capped at 100).',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        projectId: z.uuid().describe('The project to list milestones from'),
      },
    },
    async ({ projectId }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/milestones',
        query: { projectId },
      });
      if (statusCode >= 400) return denied(statusCode, json);
      // the paged route wraps rows in { data, pageInfo }
      const rows = Array.isArray(json) ? json : (json as { data?: unknown } | null)?.data;
      if (!Array.isArray(rows)) return denied(statusCode, json);
      const all = rows as Record<string, unknown>[];
      const capped = all.slice(0, 100);
      const payload: Record<string, unknown> = {
        milestones: capped.map((m) => ({
          id: m['id'],
          milestoneKey: m['milestoneKey'],
          name: m['name'],
          status: m['status'],
          targetStartDate: m['targetStartDate'] ?? null,
          targetEndDate: m['targetEndDate'] ?? null,
        })),
      };
      if (all.length > 100) payload['truncated'] = true;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
      };
    },
  );
}
