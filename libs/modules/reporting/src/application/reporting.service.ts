import { Inject, Injectable } from '@nestjs/common';
import { NotFoundException, parseSort } from '@platform';
import type { JwtPayload } from '@platform';
import { AccessService } from '@modules/access';
import { PreliminaryEstimateMapService } from '@modules/portfolio';
import { IReportingRepository, REPORTING_REPOSITORY } from '../domain/ports/reporting.repository';
import type { IterationRow } from '../domain/ports/reporting.repository';
import {
  buildBurndownSeries,
  carryInMarkers,
  combineTeamSnapshots,
  splitOutMarkers,
} from '../domain/burndown';
import {
  bucketFeatures,
  buildBurnup,
  derivedStatus,
  directStatus,
  featureProgress,
  isFullMismatch,
  refineBucket,
  releaseMismatches,
  releaseTotals,
  trackedLeaves,
  unparentedItems,
  RELEASE_TRACKING_PAGE_SIZE,
  RELEASE_TRACKING_SORT_FIELDS,
  type BucketSortKeys,
  type ChartUnit,
  type ReleaseBucket,
  type ReleaseChild,
  type ReleaseFeature,
} from '../domain/release-tracking';
import {
  endOfWorkspaceDay,
  restrictedTeamScope,
  teamScope,
  workspaceLocalDate,
  type TeamScope,
} from '../domain/report-scope';
import { describeEmptiness, rollUpTeamCapacity } from '../domain/team-capacity';
import {
  DEFAULT_VELOCITY_WINDOW,
  buildBar,
  computeAverages,
  selectWindow,
  type VelocityWindow,
} from '../domain/velocity';
import type {
  IterationBurndownReport,
  ReleaseBurnupReport,
  ReleaseTrackingReport,
  ReleaseTrackingRow,
  ReportContext,
  ReportTimebox,
  TeamCapacityReport,
  VelocityReport,
} from '../domain/reporting.types';

/** What every report calls the scope when no Team is selected (IB §7's context title). */
const ALL_TEAMS_LABEL = 'All Teams';

/**
 * What the DEFAULT scope is called for a reader who has no `All Teams` (BA ruling, 2026-08-17).
 *
 * `All Teams` would be a false claim on that screen twice over: it excludes every Team the reader
 * does not hold, and it excludes the Project Backlog (`team_id IS NULL`), which the ruling makes
 * admin-only. The scope a reader sees FIRST is the one that must not lie about what it counts —
 * which is exactly why `teamName ?? ''` was fixed to print a real label at all.
 *
 * A DECLARED new label, recorded here because the SPA prints this string verbatim through
 * `teamScopeLabel` and nothing else in the contract distinguishes the two defaults. `My Teams`
 * rather than a list of names: the roster can hold many teams, the header is a single line, and the
 * Team picker beside it is what names them.
 */
const MY_TEAMS_LABEL = 'My Teams';

interface ScopeArgs {
  projectId: string;
  teamId?: string | null;
}

/**
 * Assembly only. Every rule lives in `domain/`; this service resolves scope, asks the
 * repository for rows and hands them to the pure functions.
 *
 * The Project half of authorization is the PolicyGuard's (`report:view` on every route).
 * The Team half is enforced by construction: a selected Team is pushed into each query's
 * WHERE clause rather than filtered afterwards, because "hiding rows in the browser is not
 * sufficient authorization" (§5.2) applies just as much to hiding them in the service.
 *
 * THE TEAM HALF IS NOW A CEILING AS WELL AS A CHOICE
 *
 * Until the BA ruling of 2026-08-17 the Team was purely the reader's selection, so `teamScope(...)`
 * ran straight off the query string. It now has to be intersected with what the reader may see —
 * `AccessService.resolveTeamScope` — because "Editor … cannot access team-less items. Enforce this
 * consistently in API queries, lists, reports, search, pickers and direct URLs." `resolveScope`
 * below is the ONE place that happens, and every report method starts with it.
 */
@Injectable()
export class ReportingService {
  constructor(
    @Inject(REPORTING_REPOSITORY) private readonly repo: IReportingRepository,
    private readonly preliminaryEstimates: PreliminaryEstimateMapService,
    private readonly access: AccessService,
  ) {}

  // ── Iteration Burndown ────────────────────────────────────────────────────

