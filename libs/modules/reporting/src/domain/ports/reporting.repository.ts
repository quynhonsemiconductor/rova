import type { StoredSnapshot, StoredSplitEvent } from '../burndown';
import type { ReleaseChild, ReleaseFeature, StoredBurnupRow } from '../release-tracking';
import type { TeamScope } from '../report-scope';
import type { CapacityRecord, ScopedTaskHours } from '../team-capacity';
import type { VelocityItem } from '../velocity';

export const REPORTING_REPOSITORY = Symbol('REPORTING_REPOSITORY');

/** `workspace_settings` rows every report's date handling depends on. */
export interface WorkspaceReportSettings {
  timeZone: string;
  /** ISO day numbers, 1 = Mon … 7 = Sun. */
  workingDays: number[];
}

export interface IterationRow {
  id: string;
  projectId: string;
  teamId: string | null;
  timeboxGroupId: string | null;
  name: string;
  startDate: string | null;
  endDate: string | null;
}

/** One shared timebox, with the per-Team iterations it fuses. */
export interface TimeboxGroup {
  timeboxGroupId: string | null;
  name: string;
  startDate: string | null;
  endDate: string | null;
  iterationIds: string[];
}

export interface ReleaseRow {
  id: string;
  workspaceId: string;
  projectId: string;
  name: string;
  startDate: string | null;
  releaseDate: string | null;
}

/** An iteration the daily job is currently snapshotting. */
export interface ActiveIterationRow extends IterationRow {
  workspaceId: string;
}

export interface ActiveReleaseRow {
  id: string;
  workspaceId: string;
  projectId: string;
  startDate: string;
  releaseDate: string;
}

export interface IterationSnapshotWrite {
  workspaceId: string;
  iterationId: string;
  /**
   * NULL is the ALL TEAMS row, MEASURED over the whole iteration scope rather than summed from
   * the team rows — a task two teams both touch must be counted once (migration 0093).
   */
  teamId: string | null;
  /** Workspace-local date. */
  snapshotDate: string;
  remainingTodo: number;
  acceptedPoints: number;
}

export interface ReleaseSnapshotWrite {
  workspaceId: string;
  releaseId: string;
  /** Null = the All Teams aggregate row. */
  teamId: string | null;
  snapshotDate: string;
  acceptedPoints: number;
  acceptedCount: number;
  plannedPoints: number;
  plannedCount: number;
  preliminaryPoints: number;
  preliminaryCount: number;
}

/**
 * The reads Phase 6 needs, plus the two snapshot writes the daily job makes. Deliberately
 * narrow: each method answers one report's question and returns rows the pure domain modules
 * already accept, so the service is assembly and the SQL has no arithmetic in it.
 */
export interface IReportingRepository {
  // ── shared ────────────────────────────────────────────────────────────────
  getWorkspaceSettings(workspaceId: string): Promise<WorkspaceReportSettings>;
  getProjectName(workspaceId: string, projectId: string): Promise<string | null>;
  getTeamName(workspaceId: string, teamId: string): Promise<string | null>;
  findIteration(workspaceId: string, iterationId: string): Promise<IterationRow | null>;
  /**
   * Every iteration sharing one timebox group inside a project, narrowed to the scope.
   * For a selected Team this is at most that Team's own iteration.
   */
  findTimeboxSiblings(
    workspaceId: string,
    projectId: string,
    timeboxGroupId: string | null,
    scope: TeamScope,
    fallbackIterationId: string,
  ): Promise<IterationRow[]>;

  // ── Iteration Burndown ────────────────────────────────────────────────────
  /**
   * Stored daily rows for one SCOPE — the team's own series, or the All Teams series.
   *
   * Never both: `team_id IS NULL` is measured over the whole iteration, so mixing it with a
   * team's rows would double every overlapping day.
   */
  getIterationSnapshots(
    workspaceId: string,
    iterationIds: string[],
    scope: TeamScope,
    /** The workspace's calendar, for deciding whether each capture closed its own local day. */
    timeZone: string,
  ): Promise<StoredSnapshot[]>;
  /**
   * Leaf items scheduled into these iterations, IN THE GIVEN SCOPE.
   *
   * The scope argument is not optional: this count decides whether the reader is told "no scheduled
   * work", and counting project-wide told a Team with nothing in a shared sprint that the snapshot
   * history was missing instead.
   */
  countScheduledWork(
    workspaceId: string,
    iterationIds: string[],
    scope: TeamScope,
  ): Promise<number>;
  /**
   * Split Events that left these iterations — the `SPLIT OUT` annotations (SU-08 8.2, SRS §10.2).
   *
   * **These two live here rather than on `IStorySplitRepository`, and that is a deliberate departure
   * from plan §6 6.2's list.** `@modules/reporting` does not import `@modules/work-items` (the
   * dependency runs the other way — reporting READS work items), and one chart annotation is not a
   * reason to invert that: it would pull the whole `WorkItemsModule` graph into `ReportingModule`.
   * `work.story_splits` is in the same `db/schema/work.ts` this repository already reads
   * `work_items`, `tasks` and `iterations` from, so nothing is duplicated — the SQL simply lives with
   * the report that asks the question, which is what plan §1's own file map says
   * (`reporting.drizzle-repository.ts # + split lookups`).
   *
   * `scope` narrows by the SPLIT's team falling back to the matching iteration's — the same two-tier
   * rule `getVelocityItems` and `measureIterationDay` use, so a marker cannot appear on a chart whose
   * series excludes the work it describes.
   */
  findSplitsBySourceIteration(
    workspaceId: string,
    iterationIds: string[],
    scope: TeamScope,
  ): Promise<StoredSplitEvent[]>;
  /** Split Events that arrived in these iterations — the `CARRY IN` annotations (SRS §10.3). */
  findSplitsByTargetIteration(
    workspaceId: string,
    iterationIds: string[],
    scope: TeamScope,
  ): Promise<StoredSplitEvent[]>;

