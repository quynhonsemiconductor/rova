import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, pathSegment, replayedFrom, result, toolError, type ToolContext } from './rest';
import {
  failureResult,
  resolvePeople,
  resolvePortfolioItem,
  resolveProject,
  resolveRelease,
  resolveTeam,
} from './lookups';

const STATES = [
  'no_entry',
  'intake',
  'idea_prioritization',
  'problem_discovery',
  'solution_discovery',
  'feature_prioritization',
  'developing',
  'accepted',
  'measuring',
  'done',
  'cancelled',
] as const;

const SIZES = ['no_entry', 'xs', 's', 'm', 'l', 'xl'] as const;

/** `YYYY-MM-DD`, the form the REST schema declares (a bare date, not a datetime). */
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/** The fields a model chains on after a save, from `PortfolioItemResponseDto`. */
export function shapeSavedPortfolioItem(row: Record<string, unknown>) {
  return {
    id: row['id'],
    itemKey: row['itemKey'],
    type: row['type'],
    name: row['name'],
    state: row['state'],
    preliminaryEstimate: row['preliminaryEstimate'],
    parentKey: row['parentKey'] ?? null,
    teamName: row['teamName'] ?? null,
    releaseName: row['releaseName'] ?? null,
    ownerName: row['ownerName'] ?? null,
    plannedStartDate: row['plannedStartDate'] ?? null,
    plannedEndDate: row['plannedEndDate'] ?? null,
    archivedAt: row['archivedAt'] ?? null,
    updatedAt: row['updatedAt'],
  };
}

/** The optional lookups a create/update shares; `null` clears, `undefined` leaves alone. */
type Refs = {
  parentId?: string | null;
  teamId?: string | null;
  releaseId?: string | null;
  ownerId?: string | null;
};

/**
 * `rova_save_portfolio_item` — create an Epic/Feature, or edit one by key (W11).
 *
 * Create wraps `POST /v1/portfolio-items` (`portfolio:create`, `@UseIdempotency`); update wraps
 * `PATCH /v1/portfolio-items/:id` (`portfolio:edit`). Both are PROJECT-ADMIN authority; an Editor
 * gets the same 403 the web would. The server owns every structural rule — a Feature's parent must
 * be an Epic, a Team/Release must belong to the project, a Feature carries Team/Release while an
 * Epic does not — and MCP only translates human references into ids.
 *
 * A record's Project and Type are chosen once, at creation: the update path cannot move or re-type
 * an item, because the REST contract does not carry either field.
 */