  async getIterationBurndown(
    actor: JwtPayload,
    args: ScopeArgs & { iterationId: string },
  ): Promise<IterationBurndownReport> {
    const { workspaceId } = actor;
    const scope = await this.resolveScope(actor, args);
    const settings = await this.repo.getWorkspaceSettings(workspaceId);
    const selected = await this.requireIteration(actor, args, scope);

    // For All Teams this is every Team's iteration for the shared timebox; for a selected
    // Team it is that Team's alone. An empty result means the Team has no iteration in this
    // timebox — returning the other Teams' data would leak across the scope.
    const participating = await this.repo.findTimeboxSiblings(
      workspaceId,
      args.projectId,
      selected.timeboxGroupId,
      scope,
      selected.id,
    );
    const iterationIds = participating.map((i) => i.id);

    const [snapshots, scheduled, splitOutEvents, carryInEvents] = await Promise.all([
      this.repo.getIterationSnapshots(workspaceId, iterationIds, scope, settings.timeZone),
      this.repo.countScheduledWork(workspaceId, iterationIds, scope),
      /**
       * SU-08 8.2 — the two annotation sets, read for the WHOLE timebox rather than the selected
       * iteration alone.
       *
       * `iterationIds` is what the series is measured over: for All Teams that is every participating
       * Team's iteration for the shared timebox, and a Split that left one of them left this chart. A
       * marker sourced from `selected.id` alone would be missing from exactly the fused view the
       * numbers came from.
       *
       * Both directions, because ONE iteration can be both: work split out of it and work carried
       * into it from an earlier sprint are independent facts about the same window.
       */
      this.repo.findSplitsBySourceIteration(workspaceId, iterationIds, scope),
      this.repo.findSplitsByTargetIteration(workspaceId, iterationIds, scope),
    ]);

    const timebox = this.toTimebox(selected, participating);
    const series = buildBurndownSeries({
      startDate: timebox.startDate ?? '',
      endDate: timebox.endDate ?? '',
      workingDays: settings.workingDays,
      /**
       * "For All Teams, the baseline is the sum of the participating Team baselines." (IB §4)
       *
       * Read from `iteration_team_baselines` in the SAME scope the snapshots were measured in. It used
       * to sum `iterations.totalTaskEstimateAtStart` — one project-wide number per iteration — so a
       * team-scoped chart drew the whole project's Ideal against one team's bars, and §6's indicator
       * said "On track" for a team that had burned nothing.
       */
      totalTaskEstimateAtStart: await this.repo.sumTeamBaselines(workspaceId, iterationIds, scope),
      snapshots: combineTeamSnapshots(snapshots),
    });

    return {
      context: await this.context(actor, args, settings.timeZone, scope),
      timebox,
      points: series.points,
      totalTaskEstimateAtStart: series.totalTaskEstimateAtStart,
      historyState: series.historyState,
      status: series.status,
      latestSnapshotDate: series.latestSnapshotDate,
      partialCaptureDates: series.partialCaptureDates,
      // Distinguishes "no scheduled work" from "work exists, the job has not run" (IB §7).
      hasScheduledWork: scheduled > 0,
      /**
       * The Split annotations (SRS §10.2/§10.3). Empty arrays for a timebox no Split touched, which is
       * every timebox before Phase 7 — an empty array is the honest answer and needs no branch in the
       * SPA, where `null` would need two.
       */
      splitOut: splitOutMarkers(splitOutEvents),
      carryIn: carryInMarkers(carryInEvents),
    };
  }

  // ── Velocity ──────────────────────────────────────────────────────────────

