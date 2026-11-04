import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, pathSegment, result, type ToolContext } from './rest';
import { failureResult, resolveProject } from './lookups';

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

const SCAN_PAGES = 5;
const SCAN_SIZE = 100;

/**
 * `rova_project_activity` — what changed in a project (who, what, when), for stand-ups and
 * "since yesterday" questions.
 *
 * WITHOUT `since`: one page (`page`/`pageSize`), and `hasMore` says whether older rows exist.
 * WITH `since`: the route pages newest-first and has no time parameter, so the tool scans
 * newest-to-oldest itself — up to 5 pages of 100 rows — and stops at the first row older than
 * `since`. `truncated: true` means the 5×100 cap stopped the scan before that point (there may
 * be more matching rows); otherwise `hasMore` is false because the filtered window is complete.
 */
export function registerProjectActivity(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_project_activity',
    {
      title: 'Project activity',
      description:
        'The revision history of one project you can read: who changed what and when. Without `since` it returns one page; with `since` it scans newest-first up to 5×100 rows and sets `truncated` if the cap stopped before an older row.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        project: z.string().min(1).max(255).describe('Project key, exact name or id'),
        since: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe(
            'Only rows created at/after this ISO timestamp. The tool scans newest-first up to 5×100 rows; `truncated` means the cap stopped the scan.',
          ),
        page: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Page number (default 1); ignored when `since` is given'),
        pageSize: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Rows per page (default 25, max 100); ignored when `since` is given'),
      },
    },
    async ({ project, since, page, pageSize }) => {
      const resolved = await resolveProject(ctx, project);
      if (!resolved.ok) return failureResult(resolved);

      const projectRef = { id: resolved.id, key: resolved.key, name: resolved.name };
      const url = `/v1/projects/${pathSegment(resolved.id)}/activity`;

      if (!since) {
        const { statusCode, json } = await ctx.callRest(ctx.principal, {
          method: 'GET',
          url,
          query: { page: page ?? 1, pageSize: pageSize ?? 25 },
        });
        if (statusCode >= 400 || json === null || typeof json !== 'object') {
          return denied(statusCode, json);
        }
        return result(200, {}, shapeProjectActivity(projectRef, json, { page, pageSize }));
      }

      // `since` means "everything NEWER than this", and the route pages newest-first with no time
      // filter: follow pages until a row is older than `since` (or the history ends), capped at
      // 5 × 100 rows. The cap stopping first is reported as `truncated`, and only then can there
      // be more matching rows — `hasMore` describes the FILTERED window, not the raw feed.
      const sinceMs = Date.parse(since);
      const collected: Record<string, unknown>[] = [];
      let scannedPages = 0;
      let truncated = false;
      let olderSeen = false;
      for (let p = 1; p <= SCAN_PAGES; p += 1) {
        const res = await ctx.callRest(ctx.principal, {
          method: 'GET',
          url,
          query: { page: p, pageSize: SCAN_SIZE },
        });
        if (res.statusCode >= 400 || res.json === null || typeof res.json !== 'object') {
          return denied(res.statusCode, res.json);
        }
        scannedPages = p;
        const body = res.json as { data?: unknown; total?: unknown };
        const rows = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : [];
        for (const row of rows) {
          if (Date.parse(String(row['createdAt'])) < sinceMs) {
            olderSeen = true;
            break;
          }
          collected.push(row);
        }
        const total = typeof body.total === 'number' ? body.total : rows.length;
        const morePages = p * SCAN_SIZE < total;
        if (olderSeen || !morePages) break;
        if (p === SCAN_PAGES) truncated = true;
      }

      const shaped = shapeProjectActivity(
        projectRef,
        {
          data: collected,
          total: collected.length,
          page: 1,
          pageSize: Math.max(collected.length, 1),
        },
        { since },
      );
      shaped['scannedPages'] = scannedPages;
      shaped['hasMore'] = truncated;
      if (truncated) shaped['truncated'] = true;
      return result(200, {}, shaped);
    },
  );
}
