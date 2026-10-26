import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, type ToolContext } from './rest';

/** A companion feed is capped below any plausible answer; more gets a `truncated` flag. */
export const MAX_LINKS = 100;

/**
 * The MilestoneResponseDto fields an agent acts on, with the three junction feeds attached
 * (each a bare id array, capped) and `truncated` when a cap bit.
 */
export function shapeMilestone(
  m: Record<string, unknown>,
  artifacts: string[],
  releases: string[],
  projects: string[],
) {
  const payload: Record<string, unknown> = {
    id: m['id'],
    milestoneKey: m['milestoneKey'] ?? null,
    name: m['name'],
    status: m['status'],
    ownerId: m['ownerId'] ?? null,
    targetStartDate: m['targetStartDate'] ?? null,
    targetEndDate: m['targetEndDate'] ?? null,
    progress: m['progress'] ?? null,
    artifacts,
    releases,
    projects,
  };
  if ([artifacts, releases, projects].some((ids) => ids.length >= MAX_LINKS))
    payload['truncated'] = true;
  return payload;
}

/**
 * `get_milestone` — one Milestone with its links (GET /v1/milestones/:id, `milestone:view` on
 * the milestone; then the :id/artifacts, :id/releases and :id/projects junction feeds, the same
 * permission, each a bare id array capped at 100 with `truncated`).
 */
export function registerGetMilestone(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_get_milestone',
    {
      title: 'Get milestone',
      description:
        'One Milestone by id with its linked artifacts (work item ids), releases and projects.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        milestoneId: z.uuid().describe('The Milestone id'),
      },
    },
    async ({ milestoneId }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: `/v1/milestones/${milestoneId}`,
      });
      if (statusCode >= 400 || json === null || typeof json !== 'object' || Array.isArray(json))
        return denied(statusCode, json);
      const m = json as Record<string, unknown>;

      // Each junction route answers a bare id array (string[]); anything else is a denial.
      const feed = async (
        url: string,
      ): Promise<{ denial?: ReturnType<typeof denied>; ids: string[] }> => {
        const res = await ctx.callRest(ctx.principal, { method: 'GET', url });
        if (res.statusCode >= 400 || !Array.isArray(res.json))
          return { denial: denied(res.statusCode, res.json), ids: [] };
        return { ids: (res.json as string[]).slice(0, MAX_LINKS) };
      };
      const artifacts = await feed(`/v1/milestones/${milestoneId}/artifacts`);
      if (artifacts.denial) return artifacts.denial;
      const releases = await feed(`/v1/milestones/${milestoneId}/releases`);
      if (releases.denial) return releases.denial;
      const projects = await feed(`/v1/milestones/${milestoneId}/projects`);
      if (projects.denial) return projects.denial;

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(shapeMilestone(m, artifacts.ids, releases.ids, projects.ids)),
          },
        ],
      };
    },
  );
}
