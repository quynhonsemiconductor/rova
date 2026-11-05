import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pathSegment, replayedFrom, toolError, type ToolContext } from './rest';
import { failureResult, resolvePeople, resolveWorkItem } from './lookups';
import { workItemWriteResult } from './work_item_write';

/**
 * `rova_add_task` — add a child task under a story or defect (W3). Wraps
 * `POST /v1/work-items/:id/tasks`, which carries the parent's project and team scope, derives
 * the task's iteration from the parent (a task owns none) and reconciles the parent's Schedule
 * State — none of that is re-implemented here.
 */
export function registerAddTask(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_add_task',
    {
      title: 'Add task',
      description:
        "WRITES a task under a story or defect as you, and must be used only on the user's explicit request. The task inherits its iteration from the parent; `parentKey` is the work item key (e.g. US-412) or id. DUPLICATES: a create is deduplicated ONLY by `requestId` — generate one per user request and reuse the SAME value when retrying that request; without one a retry may create a duplicate. A reused `requestId` replays the first record for 24 h; during a Valkey outage a retry may create a duplicate.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        requestId: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe(
            'A create-only retry guard: generate once per user request and reuse the SAME value when retrying that request. A repeat with the same id returns the first record; omit it and a retry may create a duplicate.',
          ),
        parentKey: z.string().min(1).max(64).describe('The parent story/defect key or id'),
        title: z.string().min(1).max(500).describe('The task title'),
        description: z.string().max(50_000).optional(),
        state: z
          .enum(['defined', 'in_progress', 'completed'])
          .optional()
          .describe('Task state (defaults to defined)'),
        assignee: z.string().min(1).max(255).optional().describe('Owner by display name or email'),
        devOwner: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe('Dev Owner by display name or email'),
        estimateHours: z.number().min(0).max(1000).optional(),
        todoHours: z.number().min(0).max(1000).optional(),
      },
    },
    async (args) => {
      const parent = await resolveWorkItem(ctx, args.parentKey);
      if (!parent.ok) return failureResult(parent);
      if (parent.type !== 'story' && parent.type !== 'defect') {
        return toolError(
          `"${args.parentKey}" is a ${parent.type}; a task can only be added under a story or defect.`,
        );
      }
      if (!ctx.clientIdempotencyKey) return toolError('Writes are not enabled on this endpoint.');

      const body: Record<string, unknown> = { title: args.title };
      if (args.description !== undefined) body['description'] = args.description;
      if (args.state !== undefined) body['state'] = args.state;
      // The candidate feed is row-scoped, and a task's Team defaults to its parent's (SRS P1-04),
      // so that is the Team the write will validate against.
      if (args.assignee !== undefined) {
        const people = await resolvePeople(ctx, parent.projectId, [args.assignee], {
          teamId: parent.teamId,
        });
        if (!people.ok) return failureResult(people);
        body['assigneeId'] = people.ids[0];
      }
      if (args.devOwner !== undefined) {
        const people = await resolvePeople(ctx, parent.projectId, [args.devOwner], {
          teamId: parent.teamId,
        });
        if (!people.ok) return failureResult(people);
        body['devOwnerId'] = people.ids[0];
      }
      if (args.estimateHours !== undefined) body['estimateHours'] = args.estimateHours;
      if (args.todoHours !== undefined) body['todoHours'] = args.todoHours;

      const idempotencyKey =
        args.requestId !== undefined
          ? ctx.clientIdempotencyKey('rova_add_task', { requestId: args.requestId })
          : undefined;
      const res = await ctx.callRest(ctx.principal, {
        method: 'POST',
        url: `/v1/work-items/${pathSegment(parent.id)}/tasks`,
        body,
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      });
      const createdId = (res.json as Record<string, unknown>)['id'];
      ctx.noteWrite?.({
        targets: [parent.id, ...(typeof createdId === 'string' ? [createdId] : [])],
        fields: Object.keys(body).filter((field) => field !== 'title'),
        count: 1,
      });
      return workItemWriteResult(
        res,
        Object.keys(body).filter((field) => field !== 'title'),
        { replayed: replayedFrom(res) },
      );
    },
  );
}
