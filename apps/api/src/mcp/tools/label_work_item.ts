import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, pathSegment, result, toolError, type ToolContext } from './rest';
import {
  failureResult,
  matchLabel,
  resolveLabelCatalogue,
  resolveWorkItem,
  type ResolvedLabel,
} from './lookups';

/**
 * `rova_label_work_item` — add/remove EXISTING project labels on one work item (W6).
 *
 * Labels are project reference data: this tool never creates one (that is project
 * configuration, in the web). It reads the project's label catalogue ONCE, resolves every name
 * the user said against that answer, then applies each with
 * `POST`/`DELETE /v1/work-items/:id/labels[/:labelId]`. Both routes are idempotent (a repeated
 * add is a no-op row, a repeated remove deletes nothing), and the answer is the item's label
 * list AFTER the change, read back from the app.
 */
export function registerLabelWorkItem(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_label_work_item',
    {
      title: 'Label work item',
      description:
        "WRITES label assignments on one work item as you, and must be used only on the user's explicit request. `add`/`remove` name EXISTING labels of the item's project (this does not create labels); a name that matches nothing comes back with the project's labels as candidates. A write that fails part-way answers `applied` and `notApplied` rather than pretending the whole call failed.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        key: z.string().min(1).max(64).describe('The work item key (e.g. US-412) or id'),
        add: z
          .array(z.string().min(1).max(255))
          .max(10)
          .optional()
          .describe('Label names to add (at most 10)'),
        remove: z
          .array(z.string().min(1).max(255))
          .max(10)
          .optional()
          .describe('Label names to remove (at most 10)'),
      },
    },
    async ({ key, add, remove }) => {
      const addNames = add ?? [];
      const removeNames = remove ?? [];
      if (addNames.length === 0 && removeNames.length === 0) {
        return toolError('Pass at least one label in add or remove.');
      }

      const item = await resolveWorkItem(ctx, key);
      if (!item.ok) return failureResult(item);

      // ONE catalogue read for the whole call, however many labels were named.
      const catalogue = await resolveLabelCatalogue(ctx, item.projectId);
      if (!catalogue.ok) return failureResult(catalogue);

      /** Resolve names against the ONE catalogue; an unknown/ambiguous name refuses the call. */
      const resolveAll = (names: string[]): ResolvedLabel[] | ReturnType<typeof failureResult> => {
        const seen = new Set<string>();
        const resolved: ResolvedLabel[] = [];
        for (const name of names) {
          const label = matchLabel(catalogue.labels, name);
          if (!label.ok) return failureResult(label);
          if (seen.has(label.id)) continue;
          seen.add(label.id);
          resolved.push(label);
        }
        return resolved;
      };
      const toAdd = resolveAll(addNames);
      if (!Array.isArray(toAdd)) return toAdd;
      const toRemove = resolveAll(removeNames);
      if (!Array.isArray(toRemove)) return toRemove;

      const applied: { name: string; action: 'add' | 'remove' }[] = [];
      const notApplied: { name: string; action: 'add' | 'remove' }[] = [];
      let firstFailure: unknown;

      const apply = async (label: ResolvedLabel, action: 'add' | 'remove'): Promise<boolean> => {
        const res =
          action === 'add'
            ? await ctx.callRest(ctx.principal, {
                method: 'POST',
                url: `/v1/work-items/${pathSegment(item.id)}/labels`,
                body: { labelId: label.id },
                // NO idempotency key: the add is `onConflictDoNothing` server-side, so a repeat
                // is a 204 no-op — and a replay would swallow add -> remove -> add.
              })
            : await ctx.callRest(ctx.principal, {
                method: 'DELETE',
                url: `/v1/work-items/${pathSegment(item.id)}/labels/${pathSegment(label.id)}`,
              });
        if (res.statusCode >= 400) {
          firstFailure = { action, label: label.name, statusCode: res.statusCode, error: res.json };
          return false;
        }
        return true;
      };

      for (const label of toAdd) {
        if (await apply(label, 'add')) applied.push({ name: label.name, action: 'add' });
        else notApplied.push({ name: label.name, action: 'add' });
      }
      // A failed add does not stop the removals: this is a set of independent assignments.
      for (const label of toRemove) {
        if (await apply(label, 'remove')) applied.push({ name: label.name, action: 'remove' });
        else notApplied.push({ name: label.name, action: 'remove' });
      }

      ctx.noteWrite?.({
        targets: [item.id],
        fields: applied.map((entry) => `label:${entry.action}`),
        count: applied.length,
      });

      // The post-write record: the item's labels as the app now holds them. A read that fails is
      // an ERROR — reporting `[]` would claim the item has no labels.
      const labelsRes = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: `/v1/work-items/${pathSegment(item.id)}/labels`,
      });
      if (labelsRes.statusCode >= 400 || !Array.isArray(labelsRes.json)) {
        return denied(labelsRes.statusCode, labelsRes.json);
      }
      const labels = (labelsRes.json as Record<string, unknown>[]).map((row) => ({
        id: row['id'],
        name: row['name'],
        color: row['color'],
      }));

      const added = applied.filter((e) => e.action === 'add').map((e) => e.name);
      const removed = applied.filter((e) => e.action === 'remove').map((e) => e.name);
      if (notApplied.length > 0) {
        // PARTIAL success, stated: the applied assignments ARE in place; the caller can retry the
        // rest with the same call.
        return result(200, labelsRes.json, {
          workItem: { id: item.id, itemKey: item.itemKey },
          partial: true,
          applied,
          notApplied,
          failure: firstFailure,
          labels,
          added,
          removed,
          changed: [
            ...added.map((name) => `label:${name}`),
            ...removed.map((name) => `label:-${name}`),
          ],
        });
      }

      return result(labelsRes.statusCode, labelsRes.json, {
        workItem: { id: item.id, itemKey: item.itemKey },
        labels,
        applied,
        notApplied,
        added,
        removed,
        changed: [
          ...added.map((name) => `label:${name}`),
          ...removed.map((name) => `label:-${name}`),
        ],
      });
    },
  );
}
