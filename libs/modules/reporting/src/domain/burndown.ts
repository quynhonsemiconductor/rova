import { roundForDisplay, workingDaysBetween } from './report-scope';

/**
 * Iteration Burndown arithmetic (IB-BR-01…03 and §6).
 *
 * The two measured series are NOT computed here — they are read from
 * `iteration_daily_snapshots`, because Burndown is frozen history and cannot be
 * reconstructed from today's tasks. This module owns the parts that ARE derivable: the
 * Ideal line, the working-day axis, and the status indicator.
 *
 * WHY THE IDEAL LINE IS NOT THE MOCKUP'S
 *
 * The approved mockup interpolates over CALENDAR days
 * (`totalEstimate * (1 - elapsedDays / daysBetween(start, end))`), which is why its line
 * still sits near 3.5 hours on the last plotted day and never reaches zero. IB-BR-03
 * indexes by WORKING day and requires zero on the last one. The SRS is the contract; the
 * mockup is a display fixture (its own §9 says so).
 */

/** One plotted day. `null` series values mean "no snapshot for this date". */
export interface BurndownPoint {
  /** Workspace-local date, `YYYY-MM-DD`. */
  date: string;
  /** SUM(task.todo) at end of day, HOURS, left axis. `null` = no snapshot. */
  remainingToDo: number | null;
  /** Cumulative accepted points as of end of day, right axis. `null` = no snapshot. */
  acceptedPoints: number | null;
  /**
   * The frozen reference line, HOURS, left axis. `null` when no baseline was ever captured —
   * a zero line would be plotted and read as "the plan was to do nothing".
   */
  ideal: number | null;
  /**
   * True when this day's value was captured at the END of that local day.
   *
   * Null when nothing was measured — there is no capture to judge. False is the interesting case: a
   * real number, frozen, that is not the closing figure the chart implies.
   */
  endOfDay: boolean | null;
}

/**
 * What the SNAPSHOT history looks like — the SRS demands these be distinguishable.
 *
 * Deliberately says nothing about the Ideal baseline. IB §3 scopes the baseline to the Ideal
 * LINE, and §5 makes only missing snapshots "unavailable", so folding the two into one enum
 * made a missing baseline discard measured Task-To-Do and Accepted-Points bars that were
 * really recorded. `hasBaseline` reports that separately.
 */
export type BurndownHistoryState =
  /** Every working day in the window has a snapshot. */
  | 'complete'
  /** Some days have snapshots and some do not; the gaps render as gaps. */
  | 'partial'
  /** The iteration has no snapshots at all — the job has not run for it yet. */
  | 'missing'
  /**
   * The iteration has no start or end date, so there is no window to plot.
   *
   * A fourth state beyond the three IB §7 lists, because it is a fourth real situation and
   * the alternative was worse: the service used to pass `startDate ?? ''` into
   * `workingDaysBetween`, where `'' < ''` slipped past the inverted-range guard and
   * `addDays('')` threw `RangeError: Invalid time value` — a 500 on 99 of 206 local
   * iterations. "Add the dates first" and "wait for the job" are different actions.
   */
  | 'no-window';

export type BurndownStatus = 'on-track' | 'behind-plan' | 'unknown';

/**
 * `ideal(i) = totalTaskEstimateAtStart * (1 - i / (N - 1))` over working days, clamped to
 * `[0, totalTaskEstimateAtStart]`.
 *
 * Single-working-day iterations: `N - 1` is zero, so the formula is undefined. IB-BR-03
 * says to render the baseline at the start of that day and zero at the iteration-end
 * boundary, which as a one-point series is the baseline itself.
 */
export function idealLine(totalTaskEstimateAtStart: number, workingDayCount: number): number[] {
  if (workingDayCount <= 0) return [];
  const baseline = Math.max(0, totalTaskEstimateAtStart);
  if (workingDayCount === 1) return [baseline];
  const last = workingDayCount - 1;
  return Array.from({ length: workingDayCount }, (_, i) =>
    roundForDisplay(Math.min(baseline, Math.max(0, baseline * (1 - i / last)))),
  );
}

/** One stored snapshot row, already narrowed to what the chart needs. */
export interface StoredSnapshot {
  date: string;
  remainingToDo: number;
  acceptedPoints: number;
  /**
   * When the row was written, and whether that was the day's LAST write.
   *
   * `endOfDay: false` means the job stopped before local midnight, so this is a partway-through
   * reading frozen as the closing figure — IB-BR-01 asks for an end-of-day snapshot, and a day the job
   * died in cannot supply one. Reported rather than hidden or interpolated: the number is real, it just
   * does not mean what the axis implies.
   */
  capturedAt: Date | null;
  endOfDay: boolean;
}

export interface BurndownSeries {
  points: BurndownPoint[];
  historyState: BurndownHistoryState;
  status: BurndownStatus;
  /** The frozen baseline, echoed so the UI can label the axis honestly. */
  totalTaskEstimateAtStart: number | null;
  /** The latest date that actually has a snapshot, or null when none do. */
  latestSnapshotDate: string | null;
  /**
   * Plotted days whose value was NOT captured at the end of that day.
   *
   * A list rather than a count, so the client can name them — "2026-06-18 was captured at 10:04" is
   * actionable where "1 partial day" is not. Empty is the normal state.
   */
  partialCaptureDates: string[];
}

