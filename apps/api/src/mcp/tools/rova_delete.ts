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
 * `reason` is echoed back to the model and is deliberately NOT sent to the audit line: free text
 * from a model must never enter telemetry.
 */
export function registerDelete(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_delete',
    {
      title: 'Delete one thing you own',
      description:
        "DELETES one thing as you, and must be used only on the user's explicit request. Kinds: your own comment (`key` = the work item or portfolio item, `id` = comment), your own time log (`key` = work item, `id` = log), a relation link (`key` = work item, `id` = relation), a test result you recorded within 7 days (`key` = test case, e.g. TC-12, `id` = result), one task you created or own (`key` = task), or a story/defect you created in the last 24 hours with no tasks, test cases, time logs, others' comments, relations or committed/accepted iteration (`key` = story/defect). Anything with dependants is refused — tell the user to use the web.",
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
          .describe(
            'Why you are deleting it; echoed back to the user, never written to the audit log',
          ),
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

      const res = await ctx.callRest(ctx.principal, { method: 'DELETE', url: plan.path });
      if (res.statusCode >= 400) return denied(res.statusCode, res.json);

      ctx.noteWrite?.({ targets: [plan.targetId], fields: [plan.kind], count: 1 });
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
