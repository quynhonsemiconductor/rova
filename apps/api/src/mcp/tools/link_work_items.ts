import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, pathSegment, result, toolError, type ToolContext } from './rest';
import { failureResult, resolveWorkItem } from './lookups';

const RELATION_TYPES = ['blocks', 'duplicates', 'relates_to', 'depends_on'] as const;

/** The relation view the REST route answers (`WorkItemRelationView`), cut to what a model uses. */
function shapeRelation(row: Record<string, unknown>) {
  const related = (row['relatedItem'] as Record<string, unknown> | undefined) ?? {};
  return {
    id: row['id'],
    relationType: row['relationType'],
    direction: row['direction'],
    label: row['label'],
    relatedItem: {
      id: related['id'],
      itemKey: related['itemKey'],
      title: related['title'],
      type: related['type'],
      scheduleState: related['scheduleState'],
    },
    createdAt: row['createdAt'],
  };
}

/**
 * `rova_link_work_items` — link two work items (W5). Wraps
 * `POST /v1/work-items/:id/relations`, which owns every rule: no self-link, the target must be
 * readable, a duplicate (either direction) is refused, and ordering relations (`blocks`,
 * `depends_on`) may not create a cycle. Cross-project links are legal when both ends are readable.
 */
export function registerLinkWorkItems(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_link_work_items',
    {
      title: 'Link work items',
      description:
        "WRITES a relation between two work items as you (blocks | duplicates | relates_to | depends_on), and must be used only on the user's explicit request. `from` owns the link (edit is checked there); a duplicate or cyclic ordering relation comes back as an error — do not invent another type.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        fromKey: z.string().min(1).max(64).describe('The linking item: key (e.g. US-412) or id'),
        toKey: z.string().min(1).max(64).describe('The item being linked TO: key or id'),
        relationType: z
          .enum(RELATION_TYPES)
          .describe('blocks | duplicates | relates_to | depends_on'),
      },
    },
    async ({ fromKey, toKey, relationType }) => {
      const from = await resolveWorkItem(ctx, fromKey);
      if (!from.ok) return failureResult(from);
      const to = await resolveWorkItem(ctx, toKey);
      if (!to.ok) return failureResult(to);
      if (!ctx.idempotencyKey) return toolError('Writes are not enabled on this endpoint.');

      const res = await ctx.callRest(ctx.principal, {
        method: 'POST',
        url: `/v1/work-items/${pathSegment(from.id)}/relations`,
        body: { targetId: to.id, relationType },
        idempotencyKey: ctx.idempotencyKey('rova_link_work_items', {
          fromKey,
          toKey,
          relationType,
        }),
      });
      if (res.statusCode >= 400 || !Array.isArray(res.json)) {
        return denied(res.statusCode, res.json);
      }
      return result(res.statusCode, res.json, {
        from: { id: from.id, itemKey: from.itemKey },
        to: { id: to.id, itemKey: to.itemKey },
        relationType,
        relations: (res.json as Record<string, unknown>[]).map(shapeRelation),
        changed: ['relation'],
      });
    },
  );
}
