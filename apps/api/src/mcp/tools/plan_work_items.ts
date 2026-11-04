import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, result, toolError, type ToolContext } from './rest';
import {
  failureResult,
  resolveIteration,
  resolveProject,
  resolveRelease,
  resolveWorkItem,
  type ResolvedTimebox,
  type ResolvedWorkItem,
} from './lookups';

/** The batch limit (design §6.5): the REST route allows 500, an agent turn does not. */
const MAX_ITEMS = 25;

function shapePreviewItem(
  item: ResolvedWorkItem,
  target: 'iteration' | 'release',
): Record<string, unknown> {
  const from = target === 'iteration' ? item.iterationId : item.releaseId;
  return {
    id: item.id,
    itemKey: item.itemKey,
    title: item.title,
    type: item.type,
    from: from ? { id: from } : null,
    // Only stories and defects can be scheduled into an iteration; release accepts any type.
    eligible: target === 'release' || item.type === 'story' || item.type === 'defect',
  };
}

/** The POST/PATCH body the two bulk routes share. */
function bulkBody(
  projectId: string,
  itemIds: string[],
  target: { iterationId: string | null } | { releaseId: string | null },
): Record<string, unknown> {
  return { projectId, itemIds, ...target };
}

/**
 * `rova_plan_work_items` — move up to 25 stories/defects into an iteration or a release, or
 * back to the backlog (W4). **Default is a DRY RUN**: it reads the items and the target and
 * answers what WOULD move plus the warnings, and writes nothing. The user agrees, then the
 * tool is called again with `dryRun: false`.
 *
 * The real write is ONE call to `PATCH /v1/work-items/bulk-iteration` or `/bulk-release`, which
 * owns every rule — the project, each item's scope, the iteration's team/project, the release
 * field guard (`release:view`), the story-only Manual Move rows and the iteration auto-accept.
 *
 * FAN-OUT: there is no batch GET for work items, so the preview resolves each key with one read.
 * The 25-item cap bounds that to 25 reads per call (the shared per-person DEFAULT budget is
 * 600/min), and the real write costs one request.
 */
