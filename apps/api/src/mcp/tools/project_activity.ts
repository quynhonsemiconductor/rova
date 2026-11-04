import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, result, toolError, type ToolContext } from './rest';
import { resolveProject } from './lookups';

/** The tool payload; pure so a spec can feed rows parsed through ActivityResponseSchema. */
export function shapeProjectActivity(
  project: { id: string; key: string; name: string },
  body: { data?: unknown; total?: unknown; page?: unknown; pageSize?: unknown },
  amount: { since?: string; page?: number; pageSize?: number },
): Record<string, unknown> {
  const rows = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : [];
  const sinceMs = amount.since ? Date.parse(amount.since) : undefined;
  const filtered =
    sinceMs === undefined
      ? rows
      : rows.filter((r) => Date.parse(String(r['createdAt'])) >= sinceMs);
  const page = typeof body.page === 'number' ? body.page : (amount.page ?? 1);
  const pageSize = typeof body.pageSize === 'number' ? body.pageSize : (amount.pageSize ?? 25);
  const total = typeof body.total === 'number' ? body.total : rows.length;
  return {
    project,
    activity: filtered.map((row) => ({
      id: row['id'],
      createdAt: row['createdAt'],
      actorName: row['actorName'] ?? null,
      action: row['action'],
      entityType: row['entityType'],
      entityId: row['entityId'],
      changes: row['changes'] ?? null,
    })),
    page,
    pageSize,
    total,
    hasMore: page * pageSize < total,
    ...(amount.since ? { since: amount.since } : {}),
  };
}

/**
 * `rova_project_activity` — what changed in a project (who, what, when), for stand-ups and
 * "since yesterday" questions. The route pages by page/pageSize; `since` filters the rows of
 * the returned page (the route has no time parameter), so a `hasMore` page may contain older
 * rows — re-ask with a bigger page size when the filter leaves too few.
 */
export function registerProjectActivity(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_project_activity',
    {
      title: 'Project activity',
      description:
        'The revision history of one project you can read: who changed what and when. Page-based; `since` filters within the returned page.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        project: z.string().min(1).max(255).describe('Project key, exact name or id'),
        since: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe('Only rows created at/after this ISO timestamp (applies to this page)'),
        page: z.number().int().min(1).optional().describe('Page number (default 1)'),
        pageSize: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Rows per page (default 25, max 100)'),
      },
    },
    async ({ project, since, page, pageSize }) => {
      const resolved = await resolveProject(ctx, project);
      if (!resolved.ok) return toolError(resolved.message);

      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: `/v1/projects/${resolved.id}/activity`,
        query: { page: page ?? 1, pageSize: pageSize ?? 25 },
      });
      if (statusCode >= 400 || json === null || typeof json !== 'object') {
        return denied(statusCode, json);
      }
      return result(
        200,
        {},
        shapeProjectActivity({ id: resolved.id, key: resolved.key, name: resolved.name }, json, {
          since,
          page,
          pageSize,
        }),
      );
    },
  );
}
