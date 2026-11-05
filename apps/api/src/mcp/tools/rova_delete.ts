import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, pathSegment, result, toolError, type ToolContext } from './rest';
import { DELETE_KINDS, planDelete } from './delete_guard';

/**
 * `rova_delete` — delete ONE thing the caller owns, per §5 of the MCP v2 design.
 *
 * The guard in `delete_guard.ts` runs FIRST and narrows every kind (authorship, ownership,
 * dependants). The REST route still enforces its own rules, so a bypass of the guard reaches the
 * same refusal the web would give, never a wider one.
 *
 * `reason` is echoed back to the caller only. It never reaches the audit line (free text may carry
 * personal data); the audit records its LENGTH, which is enough to show a justification was given.
 */
export function registerDelete(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_delete',
    {
      title: 'Delete one thing you own',
      description:
        "DELETES one thing as you, and must be used only on the user's explicit request. Kinds: your own comment (`key` = the work item or portfolio item, `id` = comment), your own time log (`key` = work item, `id` = log), a relation YOU created (`key` = work item, `id` = relation), a test result YOU recorded within 7 days (`key` = test case, e.g. TC-12, `id` = result), or one task you created or own (`key` = task). Deleting a whole story or defect is NOT supported; tell the user to use the web for that. Anything with dependants on a task is refused. A retry of a delete that already landed answers the generic 'not found or not yours'; absence is never reported as 'already deleted', because an id may simply belong to another item.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        kind: z.enum(DELETE_KINDS).describe('What to delete'),
        key: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe('The subject key: work item, portfolio item, or test case (TC-12)'),
        id: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe('The record id for comment, time_log, relation and test_result'),
        reason: z
          .string()
          .max(500)
          .optional()
          .describe('Why you are deleting it; echoed back to you, not written to the audit log'),
      },
    },
    async (args) => {
      const plan = await planDelete(ctx, {
        kind: args.kind,
        ...(args.key !== undefined ? { key: args.key } : {}),
        ...(args.id !== undefined ? { id: args.id } : {}),
      });
      if (!plan.ok) {
        if ('statusCode' in plan) return denied(plan.statusCode, plan.json);
        return toolError(plan.message);
      }

      // Read the parent BEFORE the delete, then again after it: `parentAutoCompleted` means the
      // not-completed -> completed TRANSITION this delete caused, not "the parent is completed".
      // A scope-hidden sibling cannot make this a prediction because both sides are stored reads.
      const parentBefore =
        plan.kind === 'task' && plan.parentId !== undefined
          ? await parentIsCompleted(ctx, plan.parentId)
          : undefined;
      const res = await ctx.callRest(ctx.principal, { method: 'DELETE', url: plan.path });
      if (res.statusCode >= 400) return denied(res.statusCode, res.json);

      const parentAfter =
        plan.kind === 'task' && plan.parentId !== undefined
          ? await parentIsCompleted(ctx, plan.parentId)
          : undefined;
      const parentAutoCompleted = parentBefore === false && parentAfter === true;

      ctx.noteWrite?.({
        targets: [plan.targetId],
        fields: [plan.kind],
        count: 1,
        ...(args.reason !== undefined ? { reasonLength: args.reason.length } : {}),
      });
      return result(res.statusCode, res.json, {
        deleted: {
          kind: plan.kind,
          id: plan.targetId,
          subject: plan.subject,
        },
        ...(parentAutoCompleted ? { parentAutoCompleted: true } : {}),
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      });
    },
  );
}

/**
 * The parent's stored schedule state at one moment: `undefined` when the read failed, so an
 * uncompleted-before result can never be inferred from a failed read.
 */
async function parentIsCompleted(ctx: ToolContext, parentId: string): Promise<boolean | undefined> {
  const res = await ctx.callRest(ctx.principal, {
    method: 'GET',
    url: `/v1/work-items/${pathSegment(parentId)}`,
  });
  if (res.statusCode >= 400) return undefined;
  const body = res.json as Record<string, unknown> | null;
  const item = (body?.['item'] as Record<string, unknown> | undefined) ?? body;
  return item?.['scheduleState'] === 'completed';
}