export function registerPlanWorkItems(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_plan_work_items',
    {
      title: 'Plan work items',
      description:
        "WRITES an iteration or release assignment for up to 25 stories/defects, and must be used only on the user's explicit request. It is a DRY RUN by default: it lists what would move and warns about refusals without writing. Show the user that preview, then call again with dryRun: false only after they agree. Pass exactly one of iteration or release; null means back to the backlog.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        project: z.string().min(1).max(255).describe('Project key, exact name or id'),
        itemKeys: z
          .array(z.string().min(1).max(64))
          .min(1)
          .max(MAX_ITEMS)
          .describe(
            `Work item keys or ids (at most ${MAX_ITEMS}; each one costs one read in the preview)`,
          ),
        iteration: z
          .string()
          .min(1)
          .max(255)
          .nullable()
          .optional()
          .describe('Target iteration by name or key; null moves to the backlog'),
        release: z
          .string()
          .min(1)
          .max(255)
          .nullable()
          .optional()
          .describe('Target release by name or key; null clears the release'),
        dryRun: z
          .boolean()
          .default(true)
          .describe('true (default) previews only; false performs the move'),
      },
    },
    async ({ project, itemKeys, iteration, release, dryRun }) => {
      if ((iteration === undefined) === (release === undefined)) {
        return toolError('Pass exactly one of iteration or release (null clears it).');
      }

      const resolvedProject = await resolveProject(ctx, project);
      if (!resolvedProject.ok) return failureResult(resolvedProject);

      // Every item must resolve, be readable and sit in the named project: the bulk route is
      // all-or-nothing and refuses a mixed selection, so the preview must refuse it too.
      const items: ResolvedWorkItem[] = [];
      const seen = new Set<string>();
      for (const reference of itemKeys) {
        const item = await resolveWorkItem(ctx, reference);
        if (!item.ok) return failureResult(item);
        if (item.projectId !== resolvedProject.id) {
          return toolError(
            `"${reference}" belongs to another project; every item in one plan must be in ${resolvedProject.key}.`,
          );
        }
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
      }

      const target: 'iteration' | 'release' = iteration !== undefined ? 'iteration' : 'release';
      let timebox: ResolvedTimebox | null = null;
      const reference = target === 'iteration' ? iteration : release;
      if (typeof reference === 'string') {
        const resolved =
          target === 'iteration'
            ? await resolveIteration(ctx, resolvedProject.id, reference)
            : await resolveRelease(ctx, resolvedProject.id, reference);
        if (!resolved.ok) return failureResult(resolved);
        timebox = resolved;
      }

      const warnings: string[] = [];
      if (target === 'iteration') {
        const ineligible = items.filter((item) => item.type !== 'story' && item.type !== 'defect');
        if (ineligible.length > 0) {
          warnings.push(
            `Only stories and defects can be scheduled into an iteration; refused: ${ineligible
              .map((item) => item.itemKey)
              .join(', ')}. The whole call would fail.`,
          );
        }
        if (timebox?.state === 'committed') {
          warnings.push(
            'The target iteration is COMMITTED; these items will join a committed sprint.',
          );
        }
        if (timebox?.state === 'accepted') {
          warnings.push('The target iteration is ACCEPTED; the server may refuse assignment.');
        }
      }

      const preview = {
        project: { id: resolvedProject.id, key: resolvedProject.key, name: resolvedProject.name },
        target:
          target === 'iteration'
            ? {
                kind: 'iteration',
                id: timebox?.id ?? null,
                name: timebox?.name ?? null,
                state: timebox?.state ?? null,
              }
            : {
                kind: 'release',
                id: timebox?.id ?? null,
                name: timebox?.name ?? null,
                state: timebox?.state ?? null,
              },
        items: items.map((item) => shapePreviewItem(item, target)),
        warnings,
      };

      // `!== false`, not truthiness: the schema's default covers a client that omits it, and a
      // direct caller must get the same DRY RUN — anything but an explicit `false` previews only.
      if (dryRun !== false) {
        // NOTHING is written on this path: the preview is composed entirely from reads.
        return result(200, preview, {
          dryRun: true,
          ...preview,
          wouldChange: items.length,
        });
      }

      const url =
        target === 'iteration' ? '/v1/work-items/bulk-iteration' : '/v1/work-items/bulk-release';
      const body = bulkBody(
        resolvedProject.id,
        items.map((item) => item.id),
        target === 'iteration'
          ? { iterationId: timebox?.id ?? null }
          : { releaseId: timebox?.id ?? null },
      );
      ctx.noteWrite?.({
        targets: items.map((item) => item.id),
        fields: [`${target}Id`],
        count: items.length,
        dryRun: false,
      });
      const res = await ctx.callRest(ctx.principal, {
        method: 'PATCH',
        url,
        body,
        // Keyed on the RESOLVED selection and target: a retried bulk move replays instead of
        // running twice (the route is `@UseIdempotency`).
        idempotencyKey: ctx.idempotencyKey?.('rova_plan_work_items', {
          projectId: resolvedProject.id,
          itemIds: [...items.map((item) => item.id)].sort(),
          iterationId: target === 'iteration' ? (timebox?.id ?? null) : null,
          releaseId: target === 'release' ? (timebox?.id ?? null) : null,
        }),
      });
      if (res.statusCode >= 400) return denied(res.statusCode, res.json);
      // The contract answers `{ updated }`; a 2xx without it is contract drift, NOT success —
      // reporting `items.length` would claim moves that may not have happened.
      const updated =
        res.json && typeof res.json === 'object'
          ? (res.json as { updated?: unknown }).updated
          : undefined;
      if (typeof updated !== 'number' || !Number.isFinite(updated)) {
        return toolError(
          'The bulk route answered without an `updated` count; nothing is reported as moved. Re-read the items before retrying.',
        );
      }
      return result(res.statusCode, res.json, {
        dryRun: false,
        ...preview,
        updated,
        changed: [`${target}Id`],
      });
    },
  );
}
