import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, pathSegment, result, toolError, type ToolContext } from './rest';
import { failureResult, resolveLabel, resolveWorkItem, type ResolvedLabel } from './lookups';

/**
 * `rova_label_work_item` — add/remove EXISTING project labels on one work item (W6).
 *
 * Labels are project reference data: this tool never creates one (that is project
 * configuration, in the web), it resolves the names the user said against the item's own
 * project and applies each with `POST`/`DELETE /v1/work-items/:id/labels[/:labelId]`. Both
 * routes are idempotent (a repeated add is a no-op row, a repeated remove deletes nothing), and
 * the answer is the item's label list AFTER the change, read back from the app.
 */
export function registerLabelWorkItem(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_label_work_item',
    {
      title: 'Label work item',
      description:
        "WRITES label assignments on one work item as you, and must be used only on the user's explicit request. `add`/`remove` name EXISTING labels of the item's project (this does not create labels); a name that matches nothing comes back with the project's labels as candidates.",
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

      /** Resolve names ONCE each; an unknown or ambiguous name refuses the whole call. */
      const resolveAll = async (
        names: string[],
      ): Promise<ResolvedLabel[] | ReturnType<typeof failureResult>> => {
        const seen = new Set<string>();
        const resolved: ResolvedLabel[] = [];
        for (const name of names) {
          const label = await resolveLabel(ctx, item.projectId, name);
          if (!label.ok) return failureResult(label);
          if (seen.has(label.id)) continue;
          seen.add(label.id);
          resolved.push(label);
        }
        return resolved;
      };
      const toAdd = await resolveAll(addNames);
      if (!Array.isArray(toAdd)) return toAdd;
      const toRemove = await resolveAll(removeNames);
      if (!Array.isArray(toRemove)) return toRemove;

      if (!ctx.idempotencyKey) return toolError('Writes are not enabled on this endpoint.');

      for (const label of toAdd) {
        const res = await ctx.callRest(ctx.principal, {
          method: 'POST',
          url: `/v1/work-items/${pathSegment(item.id)}/labels`,
          body: { labelId: label.id },
          idempotencyKey: ctx.idempotencyKey('rova_label_work_item', { key, labelId: label.id }),
        });
        if (res.statusCode >= 400) return denied(res.statusCode, res.json);
      }
      for (const label of toRemove) {
        const res = await ctx.callRest(ctx.principal, {
          method: 'DELETE',
          url: `/v1/work-items/${pathSegment(item.id)}/labels/${pathSegment(label.id)}`,
        });
        if (res.statusCode >= 400) return denied(res.statusCode, res.json);
      }

      // The post-write record: the item's labels as the app now holds them.
      const labelsRes = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: `/v1/work-items/${pathSegment(item.id)}/labels`,
      });
      const labels = Array.isArray(labelsRes.json)
        ? (labelsRes.json as Record<string, unknown>[]).map((row) => ({
            id: row['id'],
            name: row['name'],
            color: row['color'],
          }))
        : [];

      return result(labelsRes.statusCode, labelsRes.json, {
        workItem: { id: item.id, itemKey: item.itemKey },
        labels,
        added: toAdd.map((label) => label.name),
        removed: toRemove.map((label) => label.name),
        changed: [
          ...toAdd.map((label) => `label:${label.name}`),
          ...toRemove.map((label) => `label:-${label.name}`),
        ],
      });
    },
  );
}
