import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  denied,
  isRealCalendarDate,
  pathSegment,
  replayedFrom,
  result,
  toolError,
  type ToolContext,
} from './rest';
import {
  failureResult,
  resolveIteration,
  resolveProject,
  resolveTeam,
  type Lookup,
} from './lookups';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `YYYY-MM-DD`, a real calendar date — the shape alone lets `2026-02-30` reach the REST body. */
const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine(isRealCalendarDate, 'Must be a real calendar date between 2000 and 2100');

/** The fields a model chains on after a save, from `IterationResponseDto`. */
export function shapeSavedIteration(row: Record<string, unknown>) {
  return {
    id: row['id'],
    iterationKey: row['iterationKey'] ?? null,
    name: row['name'],
    state: row['state'],
    projectId: row['projectId'],
    teamId: row['teamId'] ?? null,
    startDate: row['startDate'] ?? null,
    endDate: row['endDate'] ?? null,
    goal: row['goal'] ?? null,
    plannedVelocity: row['plannedVelocity'] ?? null,
    updatedAt: row['updatedAt'],
  };
}

/**
 * `rova_save_iteration` — create an iteration, or edit its name/dates/goal/planned velocity (W12).
 *
 * Create wraps `POST /v1/iterations` (`iteration:create`, `@UseIdempotency`); update wraps
 * `PATCH /v1/iterations/:id` (`iteration:edit`). Both are Project-Admin authority. `state` is
 * deliberately NOT an input: committing and accepting are the ceremony endpoints, not a field a
 * chat edit should reach.
 *
 * A name (or iteration key) resolves through the project's own reference feed, so `project` is
 * needed to name one; a UUID resolves directly. The Project itself can never change after create.
 */