  // ── Velocity ──────────────────────────────────────────────────────────────
  /**
   * Timeboxes eligible for Velocity: local end date already past, and at least one
   * Story/Defect currently assigned. Ordered by end date ascending.
   */
  findEligibleTimeboxes(
    workspaceId: string,
    projectId: string,
    scope: TeamScope,
    todayLocalDate: string,
  ): Promise<TimeboxGroup[]>;
  /**
   * Currently-assigned Story/Defect rows for a set of iterations, keyed by iteration.
   *
   * `scope` narrows by the ITEM's own team (falling back to its iteration's), not by the
   * timebox — a team-scoped report may legitimately include a SHARED, team-less iteration, and
   * an item's team and its iteration's team are not kept in step by anything.
   *
   * `splitCarryover` rides along as `split_id is not null` (SU-09 9.2). Rows are NOT filtered by it:
   * a Split placeholder gets its own excluded segment, so the classifier needs to see the row.
   */
  getVelocityItems(
    workspaceId: string,
    iterationIds: string[],
    scope: TeamScope,
  ): Promise<Array<VelocityItem & { iterationId: string }>>;

  // ── Team Capacity ─────────────────────────────────────────────────────────
  getCapacityRecords(
    workspaceId: string,
    projectId: string,
    iterationIds: string[],
    scope: TeamScope,
  ): Promise<CapacityRecord[]>;
  /**
   * Tasks in scope for the requested iterations, with their hours.
   *
   * `actualHours` comes back ALREADY ATTRIBUTED to those iterations (Phase 7 SU-10): a Task carried
   * forward by a Split contributes only the hours logged while these iterations owned it. The
   * arithmetic is `attributeActualHours`; the window that picks its two bounds needs the iteration
   * ids, which is why it cannot live in `rollUpTeamCapacity`.
   *
   * `getTaskTotals` on the work-item side must NOT do this — Task Detail shows the full accumulated
   * Actual (AC6), and the two answering differently is the point rather than an inconsistency.
   */
  getScopedTaskHours(
    workspaceId: string,
    projectId: string,
    iterationIds: string[],
    scope: TeamScope,
  ): Promise<ScopedTaskHours[]>;

  // ── Release Tracking ──────────────────────────────────────────────────────
  findRelease(workspaceId: string, releaseId: string): Promise<ReleaseRow | null>;
  /**
   * Every non-archived Feature in the project, with its estimate tiers resolved.
   *
   * `state` rides along for the row's State column. It is not part of any classification
   * rule — RT §3 is explicit that membership is read from `releaseId`, never from progress.
   */
  getReleaseFeatures(
    workspaceId: string,
    projectId: string,
    preliminaryPoints: (size: string) => number,
    preliminaryCount: (size: string) => number,
  ): Promise<Array<ReleaseFeature & { state: string }>>;
  /**
   * Story/Defect rows relevant to one release: assigned to it, OR a child of any Feature in
   * the project (a Direct Feature's Status counts children in other releases too).
   */
  getReleaseChildren(
    workspaceId: string,
    projectId: string,
    releaseId: string,
  ): Promise<ReleaseChild[]>;
  getReleaseBurnupRows(
    workspaceId: string,
    releaseId: string,
    scope: TeamScope,
    unit: 'points' | 'count',
  ): Promise<StoredBurnupRow[]>;
  /** Iterations overlapping the release window, for the chart's secondary band. */
  findIterationsInWindow(
    workspaceId: string,
    projectId: string,
    scope: TeamScope,
    startDate: string,
    endDate: string,
  ): Promise<IterationRow[]>;

  // ── the daily snapshot job ────────────────────────────────────────────────
  //
  // Writes, and the only writes in this module. They exist here rather than in a second
  // repository because they measure the same populations the reads serve, and two classes
  // would let the stored history and the live query drift apart.

