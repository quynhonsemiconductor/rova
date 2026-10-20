import { Inject, Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { and, asc, eq, isNull, sql, desc, inArray, type Column, type SQL } from 'drizzle-orm';
import {
  InjectDrizzle,
  buildPageResult,
  NotFoundException,
  PreconditionFailedException,
} from '@platform';
import type { JwtPayload, CursorPayload, PagedResult, DrizzleDB } from '@platform';
import { ProjectsService } from '@modules/projects';
import { AccessService } from '@modules/access';
import { PERMISSION } from '@shared-kernel';
import { capacityPlans, workItems, tasks, portfolioItems } from '../../../../../db/schema/work';
import { acceptedScheduleStatesSql, type ReleaseStatus } from '../../../../../db/schema/enums';
import { IReleaseRepository, RELEASE_REPOSITORY } from '../domain/ports/release.repository';
import type { Release, ReleaseOption, UpdateReleaseInput } from '../domain/release.types';
import { ActivityLogger, type ActivityLog } from '@modules/activity';
import { RELEASE_ACTIVITY_CONFIG } from './release-activity-diff';

/** Walk an error's `.cause` chain looking for a PG unique-violation (code 23505). */
function isDuplicateKeyError(err: unknown): boolean {
  let current: unknown = err;
  while (true) {
    if (current && typeof current === 'object' && 'code' in current) {
      if ((current as Record<string, unknown>).code === '23505') return true;
    }
    if (current && typeof current === 'object' && 'cause' in current) {
      current = current.cause;
    } else {
      return false;
    }
  }
}

/** Valid release status transitions (Rally-aligned lifecycle). */
const RELEASE_TRANSITIONS: Record<ReleaseStatus, ReleaseStatus[]> = {
  planning: ['active', 'planning'],
  active: ['accepted', 'planning', 'active'],
  accepted: ['active', 'accepted'],
};

/**
 * A release's task roll-up: Estimate / To Do / Actual **HOURS** from the tasks under the release's
 * assigned Story/Defect items, plus the accepted work total.
 *
 * **SERVED, NEVER DISPLAYED ON A PHASE 3 SURFACE.** The BA's own §7.4 Release Detail DTO carries
 * `taskRollup` and `accepted`, which is why they are still computed here — but P3-REL-FR-023
 * ("Release detail must not show Task Roll-up, Burndown or another Release progress widget"),
 * FR-024 ("Accepted/progress totals are displayed only in `Portfolio > Release Tracking`"), FR-037
 * and AC #10 ("Release metadata only; no progress roll-up") forbid rendering any of it on the
 * Phase 3 list or detail. Confirmed again by the BA's 2026-08-17 retest (`GAP-P3-REL-001`). The one
 * number a Phase 3 surface may show is `estimateHours`, re-exposed as the list's `taskEstimate`
 * column (FR-004) — do not add a second reader.
 *
 * There is deliberately NO percentage, no point total and no done/remaining count here.
 * §7.5 defers the progress percentage, its zero-state, its formula and its recalculation out of
 * Phase 3.2 entirely; that report is `Portfolio > Release Tracking`, on its own frozen snapshots.
 */
export interface TaskRollup {
  estimateHours: number;
  toDoHours: number;
  actualHours: number;
  acceptedItems: number;
}

/** A release with no linked Story/Defect at all: zeroes, not absent values. */
const EMPTY_TASK_ROLLUP: TaskRollup = {
  estimateHours: 0,
  toDoHours: 0,
  actualHours: 0,
  acceptedItems: 0,
};

/**
 * One row of the Artifacts dashboard, whichever table it came from.
 *
 * `scheduleState` and `priority` are `''` for a portfolio row and that is deliberate: a Feature
 * carries NEITHER field. Its `state` (`no_entry` … `done`) is a different axis from a Story's
 * Schedule State — putting one in the other's column would misreport it — and there is no priority
 * column on `portfolio_items` at all. `''` is not a member of either enum, so no reader can mistake
 * it for a value, and the shared read-only `ArtifactTable` renders an unmatched schedule state as an
 * empty track. `storyPoints` is null for the same reason and renders `EMPTY_VALUE`: a Feature's
 * forecast is the TIERED top-down estimate the Portfolio surface resolves (AC-014), not a leaf Plan
 * Estimate, and Rally keeps those two apart as `Plan Estimate` and `Leaf Story Plan Estimate Total`.
 */
export interface ReleaseArtifactRow {
  id: string;
  itemKey: string;
  type: string;
  title: string;
  scheduleState: string;
  priority: string;
  assigneeId: string | null;
  assigneeName: string | null;
  iterationId: string | null;
  releaseId: string | null;
  storyPoints: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A MICROSECOND, lexicographically ordered rendering of a timestamp, used to merge two tables'
 * pages into one order.
 *
 * `Date.getTime()` is MILLISECONDS and `timestamptz` is microseconds — the precision mismatch
 * `keysetCondition`'s own docblock is built around. Sorting the merged rows on `getTime()` would
 * therefore tie two rows the database orders strictly, the tie would break on `id` instead, and the
 * row the page ends on would not be the row the database calls last: its cursor then skips the
 * straddling row for ever. `to_char(… 'US')` is fixed-width and exact, so the merge order and the
 * `ORDER BY` cannot disagree. It is stripped before the row is returned — it is a sort key, not a
 * field of the contract.
 */
function microsecondSortKey(col: Column): SQL<string> {
  return sql<string>`to_char(${col} at time zone 'UTC', 'YYYYMMDDHH24MISSUS')`;
}

/** Newest-first on the exact timestamp, id ascending — the `ORDER BY` both branches carry. */
function bySortKeyDesc(a: { sortKey: string; id: string }, b: { sortKey: string; id: string }) {
  if (a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

@Injectable()
export class ReleasesService {
  private readonly logger = new Logger(ReleasesService.name);

  constructor(
    @Inject(RELEASE_REPOSITORY) private readonly releaseRepo: IReleaseRepository,
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly projectsService: ProjectsService,
    private readonly accessService: AccessService,
    private readonly activity: ActivityLogger,
  ) {}

  // ── Revision History (activity log) ─────────────────────────────────────────

  /** Newest-first revision history for one release (workspace-view gated). */
  async getReleaseActivity(
    actor: JwtPayload,
    id: string,
    args: { limit: number; offset: number },
  ): Promise<{ items: ActivityLog[]; total: number }> {
    await this.getReleaseForView(actor, id);
    const page = Math.floor(args.offset / args.limit) + 1;
    const res = await this.activity.listFor(id, actor.workspaceId, page, args.limit);
    return { items: res.data, total: res.total };
  }

  private releaseSubject(r: Release) {
    return {
      workspaceId: r.workspaceId,
      projectId: r.projectId,
      entityType: 'release' as const,
      entityId: r.id,
    };
  }

  // ── List ──────────────────────────────────────────────────────────────────

  async listReleases(
    actor: JwtPayload,
    projectId: string,
    args: { limit: number; cursor: CursorPayload | null },
  ): Promise<PagedResult<Release & { taskEstimate: number }>> {
    await this.projectsService.getProject(actor.workspaceId, projectId);
    const page = await this.releaseRepo.listByProject(projectId, actor.workspaceId, args);
    const ids = page.data.map((r) => r.id);
    // Batched over the whole page. `taskRollup` used to be built only in the detail path, so
    // every list consumer saw `undefined` and read `?? 0` off it. The list's own `taskEstimate`
    // column (FR-004) is the roll-up's Estimate hours — one number, computed once, so no two
    // release surfaces can report different hours.
    const rollups = await this.computeTaskRollups(ids);
    return {
      ...page,
      data: page.data.map((r) => {
        const taskRollup = rollups.get(r.id) ?? EMPTY_TASK_ROLLUP;
        return { ...r, taskEstimate: taskRollup.estimateHours, taskRollup };
      }),
    };
  }

  /**
   * The REFERENCE feed — every release in the project, projected to what a picker needs.
   *
   * Split out of {@link listReleases} because that one is the `Plan > Releases` administration grid's
   * feed and takes `release:view`, which §3.2 withholds from an Editor — and it was ALSO the only
   * source of a release's NAME on Backlog, the Work Item detail sidebar, the Backlog summary panel
   * and Quality. See {@link ReleaseOptionSchema} for the full account; the short version is that a
   * 403 there rendered a scheduled row as unscheduled and left the picker empty, which is the
   * `member-options` regression one column across.
   *
   * No roll-up computed here: `computeTaskRollups` is three grouped aggregates over `work.tasks` for
   * numbers a picker does not show, and `taskEstimate` is administration data an Editor must not
   * read. So this is also the cheaper call, which is the one every grid makes.
   *
   * No actor gate beyond the route's: `project:view` scoped to the query's `projectId` is the
   * parent's own view permission, held by every level, and `getProject` still refuses a project
   * outside the caller's workspace.
   */
  async listReleaseOptions(actor: JwtPayload, projectId: string): Promise<ReleaseOption[]> {
    await this.projectsService.getProject(actor.workspaceId, projectId);
    return this.releaseRepo.listOptionsByProject(projectId, actor.workspaceId);
  }

  /**
   * The task roll-up per release (BA §7.4's `taskRollup` + `accepted`), batched over a page.
   *
   * Two questions with two different populations, so two grouped queries:
   *  - Task Roll-up hours come from `work.tasks` through the parent Story/Defect;
   *  - `Accepted` counts the release's own Story/Defect items.
   *
   * Neither is rendered by a Phase 3 surface — see {@link TaskRollup}. Only `estimateHours`
   * reaches a screen, as the list's `taskEstimate` column (FR-004).
   *
   * A release absent from the map has nothing assigned and resolves to `EMPTY_TASK_ROLLUP`.
   */
  private async computeTaskRollups(releaseIds: string[]): Promise<Map<string, TaskRollup>> {
    if (releaseIds.length === 0) return new Map();
    const [hours, accepted] = await Promise.all([
      this.computeTaskHours(releaseIds),
      this.computeAcceptedCounts(releaseIds),
    ]);
    const map = new Map<string, TaskRollup>();
    for (const id of new Set([...hours.keys(), ...accepted.keys()])) {
      map.set(id, {
        ...(hours.get(id) ?? { estimateHours: 0, toDoHours: 0, actualHours: 0 }),
        acceptedItems: accepted.get(id) ?? 0,
      });
    }
    return map;
  }

  /**
   * SRS FR-023 / §6.1 FR-004 — Estimate, To Do and Actual hours summed from the child tasks of
   * the stories/defects assigned to each release. Three independent fields (they never derive
   * from each other), summed the same way Team Status and the Phase 6 projection sum them, so
   * every surface reports the same hours. The Estimate column on the list is this Estimate.
   *
   * `innerJoin` on the parent WITH `parent.deleted_at IS NULL`: a soft-deleted Story does not
   * cascade to `work.tasks` (the FK is `ON DELETE cascade`, which a soft delete never fires),
   * so an orphaned task would otherwise keep charging hours to the release. No team predicate —
   * a release is not team-scoped, and this is the release's own total.
   */
  private async computeTaskHours(
    releaseIds: string[],
  ): Promise<Map<string, Omit<TaskRollup, 'acceptedItems'>>> {
    const rows = await this.db
      .select({
        releaseId: workItems.releaseId,
        estimateHours: sql<number>`COALESCE(SUM(${tasks.estimateHours}), 0)`,
        toDoHours: sql<number>`COALESCE(SUM(${tasks.todoHours}), 0)`,
        actualHours: sql<number>`COALESCE(SUM(${tasks.actualHours}), 0)`,
      })
      .from(tasks)
      .innerJoin(workItems, eq(tasks.parentId, workItems.id))
      .where(
        and(
          inArray(workItems.releaseId, releaseIds),
          isNull(workItems.deletedAt),
          isNull(tasks.deletedAt),
        ),
      )
      .groupBy(workItems.releaseId);
    const map = new Map<string, Omit<TaskRollup, 'acceptedItems'>>();
    for (const r of rows) {
      if (!r.releaseId) continue;
      map.set(r.releaseId, {
        estimateHours: Number(r.estimateHours),
        toDoHours: Number(r.toDoHours),
        actualHours: Number(r.actualHours),
      });
    }
    return map;
  }

  /** FR-024 — the accepted work total: the release's Story/Defect items in an accepted state. */
  private async computeAcceptedCounts(releaseIds: string[]): Promise<Map<string, number>> {
    const rows = await this.db
      .select({
        releaseId: workItems.releaseId,
        acceptedItems: sql<number>`COUNT(*) FILTER (WHERE ${workItems.scheduleState} IN (${acceptedScheduleStatesSql()}))::int`,
      })
      .from(workItems)
      .where(
        and(
          inArray(workItems.releaseId, releaseIds),
          isNull(workItems.deletedAt),
          sql`${workItems.type} IN ('story', 'defect')`,
        ),
      )
      .groupBy(workItems.releaseId);
    const map = new Map<string, number>();
    for (const r of rows) if (r.releaseId) map.set(r.releaseId, Number(r.acceptedItems));
    return map;
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async createRelease(
    actor: JwtPayload,
    projectId: string,
    name: string,
    opts: {
      description?: string;
      theme?: string;
      startDate?: string;
      releaseDate?: string;
      state?: string;
      releaseNotes?: string;
    } = {},
  ): Promise<Release> {
    await this.projectsService.assertProjectWritable(actor.workspaceId, projectId);

    // Validate date range: releaseDate >= startDate
    if (opts.startDate && opts.releaseDate && opts.releaseDate < opts.startDate) {
      throw new PreconditionFailedException(
        'RELEASE_INVALID_DATE_RANGE',
        'Release date must be >= start date',
      );
    }

    // releaseKey reservation reads MAX(existing) + 1 (not atomic under
    // concurrent creates) and releases can be deleted, so a collision on
    // uq_releases_key is possible; retry once with a freshly computed key.
    const MAX_KEY_RETRIES = 2;
    let release: Release | undefined;
    let lastErr: unknown;

    for (let attempt = 0; attempt < MAX_KEY_RETRIES; attempt++) {
      const keyNumber = await this.releaseRepo.nextKeyNumber(projectId, actor.workspaceId);
      try {
        release = await this.releaseRepo.create({
          id: uuidv7(),
          workspaceId: actor.workspaceId,
          projectId,
          releaseKey: `RE-${keyNumber}`,
          name,
          description: opts.description,
          theme: opts.theme,
          startDate: opts.startDate,
          releaseDate: opts.releaseDate,
          status: (opts.state as Release['status']) ?? 'planning',
          releaseNotes: opts.releaseNotes,
        });
        break;
      } catch (err: unknown) {
        lastErr = err;
        if (isDuplicateKeyError(err) && attempt < MAX_KEY_RETRIES - 1) {
          this.logger.warn({ projectId, attempt: attempt + 1 }, 'Duplicate release key — retrying');
          continue;
        }
        throw err;
      }
    }

    if (!release) throw lastErr;

    this.logger.log({ releaseId: release.id, projectId, userId: actor.sub }, 'Release created');
    await this.activity.logSafe([
      this.activity.build(this.releaseSubject(release), actor.sub, 'release.created', null),
    ]);
    return release;
  }

  // ── Get ───────────────────────────────────────────────────────────────────

  async getRelease(workspaceId: string, id: string): Promise<Release> {
    const release = await this.releaseRepo.findById(id);
    if (!release || release.workspaceId !== workspaceId) {
      throw new NotFoundException('RELEASE_NOT_FOUND', 'Release not found');
    }
    return release;
  }

  /**
   * Load a release for a READ. Project-scoped `release:view` is enforced by the
   * PolicyGuard at the route (resource-resolved), so this just loads the row.
   */
  private async getReleaseForView(actor: JwtPayload, id: string): Promise<Release> {
    return this.getRelease(actor.workspaceId, id);
  }

  // ── Update ────────────────────────────────────────────────────────────────

  async updateRelease(actor: JwtPayload, id: string, input: UpdateReleaseInput): Promise<Release> {
    // Authorization (release:edit at this project) is enforced by the PolicyGuard.
    const release = await this.getRelease(actor.workspaceId, id);
    await this.projectsService.assertProjectWritable(actor.workspaceId, release.projectId);

    // Validate status transition
    if (input.status && input.status !== release.status) {
      const allowed = RELEASE_TRANSITIONS[release.status] ?? [];
      if (!allowed.includes(input.status)) {
        throw new PreconditionFailedException(
          'RELEASE_INVALID_TRANSITION',
          `Invalid release transition: ${release.status} → ${input.status}. Allowed: ${allowed.join(', ') || 'none (terminal)'}`,
        );
      }
      // Auto-set releasedAt when transitioning to accepted
      if (input.status === 'accepted' && !input.releasedAt) {
        input.releasedAt = new Date();
      }
    }

    // Validate date range: releaseDate >= startDate (using merged values)
    const startDate = input.startDate !== undefined ? input.startDate : release.startDate;
    const releaseDate = input.releaseDate !== undefined ? input.releaseDate : release.releaseDate;
    if (startDate && releaseDate && releaseDate < startDate) {
      throw new PreconditionFailedException(
        'RELEASE_INVALID_DATE_RANGE',
        'Release date must be >= start date',
      );
    }

    const updated = await this.releaseRepo.update(id, input);
    await this.activity.logSafe(
      this.activity.buildDiff(
        this.releaseSubject(updated),
        actor.sub,
        release as unknown as Record<string, unknown>,
        input as Record<string, unknown>,
        RELEASE_ACTIVITY_CONFIG,
        'release.updated',
      ),
    );
    return updated;
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  async deleteRelease(actor: JwtPayload, id: string): Promise<void> {
    // Authorization (release:delete at this project) is enforced by the PolicyGuard.
    const release = await this.getRelease(actor.workspaceId, id);
    await this.projectsService.assertProjectWritable(actor.workspaceId, release.projectId);
    // Accepted releases cannot be deleted
    if (release.status === 'accepted') {
      throw new PreconditionFailedException(
        'RELEASE_NOT_DELETABLE',
        'Accepted releases cannot be deleted',
      );
    }

    /**
     * A release that a capacity plan is built on cannot be deleted.
     *
     * Migration 0085 adds the foreign key that makes this true at the database level; this check is
     * what turns it into an answer a planner can act on. Deleting one used to succeed and leave the
     * plan pointing at a missing row: its Release badge went blank, and because the plan's release is
     * deliberately immutable while `releaseWindow` resolved to null, publish could never write the
     * Release field again and nothing could repair it.
     *
     * The plan is named in the message: "delete the plan first" is only actionable if you know which.
     */
    const plans = await this.db
      .select({ planKey: capacityPlans.planKey, name: capacityPlans.name })
      .from(capacityPlans)
      .where(eq(capacityPlans.releaseId, id))
      .limit(3);
    if (plans.length > 0) {
      const named = plans.map((p) => `${p.planKey} (${p.name})`).join(', ');
      throw new PreconditionFailedException(
        'RELEASE_HAS_CAPACITY_PLAN',
        `This release is planned by ${named} — delete the plan first`,
      );
    }

    /**
     * As with an iteration: `work_items.release_id` and `portfolio_items.release_id` carry
     * `ON DELETE SET NULL` (migration 0114), so the work is unscheduled in the same statement rather
     * than left pointing at a missing row. `work_items.found_in_release_id` already behaved this way.
     * The capacity-plan reference above is the one link that REFUSES instead, because a plan's release
     * is immutable and a null there is unrepairable.
     */
    await this.releaseRepo.delete(id);
    this.logger.log({ releaseId: id }, 'Release deleted; its work items are now unscheduled');
  }

  // ── Get Detail (includes task rollup) ─────────────────────────────────────

  async shipRelease(actor: JwtPayload, id: string): Promise<Release> {
    const release = await this.getRelease(actor.workspaceId, id);
    await this.projectsService.assertProjectWritable(actor.workspaceId, release.projectId);
    await this.accessService.assertProjectPermission(
      actor,
      release.projectId,
      PERMISSION.RELEASE_EDIT,
    );
    if (release.status === 'accepted') {
      throw new PreconditionFailedException(
        'RELEASE_ALREADY_SHIPPED',
        'Release has already shipped',
      );
    }
    const updated = await this.releaseRepo.update(id, {
      status: 'accepted',
      releasedAt: new Date(),
    });
    this.logger.log({ releaseId: id }, 'Release shipped');
    return updated;
  }
  async getReleaseDetail(actor: JwtPayload, id: string) {
    const release = await this.getReleaseForView(actor, id);

    const rollups = await this.computeTaskRollups([id]);
    const taskRollup = rollups.get(id) ?? EMPTY_TASK_ROLLUP;

    return {
      ...release,
      taskEstimate: taskRollup.estimateHours,
      taskRollup,
    };
  }

  // ── Release Artifacts (P3) ──────────────────────────────────────────

  /**
   * The artifacts assigned to a release — Story/Defect work items AND Features, in one feed.
   *
   * TWO TABLES, ONE LIST. `work_items.release_id` is not the only way a release is assigned:
   * `portfolio_items.release_id` exists too (Feature-only, `ON DELETE SET NULL`), it is what the
   * Portfolio Feature detail writes, and P3-REL-FR-032's own acceptance sentence covers "directly
   * assigned US/DE/Feature after assignment from Backlog/Work Item Detail **or Portfolio Feature**".
   * This module never touched `portfolio_items`, so a Feature assigned to a release showed that
   * release on the Feature, survived a reload, and the release's Artifacts tab reported `0 items` —
   * `GAP-P3-REL-002`. The seed has had `FE-1 → RE-1` since it was written, so every environment
   * displayed the fault. The work-item half is unchanged, down to `type IN ('story','defect')`:
   * tasks live in `work.tasks` and carry no release, and an Epic is project-level with no Release
   * field, so `portfolio_items.release_id` is a Feature's column in practice as well as by rule.
   *
   * TWO BRANCHES, NOT ONE PER-BRANCH PAGE. Each branch fetches `limit + 1` under the SAME keyset
   * predicate and the same `ORDER BY`, and the merge below takes `limit + 1` of the UNION. That is
   * exact, not approximate: any row among the union's next `limit + 1` is among its own branch's next
   * `limit + 1`. A per-branch `limit` would be a silent truncation instead — the Feature would
   * reappear only to push a Story off the page. The count sums both branches because they are
   * disjoint by construction (two tables, two id spaces).
   *
   * `assigneeName` is joined because the shared artifact table renders an Owner column and had
   * nothing to fill it with — the SPA's own row type declared the field, the feed never sent it. On
   * the portfolio branch the Owner is `owner_id`, which is that table's name for the same column.
   * `q` (item key or title) is honoured on both branches: the toolbar above this table has always
   * had a search box and has always sent the term (P3-REL-FR-033).
   */
  async listReleaseArtifacts(
    actor: JwtPayload,
    releaseId: string,
    args: { limit: number; cursor: CursorPayload | null; q?: string },
  ): Promise<PagedResult<ReleaseArtifactRow>> {
    // Validates the release exists and the actor may view it (project-scoped).
    await this.getReleaseForView(actor, releaseId);

    const term = args.q?.trim();
    const like = term ? `%${term}%` : null;

    const workConditions = [
      eq(workItems.releaseId, releaseId),
      eq(workItems.workspaceId, actor.workspaceId),
      isNull(workItems.deletedAt),
      sql`type IN ('story', 'defect')`,
    ];
    if (like) {
      workConditions.push(
        sql`(${workItems.itemKey} ilike ${like} or ${workItems.title} ilike ${like})`,
      );
    }

    // Archived, not soft-deleted: a portfolio item is archived and never hard-deleted (SRS §5.5), and
    // an archived Feature is out of every list — the same `archived_at is null` the portfolio
    // rollups filter their child Features on.
    const portfolioConditions = [
      eq(portfolioItems.releaseId, releaseId),
      eq(portfolioItems.workspaceId, actor.workspaceId),
      isNull(portfolioItems.archivedAt),
    ];
    if (like) {
      portfolioConditions.push(
        sql`(${portfolioItems.itemKey} ilike ${like} or ${portfolioItems.name} ilike ${like})`,
      );
    }

    // Totals before the cursor/limit, for the footer count.
    const workCountConditions = [...workConditions];
    const portfolioCountConditions = [...portfolioConditions];

    if (args.cursor) {
      /**
       * The keyset boundary, resolved IN the database from whichever table holds the cursor's row.
       *
       * `keysetCondition` cannot be used here: for a date column it reads the boundary back from
       * `sortCol.table`, which is one table, and the cursor's row may be in the other. Its reason for
       * doing so still holds and is why the value is not carried in the cursor instead — a
       * `timestamptz` is microseconds and the `Date` the driver hands back is milliseconds, so a
       * round-tripped boundary is strictly smaller than the row it names and skips every row inside
       * that millisecond. The ids are UUIDs from two disjoint spaces, so at most one branch matches.
       */
      const cursorId = args.cursor.id;
      const boundary = sql`(select b.ts from (
          select cw.created_at as ts from ${workItems} cw where cw.id = ${cursorId}
          union all
          select cp.created_at as ts from ${portfolioItems} cp where cp.id = ${cursorId}
        ) b limit 1)`;
      const after = (createdAt: Column, id: Column) =>
        sql`(${createdAt} < ${boundary} or (${createdAt} = ${boundary} and ${id} > ${cursorId}))`;
      workConditions.push(after(workItems.createdAt, workItems.id));
      portfolioConditions.push(after(portfolioItems.createdAt, portfolioItems.id));
    }

    const [workRows, portfolioRows, workCount, portfolioCount] = await Promise.all([
      this.db
        .select({
          sortKey: microsecondSortKey(workItems.createdAt),
          id: workItems.id,
          itemKey: workItems.itemKey,
          type: sql<string>`${workItems.type}::text`,
          title: workItems.title,
          scheduleState: sql<string>`${workItems.scheduleState}::text`,
          priority: sql<string>`${workItems.priority}::text`,
          assigneeId: workItems.assigneeId,
          assigneeName: sql<string | null>`assignee_user.display_name`,
          iterationId: workItems.iterationId,
          releaseId: workItems.releaseId,
          storyPoints: sql<number | null>`${workItems.storyPoints}::float8`,
          createdAt: workItems.createdAt,
          updatedAt: workItems.updatedAt,
        })
        .from(workItems)
        .leftJoin(sql`identity.users assignee_user`, sql`assignee_user.id = work_items.assignee_id`)
        .where(and(...workConditions))
        .orderBy(desc(workItems.createdAt), asc(workItems.id))
        .limit(args.limit + 1),
      this.db
        .select({
          sortKey: microsecondSortKey(portfolioItems.createdAt),
          id: portfolioItems.id,
          itemKey: portfolioItems.itemKey,
          type: sql<string>`${portfolioItems.type}::text`,
          title: portfolioItems.name,
          scheduleState: sql<string>`''`,
          priority: sql<string>`''`,
          assigneeId: portfolioItems.ownerId,
          assigneeName: sql<string | null>`owner_user.display_name`,
          iterationId: sql<string | null>`null::uuid`,
          releaseId: portfolioItems.releaseId,
          storyPoints: sql<number | null>`null::float8`,
          createdAt: portfolioItems.createdAt,
          updatedAt: portfolioItems.updatedAt,
        })
        .from(portfolioItems)
        .leftJoin(sql`identity.users owner_user`, sql`owner_user.id = portfolio_items.owner_id`)
        .where(and(...portfolioConditions))
        .orderBy(desc(portfolioItems.createdAt), asc(portfolioItems.id))
        .limit(args.limit + 1),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(workItems)
        .where(and(...workCountConditions)),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(portfolioItems)
        .where(and(...portfolioCountConditions)),
    ]);

    const merged = [...workRows, ...portfolioRows].sort(bySortKeyDesc).slice(0, args.limit + 1);
    const total = Number(workCount[0]?.total ?? 0) + Number(portfolioCount[0]?.total ?? 0);

    return buildPageResult(
      merged.map((r) => ({
        id: r.id,
        itemKey: r.itemKey,
        type: r.type,
        title: r.title,
        scheduleState: r.scheduleState,
        priority: r.priority,
        assigneeId: r.assigneeId,
        assigneeName: r.assigneeName,
        iterationId: r.iterationId,
        releaseId: r.releaseId,
        storyPoints: r.storyPoints === null ? null : Number(r.storyPoints),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
      args.limit,
      (w) => [w.createdAt.toISOString()],
      'desc',
      total,
    );
  }

  // The snapshot WRITER deliberately does not live here.
  //
  // `upsertReleaseSnapshot` used to sit at this spot and had no caller anywhere — the
  // daily cron only ever snapshotted iterations — so `release_daily_snapshots` was
  // empty in every environment and this read has always returned `[]`. It also counted
  // `Completed` as done (COMPLETED_SCHEDULE_STATES), which is the wrong population for
  // Release Tracking: RT-AC-08 admits {Accepted, Release} only.
  //
  // Phase 6 makes the burnup a per-(release, team scope, day) series that also carries
  // the top-down Preliminary Feature estimate, so writing it needs the portfolio
  // classification and the workspace's preliminary-estimate map. That belongs to the
  // reporting module, which owns those rules; a second writer here would be the drift
  // the single-source-of-truth convention exists to prevent.
}
