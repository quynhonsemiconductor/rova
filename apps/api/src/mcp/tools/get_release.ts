import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, type ToolContext } from './rest';

/**
 * `get_release` — one release with its work-item rollups, plus the release's artifacts
 * (GET /v1/releases/:id, `release:view`; then GET /v1/releases/:id/artifacts, also
 * `release:view`, capped at 100 with `truncated`).
 */
export function registerGetRelease(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'get_release',
    {
      title: 'Get release',
      description:
        'One release by id with its work-item rollups, plus its artifacts (stories/defects), capped at 100.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        releaseId: z.uuid().describe('The release id'),
      },
    },
    async ({ releaseId }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: `/v1/releases/${releaseId}`,
      });
      if (statusCode >= 400 || json === null || typeof json !== 'object' || Array.isArray(json))
        return denied(statusCode, json);
      const r = json as Record<string, unknown>;
      const rollup = r['rollup'] as Record<string, unknown> | undefined;
      const artifacts = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: `/v1/releases/${releaseId}/artifacts`,
        query: { limit: 100 },
      });
      if (artifacts.statusCode >= 400 || !Array.isArray(artifacts.json))
        return denied(artifacts.statusCode, artifacts.json);
      const payload: Record<string, unknown> = {
        id: r['id'],
        releaseKey: r['releaseKey'],
        name: r['name'],
        status: r['status'],
        startDate: r['startDate'] ?? null,
        releaseDate: r['releaseDate'] ?? null,
        plannedVelocity: r['plannedVelocity'] ?? null,
        taskEstimate: r['taskEstimate'] ?? null,
        estimateHours: r['estimateHours'] ?? null,
        acceptedItems: r['acceptedItems'] ?? null,
        artifacts: (artifacts.json as Record<string, unknown>[]).map((a) => ({
          id: a['id'],
          itemKey: a['itemKey'],
          type: a['type'],
          title: a['title'],
          scheduleState: a['scheduleState'],
        })),
      };
      if (rollup) payload['rollup'] = rollup;
      if ((artifacts.json as unknown[]).length >= 100) payload['truncated'] = true;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
      };
    },
  );
}