  async getVelocity(
    actor: JwtPayload,
    args: ScopeArgs & { window?: VelocityWindow },
  ): Promise<VelocityReport> {
    const { workspaceId } = actor;
    const scope = await this.resolveScope(actor, args);
    const settings = await this.repo.getWorkspaceSettings(workspaceId);
    const window = args.window ?? DEFAULT_VELOCITY_WINDOW;

    // "its Workspace-local end date is before today" — today in the WORKSPACE's calendar,
    // not the server's, or a workspace east of UTC sees its just-closed iteration a day late.
    const today = workspaceLocalDate(new Date(), settings.timeZone);
    const eligible = await this.repo.findEligibleTimeboxes(
      workspaceId,
      args.projectId,
      scope,
      today,
    );
    const windowed = selectWindow(eligible, window);

    const items = await this.repo.getVelocityItems(
      workspaceId,
      windowed.flatMap((t) => t.iterationIds),
      scope,
    );
    const byIteration = new Map<string, typeof items>();
    for (const item of items) {
      const list = byIteration.get(item.iterationId);
      if (list) list.push(item);
      else byIteration.set(item.iterationId, [item]);
    }

    const bars = windowed.map((timebox) =>
      buildBar({
        timeboxKey: timebox.timeboxGroupId ?? timebox.iterationIds[0],
        name: timebox.name,
        startDate: timebox.startDate,
        endDate: timebox.endDate,
        // The boundary is the END of the timebox's last LOCAL day: an item accepted at 22:00
        // on the final evening is During, one accepted after local midnight is After.
        endBoundary: endOfWorkspaceDay(timebox.endDate ?? today, settings.timeZone),
        iterationCount: timebox.iterationIds.length,
        items: timebox.iterationIds.flatMap((id) => byIteration.get(id) ?? []),
      }),
    );

    return {
      context: await this.context(actor, args, settings.timeZone, scope),
      window,
      bars,
      averages: computeAverages(bars),
      unclassifiedItems: bars.reduce((sum, b) => sum + b.unclassifiedItems, 0),
    };
  }

  // ── Team Capacity ─────────────────────────────────────────────────────────

  async getTeamCapacity(
    actor: JwtPayload,
    args: ScopeArgs & { iterationId: string },
  ): Promise<TeamCapacityReport> {
    const { workspaceId } = actor;
    const scope = await this.resolveScope(actor, args);
    const settings = await this.repo.getWorkspaceSettings(workspaceId);
    const selected = await this.requireIteration(actor, args, scope);

    const participating = await this.repo.findTimeboxSiblings(
      workspaceId,
      args.projectId,
      selected.timeboxGroupId,
      scope,
      selected.id,
    );
    const iterationIds = participating.map((i) => i.id);

    const [capacities, taskHours] = await Promise.all([
      this.repo.getCapacityRecords(workspaceId, args.projectId, iterationIds, scope),
      this.repo.getScopedTaskHours(workspaceId, args.projectId, iterationIds, scope),
    ]);

    const rollup = rollUpTeamCapacity({ capacities, tasks: taskHours });

    return {
      context: await this.context(actor, args, settings.timeZone, scope),
      timebox: this.toTimebox(selected, participating),
      totals: rollup.totals,
      teams: rollup.teams,
      ...describeEmptiness(rollup),
    };
  }

  // ── Release Tracking ──────────────────────────────────────────────────────