/**
 * Assemble the chart series from the working-day axis, the frozen baseline and whatever
 * snapshots exist.
 *
 * Missing days are emitted with `null` series values rather than skipped or zero-filled.
 * A zero would read as "no work remained", which is measured performance; a gap reads as
 * what it is. IB §5: "Missing historical snapshots are reported as unavailable.
 * Production must not interpolate or fabricate them."
 */
export function buildBurndownSeries(input: {
  startDate: string;
  endDate: string;
  workingDays: readonly number[];
  totalTaskEstimateAtStart: number | null;
  snapshots: readonly StoredSnapshot[];
}): BurndownSeries {
  const axis = workingDaysBetween(input.startDate, input.endDate, input.workingDays);
  const byDate = new Map(input.snapshots.map((s) => [s.date, s]));
  const baseline = input.totalTaskEstimateAtStart;
  const ideal = baseline === null ? null : idealLine(baseline, axis.length);

  const points: BurndownPoint[] = axis.map((date, i) => {
    const snap = byDate.get(date);
    return {
      date,
      remainingToDo: snap ? roundForDisplay(snap.remainingToDo) : null,
      acceptedPoints: snap ? roundForDisplay(snap.acceptedPoints) : null,
      ideal: ideal === null ? null : (ideal[i] ?? null),
      endOfDay: snap ? snap.endOfDay : null,
    };
  });

  // Only snapshots ON the plotted axis count towards completeness: a weekend row stored
  // for audit must not make a gap on Monday look filled.
  //
  // The baseline is NOT consulted here. It decides whether an Ideal line can be drawn, which
  // is a different question from whether the days were measured — and answering both with one
  // enum is what made a baseline-less iteration report as having no history at all.
  const onAxis = points.filter((p) => p.remainingToDo !== null);
  const historyState: BurndownHistoryState =
    axis.length === 0
      ? 'no-window'
      : onAxis.length === 0
        ? 'missing'
        : onAxis.length === axis.length
          ? 'complete'
          : 'partial';

  const latest = onAxis.at(-1) ?? null;

  return {
    points,
    // Only PLOTTED days: a weekend row captured mid-morning is stored for audit and never charted, so
    // flagging it would send a reader looking for something the axis does not show.
    partialCaptureDates: points.filter((p) => p.endOfDay === false).map((p) => p.date),
    historyState,
    // "if remainingToDo(d) > ideal(d): Behind plan else: On track" for the LATEST
    // available snapshot date — equality is On track (IB §8 example 5). Unknown when
    // there is nothing measured or nothing to measure against.
    status:
      latest === null || baseline === null
        ? 'unknown'
        : (latest.remainingToDo ?? 0) > (latest.ideal ?? 0)
          ? 'behind-plan'
          : 'on-track',
    totalTaskEstimateAtStart: baseline,
    latestSnapshotDate: latest?.date ?? null,
  };
}

// ── Split markers (Phase 7 SU-08, SRS §10.2 / §10.3) ─────────────────────────

/**
 * Which side of a Split a marker describes.
 *
 * `split-out` sits on the SOURCE Iteration's chart and names the `[Unfinished]` placeholder;
 * `carry-in` sits on the TARGET's and names the `[Continued]` Story. Two kinds rather than two
 * unrelated shapes, so one component renders both and one hidden table row format describes both.
 *
 * Declared as an `as const` ARRAY with the type derived from it, so the zod schema in
 * `reporting-response.dto.ts` hands `z.enum` this same array instead of re-typing the members — the
 * `SPLIT_SIDES` convention SU-01's review set, for the same reason: a third member would otherwise be
 * two edits with nothing failing if only one were made.
 */
export const SPLIT_MARKER_KINDS = ['split-out', 'carry-in'] as const;
export type SplitMarkerKind = (typeof SPLIT_MARKER_KINDS)[number];

/**
 * One stored `work.story_splits` row, narrowed to what a burndown annotation needs.
 *
 * The two marker DATES are read, never recomputed: they were clamped into their own iteration's
 * window at write time, using the workspace time zone, precisely so the read path does not have to
 * re-resolve a calendar per row (plan §2.1). A Split confirmed after the source sprint closed has no
 * x-position on the source chart otherwise.
 */
export interface StoredSplitEvent {
  splitId: string;
  sourceIterationId: string;
  targetIterationId: string;
  /** `YYYY-MM-DD`, already clamped into the source window. */
  sourceMarkerDate: string;
  /** `YYYY-MM-DD`, already clamped into the target window. */
  targetMarkerDate: string;
  unfinishedStoryId: string;
  unfinishedStoryKey: string;
  unfinishedPlanEstimate: number | null;
  continuedStoryId: string;
  continuedStoryKey: string;
  continuedPlanEstimate: number | null;
  /** Σ To Do of the Tasks that went to `[Continued]` — what the source lost and the target gained. */
  movedTodoHours: number;
  /** Σ Actual across ALL distributed Tasks, as at the Split. */
  actualHoursAtSplit: number;
}

