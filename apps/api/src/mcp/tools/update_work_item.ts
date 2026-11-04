import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pathSegment, toolError, type ToolContext } from './rest';
import {
  failureResult,
  resolvePeople,
  resolvePortfolioItem,
  resolveIteration,
  resolveRelease,
  resolveStatus,
  resolveTeam,
  resolveWorkItem,
} from './lookups';
import { staleWorkItemResult, workItemWriteResult } from './work_item_write';

/** The REST concurrency refusal this tool turns into "here is the fresh item". */
function isStale(res: { statusCode: number; json: unknown }): boolean {
  if (res.statusCode !== 412) return false;
  const envelope = res.json as { error?: { code?: unknown } } | null;
  return envelope?.error?.code === 'WORK_ITEM_STALE';
}

const nullableRef = (description: string) =>
  z
    .string()
    .min(1)
    .max(255)
    .nullable()
    .optional()
    .describe(`${description}; pass null to unassign`);

/**
 * `rova_update_work_item` — change fields of a story, defect or task (W2).
 *
 * Status changes go through `PATCH /v1/work-items/:id` with the status resolved by NAME: the
 * server checks the project's workflow transition, the defect state machine and the schedule
 * mirror, and refuses what the web would — the tool never picks a different status on its own.
 *
 * Concurrency: the tool reads the item first and sends that read's ETag-derived version as
 * `If-Match`, so the write is compared in the UPDATE. A 412 `WORK_ITEM_STALE` comes back with
 * the item as it stands now (and its new version) instead of a bare refusal.
 */