  /** Every committed iteration across every workspace. Cron work has no actor. */
  findActiveIterations(): Promise<ActiveIterationRow[]>;
  /** Releases whose window is open, across every workspace. */
  findActiveReleases(): Promise<ActiveReleaseRow[]>;

  /**
   * Workspaces holding at least one snapshot that is not yet `finalized`.
   *
   * The finalization pass used to run only over workspaces with an ACTIVE iteration or release,
   * because that was the set the snapshot loop had already computed timezones for. So the final day of
   * a workspace's last timebox stayed `finalized = false` forever: nothing was active any more, so the
   * workspace never appeared in the map again. This asks the question the pass actually needs.
   */
  findWorkspacesWithOpenSnapshots(): Promise<string[]>;

  /**
   * SUM(task.estimate) over an iteration's scope, GROUPED BY the resolved team, for the one-time
   * Ideal baseline capture (IB-BR-03).
   *
   * Grouped because IB §4 makes the baseline per team; the resolution is the same
   * `coalesce(task, parent, iteration)` the hours are measured with, so the baseline and the bars it is
   * compared against cannot be scoped differently. `teamId: null` is work with no resolvable team.
   */
  sumTaskEstimateByTeam(
    workspaceId: string,
    iterationId: string,
  ): Promise<Array<{ teamId: string | null; total: number }>>;
  /** Stores each scope's baseline once. A second call must not overwrite an existing capture. */
  captureTeamBaselines(
    workspaceId: string,
    iterationId: string,
    rows: Array<{ teamId: string | null; total: number }>,
    at: Date,
  ): Promise<void>;
  /**
   * The baseline for a scope: that team's row, or the SUM of every row for All Teams (IB §4).
   *
   * `null` means no baseline was recorded — distinct from a recorded zero, because only the first may
   * hide the Ideal line.
   */
  sumTeamBaselines(
    workspaceId: string,
    iterationIds: string[],
    scope: TeamScope,
  ): Promise<number | null>;

  /**
   * Stores a release's Ideal target for ONE scope, once, from that scope's planned totals on its
   * FIRST snapshot day.
   *
   * Per team, not per release: RT §7's acceptance example 7 recomputes the whole Burnup from the
   * selected Team's scope, and the Ideal sits inside that definition. A single release-level target
   * made every team's Accepted line race the WHOLE release's goal. `teamId: null` is the MEASURED All
   * Teams row, as in `release_daily_snapshots` and unlike `iteration_team_baselines`: RT §4.1 measures
   * All Teams because a Feature spanning two teams sits in both teams' derived buckets, so a sum would
   * count it twice.
   *
   * Capture-once per scope, for RT-BR-09: the Ideal must not be reconstructed from today's mutable
   * Planned value, or every past day's trajectory silently redraws whenever scope changes.
   *
   * Points and count move together: `Chart Unit` is a display switch over one population, so a
   * release with a target in one unit and not the other would draw an Ideal on one toggle
   * setting and not the other.
   */
  captureReleaseTeamTarget(input: {
    workspaceId: string;
    releaseId: string;
    teamId: string | null;
    plannedPoints: number;
    plannedCount: number;
    at: Date;
  }): Promise<void>;

  /**
   * The Ideal target for a scope: that scope's single row, All Teams included — never a sum.
   *
   * `null` means no target was ever captured — distinct from a captured zero, because only the first
   * may hide the Ideal line.
   */
  findReleaseTeamTarget(
    workspaceId: string,
    releaseId: string,
    scope: TeamScope,
  ): Promise<{ points: number; count: number } | null>;

  /**
   * Today's measured values for one iteration: SUM(task.todo) in hours, and the cumulative
   * accepted points as of the end of the workspace-local day.
   */
  /**
   * Today's measured values for one iteration and ONE scope.
   *
   * `teamId === null` measures the whole iteration (the All Teams row); a team id narrows to that
   * team's work by `coalesce(task.team_id, parent.team_id, iteration.team_id)`.
   */
  measureIterationDay(
    workspaceId: string,
    iterationId: string,
    endOfDay: Date,
    teamId?: string | null,
  ): Promise<{ remainingTodo: number; acceptedPoints: number }>;

  /** Teams with work in this iteration — who gets a per-team snapshot row. */
  teamsInIterationScope(workspaceId: string, iterationId: string): Promise<string[]>;

  upsertIterationSnapshot(row: IterationSnapshotWrite): Promise<void>;
  upsertReleaseSnapshot(row: ReleaseSnapshotWrite): Promise<void>;

  /**
   * Freeze every snapshot for a closed local day.
   *
   * The job only ever WRITES today's date, so a past date is already immutable in practice;
   * this flag records that fact so a reader (or an operator running a correction) can tell a
   * finished day from one still being written.
   */
  finalizeSnapshotsBefore(workspaceId: string, localDate: string): Promise<void>;
}