export function registerSavePortfolioItem(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_save_portfolio_item',
    {
      title: 'Save portfolio item',
      description:
        "WRITES an Epic or Feature as you, and must be used only on the user's explicit request. Pass `key` (EP-3 / FE-12) to UPDATE one, or `project` + `type` (and `name`) to CREATE one. `parent` is the Epic of a Feature; `team`, `release` and `owner` are names (or ids) the project offers; pass null on an update to clear one. The Project and Type cannot change after creation. DUPLICATES: a create is deduplicated ONLY by `requestId` — generate one per user request and reuse the SAME value when retrying that request; without it a retry may create a second item.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        key: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe('UPDATE this Epic or Feature by key (e.g. FE-12)'),
        project: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe('CREATE: project key or id. Also accepted on update to disambiguate names'),
        type: z.enum(['epic', 'feature']).optional().describe('CREATE only: the item kind'),
        requestId: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe(
            'A create-only retry guard: generate once per user request and reuse the SAME value when retrying that request. A repeat with the same id returns the first item; omit it and a retry may create a duplicate.',
          ),
        name: z.string().min(1).max(255).optional().describe('Required to create'),
        description: z.string().max(20_000).nullable().optional(),
        state: z.enum(STATES).optional(),
        preliminaryEstimate: z.enum(SIZES).optional(),
        parent: z
          .string()
          .min(1)
          .max(64)
          .nullable()
          .optional()
          .describe('The Epic of a Feature, by key; null clears it on an update'),
        team: z
          .string()
          .min(1)
          .max(255)
          .nullable()
          .optional()
          .describe('A Team this project offers; null clears it on an update'),
        release: z
          .string()
          .min(1)
          .max(255)
          .nullable()
          .optional()
          .describe('A Release of the project; null clears it on an update'),
        owner: z
          .string()
          .min(1)
          .max(255)
          .nullable()
          .optional()
          .describe('Owner by display name or email; null clears it on an update'),
        plannedStartDate: DATE.nullable().optional(),
        plannedEndDate: DATE.nullable().optional(),
      },
    },
    async (args) => {
      if (args.key !== undefined && (args.project !== undefined || args.type !== undefined)) {
        return toolError('Pass key (update) OR project + type (create), not both.');
      }
      const isUpdate = args.key !== undefined;
      if (isUpdate) {
        if (args.name === undefined && !hasEdit(args)) {
          return toolError('Pass at least one field to change.');
        }
      } else {
        if (args.project === undefined || args.type === undefined || args.name === undefined) {
          return toolError('project, type and name are required to create an Epic or Feature.');
        }
      }

      const project = isUpdate ? null : await resolveProject(ctx, args.project as string);
      if (project && !project.ok) return failureResult(project);

      let item: { id: string; projectId: string } | null = null;
      if (isUpdate) {
        const found = await resolvePortfolioItem(ctx, args.key as string);
        if (!found.ok) return failureResult(found);
        item = { id: found.id, projectId: found.projectId };
      }
      const projectId = item?.projectId ?? (project as { id: string }).id;

      const refs = await resolveRefs(ctx, projectId, args);
      if (!refs.ok) return refs.result;

      const body: Record<string, unknown> = {};
      if (!isUpdate) {
        body['projectId'] = projectId;
        body['type'] = args.type;
      }
      if (args.name !== undefined) body['name'] = args.name;
      if (args.description !== undefined) body['description'] = args.description;
      if (args.state !== undefined) body['state'] = args.state;
      if (args.preliminaryEstimate !== undefined)
        body['preliminaryEstimate'] = args.preliminaryEstimate;
      if (args.plannedStartDate !== undefined) body['plannedStartDate'] = args.plannedStartDate;
      if (args.plannedEndDate !== undefined) body['plannedEndDate'] = args.plannedEndDate;
      Object.assign(body, refs.ids);

      if (isUpdate) {
        const res = await ctx.callRest(ctx.principal, {
          method: 'PATCH',
          url: `/v1/portfolio-items/${pathSegment(item!.id)}`,
          body,
        });
        if (res.statusCode >= 400 || res.json === null || typeof res.json !== 'object') {
          return denied(res.statusCode, res.json);
        }
        const changed = Object.keys(body);
        ctx.noteWrite?.({ targets: [item!.id], fields: changed, count: 1 });
        return result(res.statusCode, res.json, {
          portfolioItem: shapeSavedPortfolioItem(res.json as Record<string, unknown>),
          changed,
        });
      }

      const idempotencyKey =
        args.requestId !== undefined && ctx.clientIdempotencyKey
          ? ctx.clientIdempotencyKey('rova_save_portfolio_item', { requestId: args.requestId })
          : undefined;
      const res = await ctx.callRest(ctx.principal, {
        method: 'POST',
        url: '/v1/portfolio-items',
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
        portfolioItem: shapeSavedPortfolioItem(row),
        changed: [...(replayed ? [] : ['created']), ...Object.keys(body)],
        replayed,
      });
    },
  );
}

/** Does an update carry any field at all (besides the identity and a requestId)? */
function hasEdit(args: Record<string, unknown>): boolean {
  return [
    'description',
    'state',
    'preliminaryEstimate',
    'parent',
    'team',
    'release',
    'owner',
    'plannedStartDate',
    'plannedEndDate',
  ].some((field) => args[field] !== undefined);
}

/** Resolves every person/structural reference against the item's own project. */
async function resolveRefs(
  ctx: ToolContext,
  projectId: string,
  args: {
    parent?: string | null;
    team?: string | null;
    release?: string | null;
    owner?: string | null;
  },
): Promise<{ ok: true; ids: Refs } | { ok: false; result: ReturnType<typeof failureResult> }> {
  const ids: Refs = {};
  if (args.parent !== undefined) {
    if (args.parent === null) ids.parentId = null;
    else {
      const parent = await resolvePortfolioItem(ctx, args.parent);
      if (!parent.ok) return { ok: false, result: failureResult(parent) };
      ids.parentId = parent.id;
    }
  }
  if (args.team !== undefined) {
    if (args.team === null) ids.teamId = null;
    else {
      const team = await resolveTeam(ctx, projectId, args.team);
      if (!team.ok) return { ok: false, result: failureResult(team) };
      ids.teamId = team.id;
    }
  }
  if (args.release !== undefined) {
    if (args.release === null) ids.releaseId = null;
    else {
      const release = await resolveRelease(ctx, projectId, args.release);
      if (!release.ok) return { ok: false, result: failureResult(release) };
      ids.releaseId = release.id;
    }
  }
  if (args.owner !== undefined) {
    if (args.owner === null) ids.ownerId = null;
    else {
      const people = await resolvePeople(ctx, projectId, [args.owner], {
        teamId: ids.teamId ?? undefined,
      });
      if (!people.ok) return { ok: false, result: failureResult(people) };
      ids.ownerId = people.ids[0];
    }
  }
  return { ok: true, ids };
}