  async getReleaseTracking(
    actor: JwtPayload,
    args: ScopeArgs & {
      releaseId: string;
      unit?: ChartUnit;
      bucket?: ReleaseBucket;
      page?: number;
      pageSize?: number;
      /** Free-text search over the ACTIVE bucket's key and name (§259). */
      q?: string;
      /** `"<field>[:asc|:desc]"` over the whole bucket (RT-AC-05). */
      sort?: string;
    },
  ): Promise<ReleaseTrackingReport> {
    const { workspaceId } = actor;
    const scope = await this.resolveScope(actor, args);
    const unit: ChartUnit = args.unit ?? 'points';
    const bucket: ReleaseBucket = args.bucket ?? 'direct';
    const pageSize = args.pageSize ?? RELEASE_TRACKING_PAGE_SIZE;
    const settings = await this.repo.getWorkspaceSettings(workspaceId);

    const release = await this.repo.findRelease(workspaceId, args.releaseId);
    if (!release || release.projectId !== args.projectId) {
      throw new NotFoundException('RELEASE_NOT_FOUND', 'Release not found');
    }

    const map = await this.preliminaryEstimates.forProject(args.projectId);
    const [features, children] = await Promise.all([
      this.repo.getReleaseFeatures(
        workspaceId,
        args.projectId,
        (size) => map[size as keyof typeof map]?.points ?? 0,
        (size) => map[size as keyof typeof map]?.count ?? 0,
      ),
      this.repo.getReleaseChildren(workspaceId, args.projectId, release.id),
    ]);

    const childrenByFeature = new Map<string, ReleaseChild[]>();
    for (const child of children) {
      if (child.featureId === null) continue;
      const list = childrenByFeature.get(child.featureId);
      if (list) list.push(child);
      else childrenByFeature.set(child.featureId, [child]);
    }

    const buckets = bucketFeatures(features, children, release.id, scope);
    const unparented = unparentedItems(children, release.id, scope);
    const leaves = trackedLeaves(children, release.id, scope);

    const summary = {
      direct: buckets.direct.length,
      derived: buckets.derived.length,
      unparented: unparented.length,
    };

    /**
     * Search, sort and page the ACTIVE bucket, after classification.
     *
     * Classification needs the whole population by construction — a Derived Feature is one
     * that is NOT in the release but has a scoped child that is, so it cannot be found by a
     * `WHERE release_id = ...` — and `preliminaryTotal` sums Direct + Derived, so a paged
     * feature set would quietly shrink the Preliminary line and the burnup's reference. All
     * three therefore happen here, over rows already in hand, and every number above them is
     * final.
     *
     * Search and sort used to run in the BROWSER over the page that had arrived, so `ID ▼`
     * ordered 25 rank-first rows while the header's caret claimed the bucket was sorted, and the
     * search box had to disclose that it searched one page. §259 settles it — "Search applies
     * within the active bucket" — and RT-AC-05's two-directional sort is only meaningful over the
     * same population.
     *
     * `rank` is assigned BEFORE either, from the bucket's own rank order, so a row's Rank is a
     * property of the bucket (§247) and not of the current view: sorting by ID shows those ranks
     * out of order, and a search shows each match's real position instead of renumbering it 1.
     * `row` is a thunk so only the page slice's Status, mismatches and progress are computed.
     */
    const refine = {
      q: args.q,
      sort: parseSort(args.sort, RELEASE_TRACKING_SORT_FIELDS),
    };
    const entries: Array<BucketSortKeys & { row: () => ReleaseTrackingRow }> =
      bucket === 'direct'
        ? refineBucket(
            buckets.direct.map((f, i) => ({
              rank: i + 1,
              itemKey: f.itemKey,
              name: f.name,
              teamLabel: f.teamName ?? NO_TEAM_LABEL,
              row: () =>
                this.directRow(f, i + 1, childrenByFeature.get(f.id) ?? [], release.id, unit),
            })),
            refine,
          )
        : bucket === 'derived'
          ? refineBucket(
              buckets.derived.map((f, i) => {
                const cause = buckets.derivedCause.get(f.id) ?? [];
                return {
                  rank: i + 1,
                  itemKey: f.itemKey,
                  name: f.name,
                  // A Derived row's Team column is the scoped CAUSE children's teams (§5), not
                  // the Feature's own, so that is what a Team sort has to order it by.
                  teamLabel: derivedTeamLabel(cause),
                  row: () => this.derivedRow(f, i + 1, cause, unit),
                };
              }),
              refine,
            )
          : refineBucket(
              unparented.map((c, i) => ({
                rank: i + 1,
                itemKey: c.itemKey,
                name: c.title,
                teamLabel: c.teamName ?? NO_TEAM_LABEL,
                row: () => this.unparentedRow(c, i + 1, unit),
              })),
              refine,
            );

    // The page total is the MATCHED count, so paging walks the search results — while `summary`
    // above stays the three whole-bucket populations §5.1 keeps visible.
    const total = entries.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    // Clamp rather than 404 on an out-of-range page: the row count shifts under the reader as
    // work is reassigned, and a stale page number should land on the last page, not an error.
    const page = Math.min(Math.max(args.page ?? 1, 1), pageCount);
    const offset = (page - 1) * pageSize;

    const rows = entries.slice(offset, offset + pageSize).map((entry) => entry.row());

    return {
      context: await this.context(actor, args, settings.timeZone, scope),
      release: {
        id: release.id,
        name: release.name,
        startDate: release.startDate,
        releaseDate: release.releaseDate,
      },
      unit,
      bucket,
      // All three stay visible even when the active bucket is empty (§5.1), and all three are
      // whole-population counts regardless of which page of rows travelled.
      summary,
      rows,
      page: { page, pageSize, total, pageCount },
      // Preliminary sums the Direct and Derived Features; Planned/Accepted use the tracked
      // leaves. Three totals, one population each, exactly as RT §4 splits them.
      totals: releaseTotals(leaves, [...buckets.direct, ...buckets.derived], unit),
    };
  }

