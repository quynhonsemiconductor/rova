import { Inject, Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import {
  InjectDrizzle,
  NotFoundException,
  PreconditionFailedException,
  buildPageResult,
} from '@platform';
import type { JwtPayload, CursorPayload, PagedResult, DrizzleDB } from '@platform';
import { and, asc, desc, eq, isNull, sql, inArray, type Column, type SQL } from 'drizzle-orm';
import { ProjectsService } from '@modules/projects';
import { AccessService } from '@modules/access';
import {
  workItems,
  portfolioItems,
  milestones,
  milestoneArtifacts,
  milestoneReleases,
  releases,
  projects,
  teams,
} from '../../../../../db/schema/work';
import { completedScheduleStatesSql } from '../../../../../db/schema/enums';
import { IMilestoneRepository, MILESTONE_REPOSITORY } from '../domain/ports/milestone.repository';
import type {
  Milestone,
  MilestoneOption,
  MilestoneStatus,
  UpdateMilestoneInput,
} from '../domain/milestone.types';
import { ActivityLogger, type ActivityLog } from '@modules/activity';
import { MILESTONE_ACTIVITY_CONFIG } from './milestone-activity-diff';

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

export interface MilestoneProgress {
  totalItems: number;
  completedItems: number;
  totalPoints: number;
  completedPoints: number;
  /** Null when not computable — nothing estimated and not everything finished. */
  progressPercent: number | null;
}

/**
 * One row of the Milestone Artifacts dashboard.
 *
 * Deliberately the same column set `ReleasesService.listReleaseArtifacts` returns plus
 * `assigneeName`: the SPA renders both through one shared table, whose Owner column had nothing to
 * read on either surface.
 *
 * `scheduleState` and `priority` are `''` for a PORTFOLIO row, and `storyPoints` is null — a
 * Feature or Epic carries none of the three. Its `state` is a different axis from a Story's Schedule
 * State, `portfolio_items` has no priority column at all, and a portfolio forecast is the tiered
 * top-down estimate the Portfolio surface resolves (AC-014) rather than a leaf Plan Estimate; Rally
 * keeps those apart as `Plan Estimate` and `Leaf Story Plan Estimate Total`. `''` is not a member of
 * either enum, so nothing can mistake it for a value. See `ReleaseArtifactRow`, which says the same
 * for the same reason on the same shared table.
 */
export interface MilestoneArtifactRow {
  id: string;
  itemKey: string;
  type: string;
  title: string;
  scheduleState: string;
  priority: string;
  assigneeId: string | null;
  assigneeName: string | null;
  storyPoints: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A MICROSECOND, lexicographically ordered rendering of a timestamp, used to merge two tables'
 * pages into one order. Duplicated from `ReleasesService` deliberately — one line of SQL in each
 * of two modules, rather than a new cross-module export for it.
 *
 * `Date.getTime()` is MILLISECONDS and `timestamptz` is microseconds — the precision mismatch
 * `keysetCondition`'s own docblock is built around. Sorting the merged rows on `getTime()` would tie
 * two rows the database orders strictly, so the row a page ends on would not be the row the database
 * calls last and the next cursor would skip the straddling row for ever.
 */
function microsecondSortKey(col: Column): SQL<string> {
  return sql<string>`to_char(${col} at time zone 'UTC', 'YYYYMMDDHH24MISSUS')`;
}

/** Newest-first on the exact timestamp, id ascending — the `ORDER BY` both branches carry. */
function bySortKeyDesc(a: { sortKey: string; id: string }, b: { sortKey: string; id: string }) {
  if (a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

interface ReleaseStats {
  totalItems: number;
  completedItems: number;
  totalPoints: number;
  completedPoints: number;
}

/**
 * Valid status transitions. SRS FR-006 enumerates the milestone statuses but
 * does not prescribe a transition graph, so we keep the lifecycle permissive:
 * any status may move to any OTHER status, with `completed` as the single
 * terminal state (a completed milestone is done and cannot be reopened). This
 * avoids trapping users in the previous restrictive graph (e.g. a `met`
 * milestone that could only go to `completed`) while still preventing the one
 * invariant the product needs — no resurrection of a completed milestone.
 * NOTE for BA sign-off: confirm whether any additional terminal/locked states
 * are required; this graph is intentionally the least-restrictive safe default.
 */
const ALL_MILESTONE_STATUSES: MilestoneStatus[] = [
  'planned',
  'at_risk',
  'met',
  'missed',
  'cancelled',
  'completed',
];
const others = (self: MilestoneStatus): MilestoneStatus[] =>
  ALL_MILESTONE_STATUSES.filter((s) => s !== self);
const MILESTONE_TRANSITIONS: Record<MilestoneStatus, MilestoneStatus[]> = {
  planned: others('planned'),
  at_risk: others('at_risk'),
  met: others('met'),
  missed: others('missed'),
  cancelled: others('cancelled'),
  completed: [], // terminal — a completed milestone cannot be reopened
};

@Injectable()
export class MilestonesService {
  private readonly logger = new Logger(MilestonesService.name);

  constructor(
    @Inject(MILESTONE_REPOSITORY) private readonly milestoneRepo: IMilestoneRepository,
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly projectsService: ProjectsService,
    private readonly accessService: AccessService,
    private readonly activity: ActivityLogger,
  ) {}

  // ── Revision History (activity log) ─────────────────────────────────────────

  /** Newest-first revision history for one milestone (workspace-view gated). */
  async getMilestoneActivity(
    actor: JwtPayload,
    id: string,
    args: { limit: number; offset: number },
  ): Promise<{ items: ActivityLog[]; total: number }> {
    await this.getMilestoneForView(actor, id);
    const page = Math.floor(args.offset / args.limit) + 1;
    const res = await this.activity.listFor(id, actor.workspaceId, page, args.limit);
    return { items: res.data, total: res.total };
  }

  private milestoneSubject(m: Milestone) {
    return {
      workspaceId: m.workspaceId,
      projectId: m.projectId,
      entityType: 'milestone' as const,
      entityId: m.id,
    };
  }

  // ── List ──────────────────────────────────────────────────────────────────

  async listMilestones(
    actor: JwtPayload,
    projectId: string,
    args: { limit: number; cursor: CursorPayload | null },
  ): Promise<PagedResult<Milestone & { progress?: MilestoneProgress }>> {
    await this.projectsService.getProject(actor.workspaceId, projectId);
    const page = await this.milestoneRepo.listByProject(projectId, actor.workspaceId, args);

    const progressByMilestone = await this.computeProgressBatch(page.data);
    return {
      ...page,
      data: page.data.map((m) => ({ ...m, progress: progressByMilestone.get(m.id) ?? undefined })),
    };
  }

  /**
   * The REFERENCE feed — every milestone in the project, projected to what a picker needs.
   *
   * Split out of {@link listMilestones} because that one is the `Plan > Milestones` administration
   * grid's feed and takes `milestone:view`, which §3.2 withholds from an Editor (it marks the whole
   * `Timeboxes` surface Hidden for one) — and it was ALSO the only feed for the Milestones column and
   * picker on Iteration Status and on the Work Item detail sidebar, both Editor surfaces. Every one of
   * those consumers defaults a failed request to `[]`, so an item's real milestones rendered as none
   * and none could be added. Same defect, same split and same reasoning as
   * `GET /releases/options` and `GET /projects/:id/member-options`.
   *
   * No progress computed here: `computeProgressBatch` aggregates work items for a number a picker does
   * not show, and it is administration data an Editor must not read. So this is also the cheap call.
   */
  async listMilestoneOptions(actor: JwtPayload, projectId: string): Promise<MilestoneOption[]> {
    await this.projectsService.getProject(actor.workspaceId, projectId);
    return this.milestoneRepo.listOptionsByProject(projectId, actor.workspaceId);
  }

  /**
   * Single guard that every milestone link write funnels through: the linked
   * projects, teams and releases must all belong to the actor's workspace.
   * Mirrors the tenant-isolation rule enforced for project\u2194team links
   * (ProjectsService.linkTeam) so a milestone can never reference an entity
   * from another workspace/tenant. Each set is validated with one COUNT query;
   * a size mismatch means at least one id is foreign (or does not exist).
   */
  private async assertLinksInWorkspace(
    workspaceId: string,
    links: { projectIds?: string[]; teamIds?: string[]; releaseIds?: string[] },
  ): Promise<void> {
    const projectIds = [...new Set(links.projectIds ?? [])];
    const teamIds = [...new Set(links.teamIds ?? [])];
    const releaseIds = [...new Set(links.releaseIds ?? [])];

    if (projectIds.length > 0) {
      const rows = await this.db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            inArray(projects.id, projectIds),
            eq(projects.workspaceId, workspaceId),
            isNull(projects.deletedAt),
          ),
        );
      if (rows.length !== projectIds.length) {
        throw new PreconditionFailedException(
          'MILESTONE_PROJECT_NOT_IN_WORKSPACE',
          'One or more projects do not belong to this workspace',
        );
      }
    }

    if (teamIds.length > 0) {
      const rows = await this.db
        .select({ id: teams.id })
        .from(teams)
        .where(and(inArray(teams.id, teamIds), eq(teams.workspaceId, workspaceId)));
      if (rows.length !== teamIds.length) {
        throw new PreconditionFailedException(
          'MILESTONE_TEAM_NOT_IN_WORKSPACE',
          'One or more teams do not belong to this workspace',
        );
      }
    }

    if (releaseIds.length > 0) {
      const rows = await this.db
        .select({ id: releases.id })
        .from(releases)
        .where(and(inArray(releases.id, releaseIds), eq(releases.workspaceId, workspaceId)));
      if (rows.length !== releaseIds.length) {
        throw new PreconditionFailedException(
          'MILESTONE_RELEASE_NOT_IN_WORKSPACE',
          'One or more releases do not belong to this workspace',
        );
      }
    }
  }

  // ── Recalculate target dates from linked releases ──────────────────────

  /**
   * Derive targetStartDate / targetEndDate from the linked releases
   * (MIN start / MAX release date) and persist them — but ONLY while at least
   * one Release is linked. With no linked Release the milestone's dates are
   * user-managed (reconciled SRS §2 / P3-MS-019), so this is a no-op and the
   * manually-entered dates are left untouched.
   */
  private async recalcTargetDates(milestoneId: string, workspaceId: string): Promise<void> {
    const result = await this.db
      .select({
        startDate: sql<string | null>`MIN(${releases.startDate})`,
        endDate: sql<string | null>`MAX(${releases.releaseDate})`,
        linked: sql<number>`COUNT(${releases.id})`,
      })
      .from(milestoneReleases)
      .innerJoin(releases, eq(milestoneReleases.releaseId, releases.id))
      .where(
        and(eq(milestoneReleases.milestoneId, milestoneId), eq(releases.workspaceId, workspaceId)),
      );

    const row = result[0];
    // No linked Release → dates are manual; do not override or clear them.
    if (!row || Number(row.linked) === 0) return;

    await this.db
      .update(milestones)
      .set({ targetStartDate: row.startDate, targetEndDate: row.endDate, updatedAt: new Date() })
      .where(eq(milestones.id, milestoneId));
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async createMilestone(
    actor: JwtPayload,
    projectId: string,
    name: string,
    opts: {
      description?: string;
      notes?: string;
      status?: string;
      ownerId?: string;
      targetStartDate?: string;
      targetEndDate?: string;
      releaseIds?: string[];
      projectIds?: string[];
      teamIds?: string[];
    } = {},
  ): Promise<Milestone> {
    await this.projectsService.assertProjectWritable(actor.workspaceId, projectId);

    // Tenant isolation: every linked project/team/release must live in this
    // workspace before we persist any link (defense in depth beyond RLS).
    await this.assertLinksInWorkspace(actor.workspaceId, {
      projectIds: opts.projectIds,
      teamIds: opts.teamIds,
      releaseIds: opts.releaseIds,
    });

    const releaseIds = opts.releaseIds ?? [];

    // milestoneKey reservation reads MAX(existing) + 1 (not atomic under
    // concurrent creates) and milestones can be deleted, so a collision on
    // uq_milestones_key is possible; retry once with a freshly computed key.
    // Only the create is retried — link writes below run once, after success.
    const MAX_KEY_RETRIES = 2;
    let milestone: Milestone | undefined;
    let lastErr: unknown;

    for (let attempt = 0; attempt < MAX_KEY_RETRIES; attempt++) {
      const keyNumber = await this.milestoneRepo.nextKeyNumber(projectId, actor.workspaceId);
      try {
        milestone = await this.milestoneRepo.create({
          id: uuidv7(),
          workspaceId: actor.workspaceId,
          projectId,
          milestoneKey: `MS-${keyNumber}`,
          name,
          description: opts.description,
          notes: opts.notes,
          status: (opts.status as MilestoneStatus) ?? 'planned',
          ownerId: opts.ownerId,
          // Manual dates persist; recalcTargetDates below overrides them only
          // when releases are linked (reconciled SRS §2).
          targetStartDate: opts.targetStartDate,
          targetEndDate: opts.targetEndDate,
          releaseIds,
          projectIds: opts.projectIds,
          teamIds: opts.teamIds,
        });
        break;
      } catch (err: unknown) {
        lastErr = err;
        if (isDuplicateKeyError(err) && attempt < MAX_KEY_RETRIES - 1) {
          this.logger.warn(
            { projectId, attempt: attempt + 1 },
            'Duplicate milestone key — retrying',
          );
          continue;
        }
        throw err;
      }
    }

    if (!milestone) throw lastErr;

    if (releaseIds.length > 0) {
      await this.milestoneRepo.setReleaseLinks(milestone.id, releaseIds);
    }
    if (opts.projectIds?.length) {
      await this.milestoneRepo.setProjectLinks(milestone.id, opts.projectIds);
    }
    if (opts.teamIds?.length) {
      await this.milestoneRepo.setTeamLinks(milestone.id, opts.teamIds);
    }

    // Derive target dates from linked releases (read-only) when any are linked;
    // otherwise the manual dates set above are kept (recalc is a no-op).
    await this.recalcTargetDates(milestone.id, actor.workspaceId);

    const final = await this.milestoneRepo.findById(milestone.id);
    this.logger.log(
      { milestoneId: milestone.id, projectId, userId: actor.sub },
      'Milestone created',
    );
    await this.activity.logSafe([
      this.activity.build(this.milestoneSubject(final!), actor.sub, 'milestone.created', null),
    ]);
    return final!;
  }

  // ── Get ───────────────────────────────────────────────────────────────────

  /**
   * Load a milestone for a READ, enforcing `milestone:view` at its project scope
   * — not just workspace membership — so a user scoped to one project cannot read
   * another project's milestones in the same workspace. Mirrors getWorkItemForView.
   */
  async getMilestoneForView(
    actor: JwtPayload,
    id: string,
  ): Promise<Milestone & { progress?: MilestoneProgress }> {
    // Project-scoped milestone:view is enforced by the PolicyGuard at the route
    // (resource-resolved from :id); this just loads the row.
    return this.getMilestone(actor.workspaceId, id);
  }

  /**
   * Load a milestone (with its Project/Team/Release links) or refuse. The workspace check is
   * the isolation boundary here — `findById` is deliberately unscoped, so every caller has to
   * apply it, and one place that does is better than several that might.
   */
  private async requireMilestone(workspaceId: string, id: string): Promise<Milestone> {
    const milestone = await this.milestoneRepo.findById(id);
    if (!milestone || milestone.workspaceId !== workspaceId) {
      throw new NotFoundException('MILESTONE_NOT_FOUND', 'Milestone not found');
    }
    return milestone;
  }

  async getMilestone(
    workspaceId: string,
    id: string,
  ): Promise<Milestone & { progress?: MilestoneProgress }> {
    const milestone = await this.requireMilestone(workspaceId, id);

    /**
     * No repair on the read path any more.
     *
     * This used to call `recalcTargetDates` on every GET, which is why the detail page looked correct
     * while `listMilestones` showed a stale window — the surface a reviewer checks was the one that
     * healed itself. The derived window is maintained by migration 0097's triggers now, on all three
     * writes that can invalidate it (a release date edit, a link add/remove, a manual write to a linked
     * milestone), so a read is just a read and both surfaces agree.
     */
    const progress = await this.computeProgress(milestone.releaseIds);
    return { ...milestone, progress: progress ?? undefined };
  }

  /**
   * Compute progress across all releases linked to a milestone.
   */
  private async computeProgress(releaseIds: string[]): Promise<MilestoneProgress | null> {
    if (releaseIds.length === 0) return null;
    const byRelease = await this.fetchReleaseStats(releaseIds);
    return this.aggregateProgress(releaseIds, byRelease);
  }

  /**
   * Compute progress for many milestones at once (one query for all releases
   * involved, instead of N+1 per-milestone queries on the list page).
   */
  private async computeProgressBatch(
    milestones: Milestone[],
  ): Promise<Map<string, MilestoneProgress>> {
    const allReleaseIds = [...new Set(milestones.flatMap((m) => m.releaseIds))];
    const byRelease = await this.fetchReleaseStats(allReleaseIds);

    const result = new Map<string, MilestoneProgress>();
    for (const m of milestones) {
      const progress = this.aggregateProgress(m.releaseIds, byRelease);
      if (progress) result.set(m.id, progress);
    }
    return result;
  }

  /** Per-release work-item stats, grouped by `releaseId`. */
  private async fetchReleaseStats(releaseIds: string[]): Promise<Map<string, ReleaseStats>> {
    if (releaseIds.length === 0) return new Map();

    const stats = await this.db
      .select({
        releaseId: workItems.releaseId,
        totalItems: sql<number>`COUNT(*)`,
        completedItems: sql<number>`COUNT(*) FILTER (WHERE schedule_state IN (${completedScheduleStatesSql()}))`,
        totalPoints: sql<number>`COALESCE(SUM(CASE WHEN story_points IS NOT NULL THEN story_points ELSE 0 END), 0)`,
        completedPoints: sql<number>`COALESCE(SUM(CASE WHEN schedule_state IN (${completedScheduleStatesSql()}) THEN story_points ELSE 0 END), 0)`,
      })
      .from(workItems)
      .where(
        and(
          inArray(workItems.releaseId, releaseIds),
          isNull(workItems.deletedAt),
          sql`type IN ('story', 'defect')`,
        ),
      )
      .groupBy(workItems.releaseId);

    return new Map(
      stats.filter((s) => s.releaseId !== null).map((s) => [s.releaseId as string, s]),
    );
  }

  private aggregateProgress(
    releaseIds: string[],
    byRelease: Map<string, ReleaseStats>,
  ): MilestoneProgress | null {
    if (releaseIds.length === 0) return null;

    let totalItems = 0;
    let completedItems = 0;
    let totalPoints = 0;
    let completedPoints = 0;
    for (const releaseId of releaseIds) {
      const s = byRelease.get(releaseId);
      if (!s) continue;
      totalItems += Number(s.totalItems);
      completedItems += Number(s.completedItems);
      totalPoints += Number(s.totalPoints);
      completedPoints += Number(s.completedPoints);
    }

    // NULL, not 0, when there is nothing to divide by. 0% asserts "none of this work is
    // done"; an unestimated milestone deserves "cannot tell". The all-items-done shortcut
    // stays: every item complete IS 100% whether or not anyone estimated it.
    const progressPercent =
      totalPoints > 0
        ? Math.min(Math.round((completedPoints / totalPoints) * 100), 100)
        : totalItems > 0 && completedItems === totalItems
          ? 100
          : null;

    return { totalItems, completedItems, totalPoints, completedPoints, progressPercent };
  }

  // ── Update ────────────────────────────────────────────────────────────────

  async updateMilestone(
    actor: JwtPayload,
    id: string,
    input: UpdateMilestoneInput,
  ): Promise<Milestone> {
    const milestone = await this.getMilestone(actor.workspaceId, id);
    await this.projectsService.assertProjectWritable(actor.workspaceId, milestone.projectId);

    // Validate status transition
    if (input.status && input.status !== milestone.status) {
      const allowed = MILESTONE_TRANSITIONS[milestone.status] ?? [];
      if (!allowed.includes(input.status)) {
        throw new PreconditionFailedException(
          'MILESTONE_INVALID_TRANSITION',
          `Invalid milestone transition: ${milestone.status} → ${input.status}. Allowed: ${allowed.join(', ') || 'none (terminal)'}`,
        );
      }
    }

    if (input.releaseIds !== undefined) {
      await this.assertLinksInWorkspace(actor.workspaceId, { releaseIds: input.releaseIds });
      await this.milestoneRepo.setReleaseLinks(id, input.releaseIds);
    }
    if (input.projectIds !== undefined) {
      await this.assertLinksInWorkspace(actor.workspaceId, { projectIds: input.projectIds });
      await this.milestoneRepo.setProjectLinks(id, input.projectIds);
    }
    if (input.teamIds !== undefined) {
      await this.assertLinksInWorkspace(actor.workspaceId, { teamIds: input.teamIds });
      await this.milestoneRepo.setTeamLinks(id, input.teamIds);
    }

    // Persist the patch (manual target dates included). recalcTargetDates then
    // overrides the dates with the derived Release window IFF releases are
    // linked; with none linked the manual dates just written are kept (SRS §2).
    const updated = await this.milestoneRepo.update(id, input);
    await this.recalcTargetDates(id, actor.workspaceId);
    const final = (await this.milestoneRepo.findById(id)) ?? updated;
    const [releaseIds, projectIds, teamIds] = await Promise.all([
      this.milestoneRepo.getReleaseIds(id),
      this.milestoneRepo.getProjectIds(id),
      this.milestoneRepo.getTeamIds(id),
    ]);
    await this.activity.logSafe(
      this.activity.buildDiff(
        this.milestoneSubject(final),
        actor.sub,
        milestone as unknown as Record<string, unknown>,
        input as Record<string, unknown>,
        MILESTONE_ACTIVITY_CONFIG,
        'milestone.updated',
      ),
    );
    return { ...final, releaseIds, projectIds, teamIds };
  }

  // ── Artifact management (P3.3) ──────────────────────────────────────

  async getMilestoneArtifacts(actor: JwtPayload, milestoneId: string): Promise<string[]> {
    await this.getMilestoneForView(actor, milestoneId);
    return this.milestoneRepo.getArtifactIds(milestoneId);
  }

  /**
   * The Artifacts dashboard's ROWS — the same shape `ReleasesService.listReleaseArtifacts` serves,
   * because both feed the one shared `ArtifactsTabView`/`ArtifactTable` on the SPA side.
   *
   * `getMilestoneArtifacts` above answers with link IDS, which is what the replace-set picker needs
   * and what this route used to return. The tab cannot render an id: it wants key, title, schedule
   * state, priority, owner and estimate, paged and searchable. So the SPA read the ids response as
   * `{ data, pageInfo }`, got `undefined` for both, and the Milestone Artifacts tab rendered "No
   * artifacts linked to this milestone" for every milestone — including the seeded `MS-1`, which has
   * had a linked story since the demo fixture was written. Two shapes, one route, and the mismatch
   * was invisible because the empty state is a legitimate answer.
   *
   * `q` is honoured here (item key or title), unlike on the release side, because the shared toolbar
   * puts a search box above this table and sends the term.
   *
   * THE TABLE IS POLYMORPHIC AND THIS READ WAS NOT (`GAP-P3-MS-002`). `milestone_artifacts` became
   * `(entity_type, entity_id)` in migration 0084 because "a milestone can be assigned to a work item
   * OR to a portfolio item" — the Feature/Epic detail rail writes `'portfolio_item'` rows and reads
   * them back, which is why the Feature shows its Milestone. This query hardcoded
   * `entity_type = 'work_item'`, so there were two writers and one reader: FE-6 assigned to MS-1
   * persisted, displayed on the Feature, and was absent from MS-1's own Artifacts tab.
   *
   * INHERITED DESCENDANTS ARE COMPUTED ON READ, and only on read. A Feature or Epic assigned to a
   * milestone brings its leaf Stories/Defects into the milestone's display scope — which is what
   * Rally's own milestone Artifacts roll-ups mean by `Leaf Story Plan Estimate Total` and
   * `Accepted Leaf Story Count`. Three reasons it is not materialised into link rows:
   *   • `portfolio_items` already computes every rollup on read for a stated reason (`work.ts`: Rally
   *     stores its rollups and consequently ships a "Correct rollup discrepancy" action to repair
   *     drift; computing on read means that cannot happen). This is the same aggregate, on the same
   *     hierarchy, one table over.
   *   • materialised rows would need triggers on `work_items.feature_id`, on `portfolio_items.parent_id`
   *     and on every insert into either — and `db/seeds/**` writes both directly.
   *   • worse, `getArtifactIds` feeds the §5.2 replace-SET picker. Inherited rows in that list would
   *     come back as DIRECT links on the next save, silently promoting a descendant to an assignment
   *     the user never made.
   * Note this is a derived VIEW, not the read-repair the working notes warn about: nothing is
   * written, so no other reader can go stale.
   *
   * ONCE, NOT TWICE. "Descendants enter the inherited scope once, without duplicate counting" is
   * structural here rather than a de-duplication pass: the work-item branch is ONE scan of
   * `work_items` whose predicate is `directly linked OR reachable through a linked Feature/Epic`, so a
   * Story that is both cannot produce two rows and cannot be counted twice. A `UNION` of two
   * work-item selects plus a `DISTINCT` would have been the same population by a route where the
   * count and the rows could disagree.
   *
   * TWO BRANCHES, `limit + 1` EACH, merged. See `ReleasesService.listReleaseArtifacts`: each branch
   * is paged under the same keyset predicate and the same `ORDER BY`, and the merge takes `limit + 1`
   * of the union, which is exact. A per-branch `limit` would silently truncate. The two branches are
   * different TABLES, so their counts sum.
   *
   * No `type` predicate on the work-item branch, deliberately, because the previous query had none:
   * `assertArtifactsInMilestoneScope` refuses anything but a Story or Defect today, but the work-item
   * write path enforced less than that before it was unified, so a Task-typed row may exist in an
   * older database and hiding a link that really is there is not this read's job. The inherited half
   * needs no predicate either — `feature_id` is a leaf-item column.
   */
  async listMilestoneArtifacts(
    actor: JwtPayload,
    milestoneId: string,
    args: { limit: number; cursor: CursorPayload | null; q?: string },
  ): Promise<PagedResult<MilestoneArtifactRow>> {
    await this.getMilestoneForView(actor, milestoneId);

    /** The milestone's DIRECT work-item links — the set that decides `direct` from `inherited`. */
    const directWorkItemIds = sql`(
      select ma.entity_id from ${milestoneArtifacts} ma
      where ma.milestone_id = ${milestoneId} and ma.entity_type = 'work_item'
    )`;
    /**
     * Its DIRECT portfolio links. `milestone_artifacts` carries no `workspace_id`, so the tenant
     * predicate rides on the joined row — the same reason the portfolio repository's own reader
     * joins `milestones` for it. Archived items are excluded here, which is what also keeps an
     * archived Feature's children out of the inherited set below.
     */
    const directPortfolioIds = sql`(
      select pi.id from ${milestoneArtifacts} ma
      join ${portfolioItems} pi on pi.id = ma.entity_id
      where ma.milestone_id = ${milestoneId}
        and ma.entity_type = 'portfolio_item'
        and pi.workspace_id = ${actor.workspaceId}
        and pi.archived_at is null
    )`;
    /**
     * The Features whose leaves are inherited: a directly linked Feature, plus the child Features of
     * a directly linked Epic. TWO LEVELS and no more, and the same shape as
     * `PortfolioItemDrizzleRepository.rollupSubqueries()`'s `linked` predicate — a work item attaches
     * to the LOWEST portfolio level only, so a Story never names an Epic and an Epic is reached
     * through its Features. Reusing that shape is what keeps a milestone's inherited set and a
     * Feature's own rollup describing the same children.
     */
    const inheritedFeatureIds = sql`(
      select pf.id from ${portfolioItems} pf
      where pf.archived_at is null
        and (pf.id in ${directPortfolioIds} or pf.parent_id in ${directPortfolioIds})
    )`;

    const term = args.q?.trim();
    const like = term ? `%${term}%` : null;

    const workConditions = [
      eq(workItems.workspaceId, actor.workspaceId),
      isNull(workItems.deletedAt),
      sql`(${workItems.id} in ${directWorkItemIds} or ${workItems.featureId} in ${inheritedFeatureIds})`,
    ];
    if (like) {
      workConditions.push(
        sql`(${workItems.itemKey} ilike ${like} or ${workItems.title} ilike ${like})`,
      );
    }

    const portfolioConditions = [sql`${portfolioItems.id} in ${directPortfolioIds}`];
    if (like) {
      portfolioConditions.push(
        sql`(${portfolioItems.itemKey} ilike ${like} or ${portfolioItems.name} ilike ${like})`,
      );
    }

    // Totals before the cursor/limit, for the footer count.
    const workCountConditions = [...workConditions];
    const portfolioCountConditions = [...portfolioConditions];

    if (args.cursor) {
      // The boundary is resolved IN the database from whichever table holds the cursor's row —
      // `keysetCondition` reads it from one table only, and a `timestamptz` must not round-trip
      // through the cursor at millisecond precision. See the release side for the full account.
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

  async setMilestoneArtifacts(
    actor: JwtPayload,
    milestoneId: string,
    workItemIds: string[],
  ): Promise<string[]> {
    const milestone = await this.getMilestone(actor.workspaceId, milestoneId);
    // PRJ-FR-010. `createMilestone`, `updateMilestone` and `deleteMilestone` carried this rule and
    // the four replace-SET writes below did not, so an archived project's milestones kept their
    // artifacts, projects, teams and releases fully editable — and the release set additionally
    // rewrites the milestone's own target window (FR-011/012).
    await this.projectsService.assertProjectWritable(actor.workspaceId, milestone.projectId);
    const uniqueIds = [...new Set(workItemIds)];
    if (uniqueIds.length > 0) {
      const rows = await this.db
        .select({
          id: workItems.id,
          projectId: workItems.projectId,
          teamId: workItems.teamId,
          type: workItems.type,
        })
        .from(workItems)
        .where(
          and(
            inArray(workItems.id, uniqueIds),
            eq(workItems.workspaceId, actor.workspaceId),
            isNull(workItems.deletedAt),
          ),
        );
      // A missing row is an id naming no live work item in this workspace. Reported as a scope
      // mismatch rather than a 404 because this is a replace-SET: the write is refused whole and
      // an unresolvable id is, from here, indistinguishable from one outside the scope.
      if (rows.length !== uniqueIds.length) {
        throw new PreconditionFailedException(
          'MILESTONE_PROJECT_MISMATCH',
          'One or more work items do not belong to this milestone\u2019s project scope',
        );
      }
      // Project, artifact TYPE and Team scope are all decided in ONE place, because the
      // work-item side writes the same rows — see assertArtifactsInMilestoneScope.
      assertArtifactsInMilestoneScope(milestone, rows);
    }
    await this.milestoneRepo.setArtifactLinks(milestoneId, uniqueIds);
    return this.milestoneRepo.getArtifactIds(milestoneId);
  }

  /**
   * The artifact-scope rule, applied from the WORK-ITEM side of the same link table
   * (`PUT /work-items/:id/milestones` → `WorkItemsService.setWorkItemMilestones`).
   *
   * It lives here, and the milestone is loaded here, because the rule reads the Milestone's
   * scope — its owning project plus its selected Projects and Teams. The caller passes the
   * work items it wants linked; N milestones × the caller's items is the same cross product
   * the milestone-side write checks with 1 milestone × N items.
   */
  async assertArtifactsAssignable(
    workspaceId: string,
    milestoneIds: string[],
    candidates: readonly MilestoneArtifactCandidate[],
  ): Promise<void> {
    for (const milestoneId of [...new Set(milestoneIds)]) {
      const milestone = await this.requireMilestone(workspaceId, milestoneId);
      /**
       * The archived-project rule is checked from this side too, and it has to be.
       *
       * `milestone_artifacts` has two write paths and the whole point of this method is that they
       * cannot answer differently — the docblock below records what happened the last time one of
       * them enforced less than the other. `setMilestoneArtifacts` refuses an archived project, so
       * without this a caller could add the same row from `PUT /work-items/:id/milestones` instead:
       * the work item's own project is checked by `WorkItemsService`, but the MILESTONE's may be a
       * different one (its scope spans `milestone_projects`), and that one would go unchecked.
       */
      await this.projectsService.assertProjectWritable(workspaceId, milestone.projectId);
      assertArtifactsInMilestoneScope(milestone, candidates);
    }
  }

  async getMilestoneProjects(actor: JwtPayload, milestoneId: string): Promise<string[]> {
    await this.getMilestoneForView(actor, milestoneId);
    return this.milestoneRepo.getProjectIds(milestoneId);
  }

  async setMilestoneProjects(
    actor: JwtPayload,
    milestoneId: string,
    projectIds: string[],
  ): Promise<string[]> {
    const milestone = await this.getMilestone(actor.workspaceId, milestoneId);
    await this.projectsService.assertProjectWritable(actor.workspaceId, milestone.projectId);
    await this.assertLinksInWorkspace(actor.workspaceId, { projectIds });
    await this.milestoneRepo.setProjectLinks(milestoneId, projectIds);
    return this.milestoneRepo.getProjectIds(milestoneId);
  }

  async getMilestoneTeams(actor: JwtPayload, milestoneId: string): Promise<string[]> {
    await this.getMilestoneForView(actor, milestoneId);
    return this.milestoneRepo.getTeamIds(milestoneId);
  }

  async setMilestoneTeams(
    actor: JwtPayload,
    milestoneId: string,
    teamIds: string[],
  ): Promise<string[]> {
    const milestone = await this.getMilestone(actor.workspaceId, milestoneId);
    await this.projectsService.assertProjectWritable(actor.workspaceId, milestone.projectId);
    await this.assertLinksInWorkspace(actor.workspaceId, { teamIds });
    await this.milestoneRepo.setTeamLinks(milestoneId, teamIds);
    return this.milestoneRepo.getTeamIds(milestoneId);
  }

  async getMilestoneReleases(actor: JwtPayload, milestoneId: string): Promise<string[]> {
    await this.getMilestoneForView(actor, milestoneId);
    return this.milestoneRepo.getReleaseIds(milestoneId);
  }

  async setMilestoneReleases(
    actor: JwtPayload,
    milestoneId: string,
    releaseIds: string[],
  ): Promise<string[]> {
    const milestone = await this.getMilestone(actor.workspaceId, milestoneId);
    await this.projectsService.assertProjectWritable(actor.workspaceId, milestone.projectId);
    await this.assertLinksInWorkspace(actor.workspaceId, { releaseIds });
    await this.milestoneRepo.setReleaseLinks(milestoneId, releaseIds);
    // Target dates are derived from the linked releases (SRS FR-011/012), so
    // recompute them whenever the release set changes.
    await this.recalcTargetDates(milestoneId, actor.workspaceId);
    return this.milestoneRepo.getReleaseIds(milestoneId);
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  async deleteMilestone(actor: JwtPayload, id: string): Promise<void> {
    const milestone = await this.getMilestone(actor.workspaceId, id);
    await this.projectsService.assertProjectWritable(actor.workspaceId, milestone.projectId);
    /**
     * The ASSOCIATIONS go, the artifacts stay — Rally: deleting a milestone "removes the association
     * from each work item… The work item itself is not deleted."
     *
     * `MilestoneDrizzleRepository.delete` does that itself, clearing all four junction tables before
     * deleting the row. Migration 0114 additionally gives each of them `ON DELETE CASCADE`, which is
     * a backstop rather than the mechanism: it covers the writers that bypass the repository
     * (`db/seeds/**`, raw SQL), and it closes a real gap in the repository, where those four deletes
     * and the milestone delete are five statements with no transaction around them.
     */
    await this.milestoneRepo.delete(id);
    this.logger.log({ milestoneId: id }, 'Milestone deleted; its artifact links are removed');
  }
}

/** The work-item half of one artifact link — everything the scope rule below reads. */
export interface MilestoneArtifactCandidate {
  projectId: string;
  teamId: string | null;
  type: string;
}

/** The milestone half: its owning project plus the Projects/Teams it additionally selects. */
export interface MilestoneArtifactScope {
  projectId: string;
  projectIds?: string[];
  teamIds?: string[];
}

/**
 * The ONE home of the artifact-link rule — `milestone_artifacts` has two write paths and they
 * must agree, because they write the same rows.
 *
 * `PUT /milestones/:id/artifacts` (one milestone, N work items) enforced all three conditions;
 * `PUT /work-items/:id/milestones` (one work item, N milestones) enforced only the first, and
 * not even in the same form. So a Task could be made a Milestone artifact, and an item on any
 * team could join a Team-scoped Milestone, as long as the request came in from the work-item
 * side — the Artifacts dashboard then rendered rows §5.1 says cannot exist, from a screen that
 * had refused to create them. Same class of defect as the two `@RequirePermission` gates chosen
 * for where the id lived: the rule was attached to a call site instead of to the link.
 *
 *   • project — an artifact must belong to one of the Milestone's Projects, which is its OWNING
 *     project plus any additionally linked ones (SRS §5.2 / FR-021/023). The work-item side used
 *     `milestones.project_id` alone, so a Milestone reachable from this project through
 *     `milestone_projects` was refused here and accepted there.
 *   • type — a Milestone Artifact is a Story or Defect (SRS §5.1 / FR-014). Initiatives,
 *     Features and Tasks are refused so the Artifacts dashboard stays the Backlog-shaped list
 *     the BA specified.
 *   • team — when the Milestone selects Team scope, an artifact must be on one of those Teams.
 *     A team-agnostic item (`teamId === null`) is OUT of a team scope, not exempt from it:
 *     unlike an actor-side authorization check, which asks whether the CALLER may write, this
 *     asks whether the WORK is inside a declared scope, and "no team" is not one of them.
 *
 * The prose is deliberately direction-neutral: one message has to read correctly whether the
 * caller named the milestone or the work item.
 */
export function assertArtifactsInMilestoneScope(
  milestone: MilestoneArtifactScope,
  candidates: readonly MilestoneArtifactCandidate[],
): void {
  if (candidates.length === 0) return;

  const projectScope = new Set<string>([milestone.projectId, ...(milestone.projectIds ?? [])]);
  if (candidates.some((c) => !projectScope.has(c.projectId))) {
    throw new PreconditionFailedException(
      'MILESTONE_PROJECT_MISMATCH',
      'A milestone artifact must belong to one of the milestone’s projects',
    );
  }

  if (candidates.some((c) => c.type !== 'story' && c.type !== 'defect')) {
    throw new PreconditionFailedException(
      'MILESTONE_INVALID_ARTIFACT_TYPE',
      'Only stories and defects can be assigned as milestone artifacts',
    );
  }

  const teamScope = milestone.teamIds ?? [];
  if (teamScope.length > 0) {
    const teamSet = new Set(teamScope);
    if (candidates.some((c) => c.teamId === null || !teamSet.has(c.teamId))) {
      throw new PreconditionFailedException(
        'MILESTONE_TEAM_MISMATCH',
        'A milestone artifact must belong to one of the milestone’s selected teams',
      );
    }
  }
}