export function registerSaveIteration(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_save_iteration',
    {
      title: 'Save iteration',
      description:
        "WRITES an iteration as you, and must be used only on the user's explicit request. Pass `iteration` (an id, or a name/iteration key together with `project`) to UPDATE, or `project` + `name` to CREATE. Edits name, goal, planned velocity and the start/end dates; it never commits or accepts an iteration, and it cannot move one to another project. DUPLICATES: a create is deduplicated ONLY by `requestId` — generate one per user request and reuse the SAME value when retrying that request; without it a retry may create a second iteration.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        iteration: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe('UPDATE this iteration by id, name or iteration key'),
        project: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe('CREATE: project key or id. UPDATE: required to resolve a name/reference'),
        requestId: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe(
            'A create-only retry guard: generate once per user request and reuse the SAME value when retrying that request. A repeat with the same id returns the first iteration; omit it and a retry may create a duplicate.',
          ),
        name: z.string().min(1).max(255).optional().describe('Required to create'),
        goal: z.string().max(2000).nullable().optional(),
        team: z
          .string()
          .min(1)
          .max(255)
          .nullable()
          .optional()
          .describe('A Team this project offers; null clears it on an update'),
        startDate: DATE.optional(),
        endDate: DATE.optional(),
        plannedVelocity: z.number().int().min(0).optional(),
      },
    },
    async (args) => {
      if (args.iteration !== undefined && !hasEdit(args)) {
        return toolError('Pass at least one field to change.');
      }
      if (
        args.iteration !== undefined &&
        args.project === undefined &&
        !UUID.test(args.iteration)
      ) {
        return toolError(
          'Pass project (project key) with a name or iteration key, so the iteration can be found.',
        );
      }
      if (args.iteration === undefined && (args.project === undefined || args.name === undefined)) {
        return toolError('project and name are required to create an iteration.');
      }

      if (args.iteration !== undefined) {
        const found = await findIteration(ctx, args.iteration, args.project);
        if (!found.ok) return failureResult(found);

        const body: Record<string, unknown> = {};
        if (args.name !== undefined) body['name'] = args.name;
        if (args.goal !== undefined) body['goal'] = args.goal;
        if (args.startDate !== undefined) body['startDate'] = args.startDate;
        if (args.endDate !== undefined) body['endDate'] = args.endDate;
        if (args.plannedVelocity !== undefined) body['plannedVelocity'] = args.plannedVelocity;
        if (args.team !== undefined) {
          if (args.team === null) body['teamId'] = null;
          else {
            const team = await resolveTeam(ctx, found.projectId, args.team);
            if (!team.ok) return failureResult(team);
            body['teamId'] = team.id;
          }
        }

        const res = await ctx.callRest(ctx.principal, {
          method: 'PATCH',
          url: `/v1/iterations/${pathSegment(found.id)}`,
          body,
        });
        if (res.statusCode >= 400 || res.json === null || typeof res.json !== 'object') {
          return denied(res.statusCode, res.json);
        }
        const changed = Object.keys(body);
        ctx.noteWrite?.({ targets: [found.id], fields: changed, count: 1 });
        return result(res.statusCode, res.json, {
          iteration: shapeSavedIteration(res.json as Record<string, unknown>),
          changed,
        });
      }

      const project = await resolveProject(ctx, args.project as string);
      if (!project.ok) return failureResult(project);

      const body: Record<string, unknown> = {
        projectId: project.id,
        name: args.name,
      };
      if (args.goal !== undefined && args.goal !== null) body['goal'] = args.goal;
      if (args.startDate !== undefined) body['startDate'] = args.startDate;
      if (args.endDate !== undefined) body['endDate'] = args.endDate;
      if (args.plannedVelocity !== undefined) body['plannedVelocity'] = args.plannedVelocity;
      if (args.team !== undefined && args.team !== null) {
        const team = await resolveTeam(ctx, project.id, args.team);
        if (!team.ok) return failureResult(team);
        body['teamId'] = team.id;
      }

      const idempotencyKey =
        args.requestId !== undefined && ctx.clientIdempotencyKey
          ? ctx.clientIdempotencyKey('rova_save_iteration', { requestId: args.requestId })
          : undefined;
      const res = await ctx.callRest(ctx.principal, {
        method: 'POST',
        url: '/v1/iterations',
        body,
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      });
      if (res.statusCode >= 400 || res.json === null || typeof res.json !== 'object') {
        return denied(res.statusCode, res.json);
      }
      const row = res.json as Record<string, unknown>;
      const replayed = replayedFrom(res);
      ctx.noteWrite?.({
        targets: typeof row['id'] === 'string' ? [row['id']] : [],
        fields: Object.keys(body),
        count: replayed ? 0 : 1,
      });
      return result(res.statusCode, res.json, {
        iteration: shapeSavedIteration(row),
        changed: [...(replayed ? [] : ['created']), ...Object.keys(body)],
        replayed,
      });
    },
  );
}

function hasEdit(args: Record<string, unknown>): boolean {
  return ['name', 'goal', 'team', 'startDate', 'endDate', 'plannedVelocity'].some(
    (field) => args[field] !== undefined,
  );
}

/**
 * Finds an iteration by UUID (one read) or by a project's reference feed (`/iterations/options`),
 * plus the project id an update needs for team resolution.
 */
async function findIteration(
  ctx: ToolContext,
  reference: string,
  projectReference: string | undefined,
): Promise<Lookup<{ ok: true; id: string; projectId: string }>> {
  if (UUID.test(reference)) {
    const res = await ctx.callRest(ctx.principal, {
      method: 'GET',
      url: `/v1/iterations/${pathSegment(reference)}`,
    });
    if (res.statusCode >= 400) {
      return { ok: false, statusCode: res.statusCode, json: res.json };
    }
    const row = res.json as Record<string, unknown> | null;
    const projectId = typeof row?.['projectId'] === 'string' ? row['projectId'] : undefined;
    if (projectId === undefined) {
      return { ok: false, message: `No iteration matches "${reference}".` };
    }
    return { ok: true, id: reference, projectId };
  }

  const project = await resolveProject(ctx, projectReference as string);
  if (!project.ok) return project;
  const iteration = await resolveIteration(ctx, project.id, reference);
  if (!iteration.ok) return iteration;
  return { ok: true, id: iteration.id, projectId: project.id };
}
