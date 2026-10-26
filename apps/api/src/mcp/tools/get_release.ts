import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, type ToolContext } from './rest';

/** The artifacts dashboard is fetched one page at a time; `pageInfo.hasNextPage` says if more exist. */
const MAX_ARTIFACTS = 100;

/**
 * The ReleaseResponseDto fields an agent acts on. The roll-up is `taskRollup` (estimateHours,
 * toDoHours, actualHours, acceptedItems) — there is no top-level `estimateHours`/`acceptedItems`.
 */
export function shapeRelease(r: Record<string, unknown>, artifacts: Record<string, unknown>[]) {
  const payload: Record<string, unknown> = {
    id: r['id'],
    releaseKey: r['releaseKey'] ?? null,
    name: r['name'],
    status: r['status'],
    startDate: r['startDate'] ?? null,
    releaseDate: r['releaseDate'] ?? null,
    plannedVelocity: r['plannedVelocity'] ?? null,
    planEstimate: r['planEstimate'] ?? null,
    taskEstimate: r['taskEstimate'],
    ...(r['taskRollup'] !== undefined ? { taskRollup: r['taskRollup'] } : {}),
    artifacts: artifacts.map((a) => ({
      id: a['id'],
      itemKey: a['itemKey'],
      type: a['type'],
      title: a['title'],
      scheduleState: a['scheduleState'],
    })),
  };
  return payload;
}

/**
 * `rova_get_release` — one release with its work-item roll-up, plus the release's artifacts
 * (GET /v1/releases/:id, `release:view` on the release; then the :id/artifacts dashboard,
 * the same permission, cursor-paged — capped at 100 with `truncated`).
 */
export function registerGetRelease(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_get_release',
    {
      title: 'Get release',
      description:
        'One release by id with its work-item roll-up, plus its artifacts (stories/defects), capped at 100.',
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

      const page = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: `/v1/releases/${releaseId}/artifacts`,
        query: { limit: MAX_ARTIFACTS },
      });
      if (
        page.statusCode >= 400 ||
        page.json === null ||
        typeof page.json !== 'object' ||
        Array.isArray(page.json) ||
        !Array.isArray((page.json as { data?: unknown }).data)
      )
        return denied(page.statusCode, page.json);
      const body = page.json as {
        data: Record<string, unknown>[];
        pageInfo?: { hasNextPage?: boolean };
      };

      const payload = shapeRelease(r, body.data);
      if (body.pageInfo?.hasNextPage === true) payload['truncated'] = true;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
      };
    },
  );
}
