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

      const endpoints = {
        from: { id: from.id, itemKey: from.itemKey },
        to: { id: to.id, itemKey: to.itemKey },
      };
      const res = await ctx.callRest(ctx.principal, {
        method: 'POST',
        url: `/v1/work-items/${pathSegment(from.id)}/relations`,
        body: { targetId: to.id, relationType },
        // Keyed on the RESOLVED endpoints: `US-1` and the same item's uuid are one operation, and
        // a model retry inside the 10-minute window replays the first relation instead of asking
        // the server for a duplicate.
        idempotencyKey: ctx.idempotencyKey('rova_link_work_items', {
          fromId: from.id,
          toId: to.id,
          relationType,
        }),
      });
      if (res.statusCode >= 400) {
        // An EXISTING link is the outcome the caller asked for. The idempotency replay covers a
        // retry of the same call; this covers the same link reached with a different request
        // (another endpoint spelling, or after the key's window), which the server refuses as
        // WORK_ITEM_RELATION_EXISTS.
        const envelope = res.json as { error?: { code?: unknown } } | null;
        if (envelope?.error?.code === 'WORK_ITEM_RELATION_EXISTS') {
          ctx.noteWrite?.({ targets: [from.id, to.id], fields: ['relation'] });
          return result(200, res.json, {
            ...endpoints,
            relationType,
            alreadyLinked: true,
            changed: [],
          });
        }
        return denied(res.statusCode, res.json);
      }
      ctx.noteWrite?.({ targets: [from.id, to.id], fields: ['relation'] });
      // A 2xx is the write succeeding; the relation LIST is decoration on it, so contract drift
      // in the body is not reported as a failed link.
      return result(res.statusCode, res.json, {
        ...endpoints,
        relationType,
        relations: Array.isArray(res.json)
          ? (res.json as Record<string, unknown>[]).map(shapeRelation)
          : undefined,
        changed: ['relation'],
      });
    },
  );
}