  async getReleaseBurnup(
    actor: JwtPayload,
    args: ScopeArgs & { releaseId: string; unit?: ChartUnit },
  ): Promise<ReleaseBurnupReport> {
    const { workspaceId } = actor;
    const scope = await this.resolveScope(actor, args);
    const unit: ChartUnit = args.unit ?? 'points';

    /**
     * Validate the SCOPE, not just the release.
     *
     * This route returns no `context`, so it never called `context()` — and with it skipped the
     * project and team existence checks the other four reports get for free. A soft-deleted project
     * still served a burnup, and an unknown `teamId` narrowed every query to nothing while the caller
     * got a 200. The release check below proves the release belongs to the project; it cannot prove
     * the project is still there.
     */
    await this.resolveScopeNames(actor, args);

    const release = await this.repo.findRelease(workspaceId, args.releaseId);
    if (!release || release.projectId !== args.projectId) {
      throw new NotFoundException('RELEASE_NOT_FOUND', 'Release not found');
    }

    // No window means no axis and no ideal trajectory. Reported as unavailable rather than
    // drawn from whichever snapshots happen to exist.
    if (!release.startDate || !release.releaseDate) {
      return { unit, points: [], historyState: 'no-window', idealTarget: null, iterations: [] };
    }

    const [snapshots, target, band] = await Promise.all([
      this.repo.getReleaseBurnupRows(workspaceId, release.id, scope, unit),
      /**
       * The Ideal target for THIS scope.
       *
       * It used to be two scope-blind columns on `releases`, so a team-scoped burnup drew that team's
       * Accepted line against the whole release's goal while the measured series beside it was
       * correctly narrowed — every team looked permanently behind. RT §7 recomputes the whole Burnup
       * from the selected Team's scope, Ideal included.
       */
      this.repo.findReleaseTeamTarget(workspaceId, release.id, scope),
      this.repo.findIterationsInWindow(
        workspaceId,
        args.projectId,
        scope,
        release.startDate,
        release.releaseDate,
      ),
    ]);

    const { points, historyState, idealTarget } = buildBurnup({
      axis: calendarDays(release.startDate, release.releaseDate),
      idealTarget: target === null ? null : unit === 'points' ? target.points : target.count,
      snapshots,
    });

    return {
      unit,
      points,
      historyState,
      idealTarget,
      iterations: band.map((i) => ({
        id: i.id,
        name: i.name,
        startDate: i.startDate,
        endDate: i.endDate,
      })),
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async requireIteration(
    actor: JwtPayload,
    args: ScopeArgs & { iterationId: string },
    scope: TeamScope,
  ): Promise<IterationRow> {
    const selected = await this.repo.findIteration(actor.workspaceId, args.iterationId);
    // The project check is not redundant with the guard: `report:view` is enforced against
    // the projectId in the query string, so an iteration id from another project would
    // otherwise be read under a project the caller legitimately holds.
    if (!selected || selected.projectId !== args.projectId) {
      throw new NotFoundException('ITERATION_NOT_FOUND', 'Iteration not found');
    }
    /**
     * A team-restricted reader may open their own Teams' timeboxes and the SHARED ones — the server
     * half of the SPA's `iterationsInScope`, and the same rule `timeboxInScope` applies to the
     * siblings query. Enforced on the SELECTED id too, because "direct URLs" is in the ruling: the
     * narrowed queries would otherwise serve another Team's sprint as an empty chart with that
     * sprint's name and dates in the header.
     *
     * `teamId === null` is deliberately NOT refused here. A team-less ITERATION is a window every
     * team works inside, not the Project Backlog — that is a property of a work item's own
     * `team_id`, and it is the per-item predicates that withhold it.
     */
    if (scope.kind === 'teams' && selected.teamId !== null) {
      await this.access.assertTeamInScope(
        actor.workspaceId,
        actor.sub,
        args.projectId,
        selected.teamId,
      );
    }
    return selected;
  }

  /** Direct rows: Status over EVERY child, plus the mismatch issues (RT-BR-05, §5). */
  private directRow(
    feature: ReleaseFeature & { state: string },
    /** 1-based position in the bucket's own rank order — never the position on this page. */
    rank: number,
    allChildren: ReleaseChild[],
    releaseId: string,
    unit: ChartUnit,
  ): ReleaseTrackingRow {
    return {
      rank,
      id: feature.id,
      itemKey: feature.itemKey,
      name: feature.name,
      teams: [{ id: feature.teamId, name: feature.teamName ?? NO_TEAM_LABEL }],
      issueType: 'feature',
      state: feature.state,
      childCount: allChildren.length,
      status: directStatus(allChildren, unit),
      mismatches: releaseMismatches(allChildren, releaseId),
      fullMismatch: isFullMismatch(allChildren, releaseId),
      plannedStartDate: feature.plannedStartDate,
      plannedEndDate: feature.plannedEndDate,
      progress: featureProgress(allChildren),
    };
  }

  /**
   * Derived rows: Status over the causing children only, no percentage, and a Team column
   * showing the scoped child Teams that caused inclusion rather than the Feature's own Team.
   */
  private derivedRow(
    feature: ReleaseFeature & { state: string },
    rank: number,
    cause: ReleaseChild[],
    unit: ChartUnit,
  ): ReleaseTrackingRow {
    const teams = new Map<string | null, string>();
    for (const child of cause) teams.set(child.teamId, child.teamName ?? NO_TEAM_LABEL);
    return {
      rank,
      id: feature.id,
      itemKey: feature.itemKey,
      name: feature.name,
      teams: [...teams].map(([id, name]) => ({ id, name })),
      issueType: 'feature',
      state: feature.state,
      childCount: cause.length,
      status: derivedStatus(cause, unit),
      // A Derived Feature is included BECAUSE of a child in this release; its children
      // elsewhere are the reason it is derived, not a contradiction to warn about.
      mismatches: [],
      fullMismatch: false,
      plannedStartDate: feature.plannedStartDate,
      plannedEndDate: feature.plannedEndDate,
      progress: null,
    };
  }

  private unparentedRow(child: ReleaseChild, rank: number, unit: ChartUnit): ReleaseTrackingRow {
    return {
      rank,
      id: child.id,
      itemKey: child.itemKey,
      name: child.title,
      teams: [{ id: child.teamId, name: child.teamName ?? NO_TEAM_LABEL }],
      issueType: child.type,
      state: child.scheduleState,
      childCount: 0,
      // An Unparented item IS the leaf, so its own acceptance is the whole status.
      status: directStatus([child], unit),
      mismatches: [],
      fullMismatch: false,
      plannedStartDate: null,
      plannedEndDate: null,
      progress: null,
    };
  }

  private toTimebox(selected: IterationRow, participating: IterationRow[]): ReportTimebox {
    const starts = participating.map((i) => i.startDate).filter((d): d is string => d !== null);
    const ends = participating.map((i) => i.endDate).filter((d): d is string => d !== null);
    return {
      iterationId: selected.id,
      timeboxGroupId: selected.timeboxGroupId,
      name: selected.name,
      // The union of the participating windows. Teams sharing a timebox normally carry
      // identical dates; taking the union means a Team that shifted one end by a day still
      // has its last day plotted rather than silently clipped.
      startDate: starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : selected.startDate,
      endDate: ends.length ? ends.reduce((a, b) => (a > b ? a : b)) : selected.endDate,
      iterationCount: participating.length,
    };
  }

  /**
   * Resolve the scope's names, refusing anything that does not exist.
   *
   * Split out of `context()` so the ONE report that returns no context can still validate. Four of
   * the five report routes built a context and got these checks for free; `getReleaseBurnup` does not
   * return one, so it skipped them entirely and served a burnup for a soft-DELETED project.
   */
  private async resolveScopeNames(
    actor: JwtPayload,
    args: ScopeArgs,
  ): Promise<{ projectName: string; teamName: string | null }> {
    const [projectName, teamName] = await Promise.all([
      this.repo.getProjectName(actor.workspaceId, args.projectId),
      args.teamId ? this.repo.getTeamName(actor.workspaceId, args.teamId) : Promise.resolve(null),
    ]);
    if (projectName === null) {
      throw new NotFoundException('PROJECT_NOT_FOUND', 'Project not found');
    }
    /**
     * An unknown team is a 404, NOT "All Teams".
     *
     * `teamName ?? ALL_TEAMS_LABEL` relabelled an id that resolved to nothing — a team from
     * another workspace, or a deleted one — while the QUERIES stayed narrowed to it and returned
     * nothing. The reader got a header claiming a project-wide aggregate over a scope that had
     * matched no rows, which is the one reading a report must never allow.
     */
    if (args.teamId && teamName === null) {
      throw new NotFoundException('TEAM_NOT_FOUND', 'Team not found');
    }
    return { projectName, teamName };
  }

  /**
   * The scope this reader gets for this request: their selection, bounded by their access.
   *
   * Three answers, and the middle one is the whole ruling:
   *
   *   • an UNRESTRICTED reader (Workspace Admin, per-project `admin`, or a principal with no level
   *     at all — `assertProjectPermission` is what refuses that one, not this) keeps exactly the old
   *     behaviour: `teamScope(args.teamId)`, All Teams by default, Project Backlog included. Their
   *     numbers must not move, and this is the line that guarantees it;
   *   • a team-restricted reader who NAMED a Team must hold it — `assertTeamInScope` is the single
   *     home of that refusal (`TEAM_NOT_IN_SCOPE` for another Team, `EDITOR_NO_TEAM_SCOPE` for a
   *     reader with none), so a report cannot disagree with a work-item write about who a Team
   *     belongs to. Note the scope becomes a one-element `teams`, NOT `{ kind: 'team' }`: the
   *     difference is the Project Backlog, which stays admin-only even inside a Team they hold;
   *   • a team-restricted reader who named NO Team gets their own Teams. This is where `All Teams`
   *     stops meaning "every Team" — see `MY_TEAMS_LABEL`. An empty roster yields an empty scope,
   *     which every query reads as "no rows" and never as "no filter".
   *
   * `args.teamId` is treated as absent when falsy, matching `teamScope('')`.
   */
  private async resolveScope(actor: JwtPayload, args: ScopeArgs): Promise<TeamScope> {
    const access = await this.access.resolveTeamScope(actor.workspaceId, actor.sub, args.projectId);
    if (access.unrestricted) return teamScope(args.teamId);
    if (args.teamId) {
      await this.access.assertTeamInScope(
        actor.workspaceId,
        actor.sub,
        args.projectId,
        args.teamId,
      );
      return restrictedTeamScope([args.teamId]);
    }
    return restrictedTeamScope(access.teamIds);
  }

  private async context(
    actor: JwtPayload,
    args: ScopeArgs,
    timeZone: string,
    scope: TeamScope,
  ): Promise<ReportContext> {
    const { projectName, teamName } = await this.resolveScopeNames(actor, args);
    return {
      projectId: args.projectId,
      projectName,
      teamId: args.teamId ?? null,
      // The centred context title is `{Project} - {Team|All Teams}` (IB §7), so the label for
      // "no Team selected" belongs to the contract rather than to the SPA — and for a reader with
      // no All Teams scope that default label is `My Teams`, because theirs counts neither the
      // other Teams nor the Project Backlog.
      teamName: args.teamId ? teamName : scope.kind === 'teams' ? MY_TEAMS_LABEL : ALL_TEAMS_LABEL,
      timeZone,
    };
  }
}

/**
 * The placeholder a team-less row prints, and SORTS BY.
 *
 * `''` and `'--'` were both in use: the row builders printed `'--'` while the sort keys built `''`,
 * so a Team sort ordered a team-less row by a string the reader is never shown — and `derivedTeamLabel`
 * joined the empty one into cells like ", Team Alpha". A team-agnostic row is now ordinary here (it
 * counts inside every scope, see `inScope`), so this is the common case, not a rare one.
 *
 * Matches the SPA's `EMPTY_VALUE`, whose own docblock is emphatic that `'--'` and not an em-dash is
 * what real Rally renders. Declared here rather than imported because `libs/shared-kernel` carries no
 * display constants and a report string is not a domain fact.
 */
const NO_TEAM_LABEL = '--';

/**
 * What a Derived row's Team column prints, as one sortable string.
 *
 * Its Team cell shows "the scoped child Team(s) that caused inclusion" (§5), which can be several,
 * so a Team sort has to order it by the same label the reader sees rather than by the Feature's own
 * team. De-duplicated in first-appearance order, exactly as `derivedRow` builds the chips.
 */
function derivedTeamLabel(cause: readonly ReleaseChild[]): string {
  const names = new Map<string | null, string>();
  for (const child of cause) names.set(child.teamId, child.teamName ?? NO_TEAM_LABEL);
  return [...names.values()].join(', ');
}

/** Every calendar date from start to end inclusive — the burnup axis. */
function calendarDays(start: string, end: string): string[] {
  const out: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor.getTime() <= last.getTime()) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}
