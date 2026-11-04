import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pathSegment, result, type ToolContext } from './rest';
import { failureResult, resolveProject } from './lookups';

type FeedResult = { rows: Record<string, unknown>[] | null; status: number };

/** The response shape, split out so a spec feeds rows parsed through the producer DTOs. */
export function buildVocabulary(
  project: { id: string; key: string; name: string },
  feeds: {
    statuses: Record<string, unknown>[] | null;
    transitions: Record<string, unknown>[] | null;
    labels: Record<string, unknown>[] | null;
    testCaseTypes: Record<string, unknown>[] | null;
    teams: Record<string, unknown>[] | null;
  },
): Record<string, unknown> {
  const unavailable: string[] = [];
  if (!feeds.statuses) unavailable.push('statuses');
  if (!feeds.transitions) unavailable.push('transitions');
  if (!feeds.labels) unavailable.push('labels');
  if (!feeds.testCaseTypes) unavailable.push('testCaseTypes');
  if (!feeds.teams) unavailable.push('teams');
  const payload: Record<string, unknown> = {
    project,
    statuses: (feeds.statuses ?? []).map((s) => ({
      id: s['id'],
      name: s['name'],
      category: s['category'],
      isDefault: s['isDefault'],
    })),
    transitions: (feeds.transitions ?? []).map((t) => ({
      fromStatusId: t['fromStatusId'] ?? null,
      toStatusId: t['toStatusId'],
      name: t['name'] ?? null,
      requiredRole: t['requiredRole'] ?? null,
    })),
    labels: (feeds.labels ?? []).map((l) => ({ id: l['id'], name: l['name'], color: l['color'] })),
    testCaseTypes: (feeds.testCaseTypes ?? []).map((t) => ({
      id: t['id'],
      name: t['name'],
      position: t['position'],
    })),
    teams: feeds.teams ?? [],
  };
  if (unavailable.length > 0) payload['unavailable'] = unavailable;
  return payload;
}

/**
 * `rova_project_vocabulary` — the reference data a write needs before it can name anything:
 * workflow statuses (and the allowed transitions), labels, test-case types and teams of one
 * project. Read-only; call it first, then use the names in a write tool.
 *
 * A feed the caller cannot read (e.g. test-case types without `test_case:view`) comes back as
 * `null` and is listed in `unavailable`: the rest of the vocabulary is still useful, and the
 * tool must not fail because one permission is missing. The PROJECT itself must be readable
 * (the picker list is the caller's readable set), or the tool refuses with candidates.
 */
export function registerProjectVocabulary(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_project_vocabulary',
    {
      title: 'Project vocabulary',
      description:
        'Statuses with their allowed transitions, labels, test-case types and teams of one project you can read — call this before writing to pick valid names.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        project: z.string().min(1).max(255).describe('Project key, exact name or id'),
      },
    },
    async ({ project }) => {
      const resolved = await resolveProject(ctx, project);
      if (!resolved.ok) return failureResult(resolved);
      const projectPath = pathSegment(resolved.id);

      const feed = async (url: string): Promise<FeedResult> => {
        const res = await ctx.callRest(ctx.principal, { method: 'GET', url });
        if (res.statusCode >= 400) return { rows: null, status: res.statusCode };
        const body = Array.isArray(res.json)
          ? res.json
          : (res.json as { data?: unknown } | null)?.data;
        return {
          rows: Array.isArray(body) ? (body as Record<string, unknown>[]) : null,
          status: res.statusCode,
        };
      };

      const [statuses, transitions, labels, testCaseTypes, teams] = await Promise.all([
        feed(`/v1/projects/${projectPath}/statuses`),
        feed(`/v1/projects/${projectPath}/transitions`),
        feed(`/v1/projects/${projectPath}/labels`),
        feed(`/v1/projects/${projectPath}/test-case-types`),
        feed(`/v1/projects/${projectPath}/teams`),
      ]);

      const payload = buildVocabulary(
        { id: resolved.id, key: resolved.key, name: resolved.name },
        {
          statuses: statuses.rows,
          transitions: transitions.rows,
          labels: labels.rows,
          testCaseTypes: testCaseTypes.rows,
          teams: teams.rows,
        },
      );
      return result(200, {}, payload);
    },
  );
}