export function registerUpdateWorkItem(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_update_work_item',
    {
      title: 'Update work item',
      description:
        "WRITES changes to one story, defect or task as you, and must be used only on the user's explicit request: show the user the item's CURRENT values (rova_get_work_item or rova_work_item_details) and send the version that read returned as `ifMatch`. Status changes follow the project's workflow; a refused transition comes back as an error — do not retry with another field. Names are resolved (status, assignee, team, iteration, release, feature, parent, devOwner); an unknown or ambiguous name comes back with candidates.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        key: z.string().min(1).max(64).describe('The work item key (e.g. US-412) or id'),
        ifMatch: z
          .string()
          .min(1)
          .max(32)
          .describe(
            'REQUIRED: the version the read returned (e.g. "3", from rova_get_work_item or rova_work_item_details). The write is refused 412 WORK_ITEM_STALE if the item changed since.',
          ),
        title: z.string().min(1).max(500).optional(),
        description: z.string().max(50_000).nullable().optional(),
        acceptanceCriteria: z.string().max(50_000).nullable().optional(),
        status: z.string().min(1).max(255).optional().describe('Workflow status by name'),
        scheduleState: z
          .string()
          .min(1)
          .max(32)
          .optional()
          .describe('idea|defined|in_progress|completed|accepted|release'),
        priority: z
          .string()
          .min(1)
          .max(32)
          .optional()
          .describe('Defect priority: none|low|normal|high|urgent'),
        assignee: nullableRef('Owner by display name or email'),
        devOwner: nullableRef('Dev Owner by display name or email'),
        team: nullableRef('Team by name or key'),
        iteration: nullableRef('Iteration by name or key'),
        release: nullableRef('Release by name or key'),
        feature: nullableRef('Feature by key (an active Feature of the same project)'),
        parent: nullableRef('Parent work item by key or id'),
        storyPoints: z.number().min(0).max(100).nullable().optional(),
        estimateHours: z.number().min(0).max(1000).nullable().optional(),
        todoHours: z.number().min(0).max(1000).nullable().optional(),
        actualHours: z.number().min(0).max(1000).nullable().optional(),
        blocked: z
          .object({
            isBlocked: z.boolean(),
            reason: z.string().max(1000).nullable().optional(),
          })
          .optional()
          .describe('Block/unblock the item; a reason is optional'),
        severity: z.string().min(1).max(32).nullable().optional(),
        defectState: z
          .string()
          .min(1)
          .max(32)
          .nullable()
          .optional()
          .describe('submitted|open|fixed|closed|closed_declined'),
        rootCause: z.string().min(1).max(32).nullable().optional(),
        resolution: z.string().min(1).max(32).nullable().optional(),
        fixedInBuild: z.string().max(255).nullable().optional(),
        foundInEnvironment: z.string().min(1).max(32).nullable().optional(),
        foundInRelease: nullableRef('The release the defect was found in, by name or key'),
        targetEndDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
          .nullable()
          .optional()
          .describe('Story-only Target End Date (YYYY-MM-DD); a later date needs Carryover'),
      },
    },
    async (args) => {
      const item = await resolveWorkItem(ctx, args.key);
      if (!item.ok) return failureResult(item);

      const body: Record<string, unknown> = {};
      if (args.title !== undefined) body['title'] = args.title;
      if (args.description !== undefined) body['description'] = args.description;
      if (args.acceptanceCriteria !== undefined)
        body['acceptanceCriteria'] = args.acceptanceCriteria;
      if (args.scheduleState !== undefined) body['scheduleState'] = args.scheduleState;
      if (args.priority !== undefined) body['priority'] = args.priority;
      if (args.storyPoints !== undefined) body['storyPoints'] = args.storyPoints;
      if (args.estimateHours !== undefined) body['estimateHours'] = args.estimateHours;
      if (args.todoHours !== undefined) body['todoHours'] = args.todoHours;
      if (args.actualHours !== undefined) body['actualHours'] = args.actualHours;
      if (args.severity !== undefined) body['severity'] = args.severity;
      if (args.defectState !== undefined) body['defectState'] = args.defectState;
      if (args.rootCause !== undefined) body['rootCause'] = args.rootCause;
      if (args.resolution !== undefined) body['resolution'] = args.resolution;
      if (args.fixedInBuild !== undefined) body['fixedInBuild'] = args.fixedInBuild;
      if (args.foundInEnvironment !== undefined)
        body['foundInEnvironment'] = args.foundInEnvironment;
      if (args.targetEndDate !== undefined) body['targetEndDate'] = args.targetEndDate;
      if (args.blocked !== undefined) {
        body['isBlocked'] = args.blocked.isBlocked;
        if (args.blocked.reason !== undefined) body['blockedReason'] = args.blocked.reason;
      }

      /** One nullable person reference → assigneeId/devOwnerId (a name is resolved project-scoped). */
      const personRef = async (
        reference: string | null | undefined,
        field: string,
      ): Promise<ReturnType<typeof failureResult> | null> => {
        if (reference === undefined || reference === null) return null;
        const people = await resolvePeople(ctx, item.projectId, [reference]);
        if (!people.ok) return failureResult(people);
        body[field] = people.ids[0];
        return null;
      };
      for (const [reference, field] of [
        [args.assignee, 'assigneeId'],
        [args.devOwner, 'devOwnerId'],
      ] as const) {
        const failed = await personRef(reference, field);
        if (failed) return failed;
      }
      if (args.assignee === null) body['assigneeId'] = null;
      if (args.devOwner === null) body['devOwnerId'] = null;

      if (args.team !== undefined) {
        if (args.team === null) body['teamId'] = null;
        else {
          const team = await resolveTeam(ctx, item.projectId, args.team);
          if (!team.ok) return failureResult(team);
          body['teamId'] = team.id;
        }
      }
      if (args.iteration !== undefined) {
        if (args.iteration === null) body['iterationId'] = null;
        else {
          const iteration = await resolveIteration(ctx, item.projectId, args.iteration);
          if (!iteration.ok) return failureResult(iteration);
          body['iterationId'] = iteration.id;
        }
      }
      if (args.release !== undefined) {
        if (args.release === null) body['releaseId'] = null;
        else {
          const release = await resolveRelease(ctx, item.projectId, args.release);
          if (!release.ok) return failureResult(release);
          body['releaseId'] = release.id;
        }
      }
      if (args.foundInRelease !== undefined) {
        if (args.foundInRelease === null) body['foundInReleaseId'] = null;
        else {
          const found = await resolveRelease(ctx, item.projectId, args.foundInRelease);
          if (!found.ok) return failureResult(found);
          body['foundInReleaseId'] = found.id;
        }
      }
      if (args.feature !== undefined) {
        if (args.feature === null) body['featureId'] = null;
        else {
          const feature = await resolvePortfolioItem(ctx, args.feature);
          if (!feature.ok) return failureResult(feature);
          if (feature.type !== null && feature.type !== 'feature') {
            return toolError(
              `"${args.feature}" is a ${feature.type}; a work item can only roll up to a Feature.`,
            );
          }
          if (feature.projectId !== item.projectId) {
            return toolError(
              `"${args.feature}" belongs to another project; a work item may only roll up to a Feature in its own project.`,
            );
          }
          body['featureId'] = feature.id;
        }
      }
      if (args.parent !== undefined) {
        if (args.parent === null) body['parentId'] = null;
        else {
          const parent = await resolveWorkItem(ctx, args.parent);
          if (!parent.ok) return failureResult(parent);
          body['parentId'] = parent.id;
        }
      }
      if (args.status !== undefined) {
        const status = await resolveStatus(ctx, item.projectId, args.status);
        if (!status.ok) return failureResult(status);
        body['statusId'] = status.id;
      }

      if (Object.keys(body).length === 0) {
        return toolError('Pass at least one field to change.');
      }
      if (!ctx.idempotencyKey) return toolError('Writes are not enabled on this endpoint.');

      // REQUIRED (design D4): the caller's own read is the base of the edit. The tool never
      // substitutes a version it read a moment ago — that would turn "I saw version 3" into
      // "whatever was current", which is the lost-update this token exists to prevent.
      // Read through a widened type: the schema requires it, so the SDK refuses a call without
      // one; the guard here gives a direct caller (and the model, in the unlikely case a client
      // skips validation) the sentence that says what to send.
      const ifMatch = (args as { ifMatch?: string }).ifMatch;
      if (ifMatch === undefined) {
        return toolError(
          'ifMatch required: pass the version from rova_work_item_details or rova_get_work_item; re-read the item if you lack it',
        );
      }
      const parsed = /^"?([0-9]+)"?$/.exec(ifMatch.trim());
      if (!parsed) {
        return toolError(
          `ifMatch must be the item version the read returned (e.g. "3"); got "${ifMatch}".`,
        );
      }

      const res = await ctx.callRest(ctx.principal, {
        method: 'PATCH',
        url: `/v1/work-items/${pathSegment(item.id)}`,
        body,
        ifMatch: `"${parsed[1]}"`,
      });

      if (isStale(res)) {
        const fresh = await ctx.callRest(ctx.principal, {
          method: 'GET',
          url: `/v1/work-items/${pathSegment(item.id)}`,
        });
        return staleWorkItemResult(res, fresh);
      }
      return workItemWriteResult(res, Object.keys(body));
    },
  );
}