/**
 * One annotation on a burndown chart — SRS §10.2's `SPLIT OUT` and §10.3's `CARRY IN`.
 *
 * ONE shape for both, with `kind` as the discriminant, and the field NAMES are deliberately neutral
 * (`todoHours`, `actualHours`) while their MEANING comes from `kind`:
 *   • `split-out` — `todoHours` is the To Do that LEFT this iteration, `actualHours` is the Actual it
 *     RETAINS (SRS §10.5: the source keeps every hour captured before the Split, including the
 *     pre-Split hours of Tasks that moved).
 *   • `carry-in` — `todoHours` is the To Do that ARRIVED, and `actualHours` is `0`, because §10.3
 *     makes the target's carried-in Actual start at zero and grow only from post-Split work.
 *
 * Named `retainedActual`/`openingActual` in the plan's 8.2 sketch; one field pair with a documented
 * discriminant is preferred over four fields of which two are always absent, because an absent field
 * is a shape the SPA has to branch on twice — once for the kind and once for the null.
 */
export interface SplitMarker {
  splitId: string;
  kind: SplitMarkerKind;
  /** The plotted x-position, `YYYY-MM-DD`. */
  date: string;
  /** The Story this marker is about — the placeholder for `split-out`, the original for `carry-in`. */
  storyId: string;
  storyKey: string;
  /** That Story's Plan Estimate as recorded at the Split. `null` = unpointed, never `0`. */
  points: number | null;
  todoHours: number;
  actualHours: number;
}

/**
 * The `SPLIT OUT` annotations for a set of source Iterations (SRS §10.2).
 *
 * Pure and total: every event in becomes exactly one marker out, in the order given, because the
 * repository has already narrowed to the iterations and the team scope the chart is drawn in. Sorting
 * is the caller's — the burndown's own axis is the order that matters, and re-sorting here would make
 * a second, silent decision about it.
 */
export function splitOutMarkers(events: readonly StoredSplitEvent[]): SplitMarker[] {
  return events.map((event) => ({
    splitId: event.splitId,
    kind: 'split-out',
    date: event.sourceMarkerDate,
    storyId: event.unfinishedStoryId,
    storyKey: event.unfinishedStoryKey,
    points: event.unfinishedPlanEstimate,
    todoHours: event.movedTodoHours,
    // The source keeps what it had accrued — SRS §10.5, and the number SU-10's arithmetic reads.
    actualHours: event.actualHoursAtSplit,
  }));
}

/**
 * The `CARRY IN` annotations for a set of target Iterations (SRS §10.3).
 *
 * `actualHours` is the LITERAL `0` the SRS names, not a value read from the event: the moved Tasks
 * bring their To Do forward and their Actual does not follow, so anything else here would be the
 * double-count the whole Split Event exists to prevent.
 */
export function carryInMarkers(events: readonly StoredSplitEvent[]): SplitMarker[] {
  return events.map((event) => ({
    splitId: event.splitId,
    kind: 'carry-in',
    date: event.targetMarkerDate,
    storyId: event.continuedStoryId,
    storyKey: event.continuedStoryKey,
    points: event.continuedPlanEstimate,
    todoHours: event.movedTodoHours,
    actualHours: 0,
  }));
}

/**
 * Fuse the per-Team snapshot rows of one shared timebox into one series per date.
 *
 * Summing is correct for both measures here and needs no de-duplication: a task's To Do
 * hours belong to exactly one Team's iteration, and a Story's points are counted under
 * the one iteration it is assigned to. The de-duplication the SRS demands applies where
 * the same item could be reached through two Teams, which is the Release Tracking case,
 * not this one.
 *
 * A date is emitted only if at least one Team snapshotted it, so a Team that missed a day
 * lowers nothing — the alternative (treating its absence as 0 hours remaining) would
 * invent progress.
 */
export function combineTeamSnapshots(rows: readonly StoredSnapshot[]): StoredSnapshot[] {
  const byDate = new Map<string, StoredSnapshot>();
  for (const row of rows) {
    const existing = byDate.get(row.date);
    byDate.set(
      row.date,
      existing
        ? {
            date: row.date,
            remainingToDo: existing.remainingToDo + row.remainingToDo,
            acceptedPoints: existing.acceptedPoints + row.acceptedPoints,
            /**
             * The fused day is end-of-day only if EVERY contributing row was.
             *
             * One team's job dying early makes the summed total a partial reading of that day, even
             * though the other teams closed theirs properly — so the weakest capture decides, and the
             * timestamp reported is the earliest, which is the one that explains why.
             */
            endOfDay: existing.endOfDay && row.endOfDay,
            capturedAt:
              existing.capturedAt !== null &&
              row.capturedAt !== null &&
              row.capturedAt > existing.capturedAt
                ? existing.capturedAt
                : (row.capturedAt ?? existing.capturedAt),
          }
        : { ...row },
    );
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
