import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, result, toolError, type ToolContext } from './rest';
import { DELETE_KINDS, planDelete } from './delete_guard';

/**
 * `rova_delete` — delete ONE thing the caller owns, per §5 of the MCP v2 design.
 *
 * The guard in `delete_guard.ts` runs FIRST and narrows every kind (authorship, ownership, age,
 * dependants, iteration state). The REST route still enforces its own rules, so a bypass of the
 * guard reaches the same refusal the web would give, never a wider one.
 *
 * `reason` is echoed back to the model AND written to the audit line: the MCP v2 review asked for
 * the operator's stated reason to be recorded, and the audit allowlist bounds it at 500 characters.
 */
export function registerDelete(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_delete',
    {
      title: 'Delete one thing you own',
      description:
        "DELETES one thing as you, and must be used only on the user's explicit request. Kinds: your own comment (`key` = the work item or portfolio item, `id` = comment), your own time log (`key` = work item, `id` = log), a relation YOU created (`key` = work item, `id` = relation), a test result YOU recorded within 7 days (`key` = test case, e.g. TC-12, `id` = result), one task you created or own (`key` = task), or a story/defect you created in the last 24 hours with no tasks, test cases, time logs, others' comments, relations or committed/accepted iteration (`key` = story/defect). Anything with dependants is refused — tell the user to use the web. A retry of a delete that already landed answers `alreadyDeleted: true` instead of failing.",
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
          .describe('Why you are deleting it; echoed back and recorded in the audit log'),
      },
    },
    async (args) => {
      const plan = await planDelete(ctx, {
        kind: args.kind,
        ...(args.key !== undefined ? { key: args.key } : {}),
        ...(args.id !== undefined ? { id: args.id } : {}),
      });
      if (!plan.ok) {
        if (plan.targetMissing) {
          // A retry of the same request after the delete landed. The caller is authenticated and
          // the TARGET no longer resolves; that is the same 404 a stranger's key gets, so the
          // answer reveals nothing about whether the row ever existed or who owned it.
          ctx.noteWrite?.({
            targets: [],
            fields: [args.kind],
            count: 0,
            ...(args.reason !== undefined ? { reason: args.reason } : {}),
          });
          return result(
            200,
            {},
            {
              deleted: {
                kind: args.kind,
                ...(args.key !== undefined ? { subject: args.key } : {}),
                ...(args.id !== undefined ? { id: args.id } : {}),
              },
              alreadyDeleted: true,
              ...(args.reason !== undefined ? { reason: args.reason } : {}),
            },
          );
        }
        if ('statusCode' in plan) return denied(plan.statusCode, plan.json);
        return toolError(plan.message);
      }

      const res = await ctx.callRest(ctx.principal, { method: 'DELETE', url: plan.path });
      if (res.statusCode >= 400) return denied(res.statusCode, res.json);

      ctx.noteWrite?.({
        targets: [plan.targetId],
        fields: [plan.kind],
        count: 1,
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      });
      return result(res.statusCode, res.json, {
        deleted: {
          kind: plan.kind,
          id: plan.targetId,
          subject: plan.subject,
          ...(plan.warning ? { warning: plan.warning } : {}),
        },
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      });
    },
  );
}
