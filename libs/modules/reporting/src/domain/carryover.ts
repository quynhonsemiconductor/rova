import { roundForDisplay } from './report-scope';

/**
 * The Carryover read model (Phase 7 CO-08 … CO-10, plan Tasks 8 and 10).
 *
 * Pure: every rule here is a decision over event rows already in memory, so each formula is
 * unit-tested on its own (`carryover.spec.ts`). The repository reads ONLY `carryover` transitions —
 * Split Events and Manual Moves are never in the input (CO-BR-35), so nothing here has to exclude
 * them.
 *
 * Iterations are matched as a SET, because every report reads the selected Iteration's fused timebox
 * (`findTimeboxSiblings`): for All Teams that is every participating Team's Iteration.
 */

export type CarryoverDirection = 'in' | 'out';
export type CarryoverDirectionFilter = 'all' | CarryoverDirection;
export const CARRYOVER_DIRECTION_FILTERS = ['all', 'in', 'out'] as const;

/** One Task's snapshot at a Carryover, plus its current cumulative Actual. */
export interface StoredCarryoverTask {
  taskId: string;
  estimateHours: number | null;
  todoHours: number | null;
  actualHours: number | null;
  /** `tasks.actual_hours` today — the upper bound of the LAST hop (plan D10). */
  currentActualHours: number;
}

/** One `carryover` transition as the report reads it. */
export interface StoredCarryoverEvent {
  transitionId: string;
  /** ISO timestamp. */
  occurredAt: string;
  storyId: string;
  storyKey: string;
  storyTitle: string;
  storyStartDate: string | null;
  targetEndDate: string | null;
  sourceIterationId: string | null;
  sourceIterationName: string | null;
  targetIterationId: string | null;
  targetIterationName: string | null;
  tasks: StoredCarryoverTask[];
}

/** The compact badge on Burndown and Team Capacity (CO-BR-34/36/37). */
export interface CarryoverSummary {
  carryIn: number;
  carryOut: number;
  transferredTodoHours: number;
}

const sum = (values: readonly (number | null)[]): number =>
  roundForDisplay(values.reduce<number>((total, v) => total + (v ?? 0), 0));

function isIn(event: StoredCarryoverEvent, ids: ReadonlySet<string>): boolean {
  return event.targetIterationId !== null && ids.has(event.targetIterationId);
}

function isOut(event: StoredCarryoverEvent, ids: ReadonlySet<string>): boolean {
  return event.sourceIterationId !== null && ids.has(event.sourceIterationId);
}

/** Events that touch the set at either end. */
export function involving(
  events: readonly StoredCarryoverEvent[],
  iterationIds: readonly string[],
): StoredCarryoverEvent[] {
  const ids = new Set(iterationIds);
  return events.filter((event) => isIn(event, ids) || isOut(event, ids));
}

/**
 * CO-BR-36/37 — Carry In (events INTO the set), Carry Out (events OUT of it) and the To Do those
 * events transferred, Σ of the snapshot To Do of every involving event (each event once). `null` when
 * nothing touched the set, which hides the badge.
 */
export function summarise(
  events: readonly StoredCarryoverEvent[],
  iterationIds: readonly string[],
): CarryoverSummary | null {
  const ids = new Set(iterationIds);
  const touched = involving(events, iterationIds);
  if (touched.length === 0) return null;
  return {
    carryIn: touched.filter((event) => rowDirection(event, ids) === 'in').length,
    // An event with BOTH ends in the set is counted ONCE, as Carry In — the same label its row
    // carries — so the KPIs, the rows and the CSV can never disagree (PR #653 review, round 2).
    carryOut: touched.filter((event) => rowDirection(event, ids) === 'out').length,
    transferredTodoHours: sum(touched.flatMap((event) => event.tasks.map((t) => t.todoHours))),
  };
}

/**
 * CO-BR-40 / plan D10 — Actual After for one event: per Task, the Actual logged after this event
 * and before the Task's NEXT Carryover (or until now, when there is none), clamped at 0.
 *
 * `allEvents` is the project's whole Carryover history in scope, so the "next snapshot of the same
 * Task" is found even when that event left an Iteration outside the reported set. For many rows build
 * {@link nextSnapshotIndex} ONCE and pass it in — a per-row re-sort was O(n² log n) (PR #653 review).
 */
export function actualAfter(
  event: StoredCarryoverEvent,
  allEvents: readonly StoredCarryoverEvent[],
  index: NextSnapshotIndex = nextSnapshotIndex(allEvents),
): number {
  let total = 0;
  for (const task of event.tasks) {
    const base = task.actualHours ?? 0;
    const next = index.get(snapshotKey(event.transitionId, task.taskId));
    const upper = next !== undefined ? next : task.currentActualHours;
    total += Math.max(0, upper - base);
  }
  return roundForDisplay(total);
}

/** (transitionId, taskId) → the same Task's Actual at its NEXT Carryover, when there is one. */
export type NextSnapshotIndex = ReadonlyMap<string, number>;

const snapshotKey = (transitionId: string, taskId: string) => `${transitionId}:${taskId}`;

/**
 * One pass over the history, newest first: link every Task snapshot to the one after it.
 * O(n log n) for the sort and O(snapshots) after.
 */
export function nextSnapshotIndex(allEvents: readonly StoredCarryoverEvent[]): NextSnapshotIndex {
  const ordered = [...allEvents].sort(compareEvents);
  const laterActual = new Map<string, number>();
  const index = new Map<string, number>();
  for (let i = ordered.length - 1; i >= 0; i--) {
    const event = ordered[i];
    for (const task of event.tasks) {
      const later = laterActual.get(task.taskId);
      if (later !== undefined) index.set(snapshotKey(event.transitionId, task.taskId), later);
      laterActual.set(task.taskId, task.actualHours ?? 0);
    }
  }
  return index;
}

function compareEvents(a: StoredCarryoverEvent, b: StoredCarryoverEvent): number {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
  return a.transitionId < b.transitionId ? -1 : a.transitionId > b.transitionId ? 1 : 0;
}

/** One row of the Carryover report, in the SRS column order (CO-BR-40). */
export interface CarryoverRow {
  transitionId: string;
  direction: CarryoverDirection;
  storyId: string;
  storyKey: string;
  storyTitle: string;
  fromIterationId: string | null;
  fromIterationName: string | null;
  toIterationId: string | null;
  toIterationName: string | null;
  /** ISO timestamp; the SPA renders it in the workspace time zone. */
  movedAt: string;
  startDate: string | null;
  targetEndDate: string | null;
  estimateHours: number;
  todoHours: number;
  actualBefore: number;
  actualAfter: number;
}

/**
 * The rows, oldest first, filtered by Direction (CO-BR-41 — the filter narrows ROWS only, never a
 * KPI).
 *
 * An event with BOTH ends in the set (a move between two Iterations of one fused timebox) is labelled
 * `in` — the set received the Story — and the `out` filter EXCLUDES it, so a row's label and the tab
 * it appears under can never disagree (PR #653 review). The label is computed once and the filter
 * reads it.
 */
export function buildCarryoverRows(
  allEvents: readonly StoredCarryoverEvent[],
  iterationIds: readonly string[],
  direction: CarryoverDirectionFilter,
): CarryoverRow[] {
  const ids = new Set(iterationIds);
  const index = nextSnapshotIndex(allEvents);
  return involving(allEvents, iterationIds)
    .sort(compareEvents)
    .map((event) => ({ event, label: rowDirection(event, ids) }))
    .filter(({ label }) => direction === 'all' || label === direction)
    .map(({ event, label }) => ({
      transitionId: event.transitionId,
      direction: label,
      storyId: event.storyId,
      storyKey: event.storyKey,
      storyTitle: event.storyTitle,
      fromIterationId: event.sourceIterationId,
      fromIterationName: event.sourceIterationName,
      toIterationId: event.targetIterationId,
      toIterationName: event.targetIterationName,
      movedAt: event.occurredAt,
      startDate: event.storyStartDate,
      targetEndDate: event.targetEndDate,
      estimateHours: sum(event.tasks.map((t) => t.estimateHours)),
      todoHours: sum(event.tasks.map((t) => t.todoHours)),
      actualBefore: sum(event.tasks.map((t) => t.actualHours)),
      actualAfter: actualAfter(event, allEvents, index),
    }));
}

/** The one label a row carries: `in` when the set received the Story, else `out`. */
function rowDirection(event: StoredCarryoverEvent, ids: ReadonlySet<string>): CarryoverDirection {
  return isIn(event, ids) ? 'in' : 'out';
}

/**
 * CO-BR-38 / ruling R11 — unique affected Story ids over unique Stories in scope, as a percentage.
 *
 * Denominator = Stories scheduled in the set now (Split placeholders already excluded by the
 * repository) ∪ every Story an involving event touched — carried OUT (no longer scheduled there, but
 * was) AND carried IN (it was in scope on arrival, even if it later left by a non-Carryover path such
 * as a Manual Move, which R3 does not record as a Carryover event). The numerator is therefore a
 * subset of the denominator and the rate can never exceed 100 (PR #653 review, round 3). `0` when
 * the denominator is 0.
 */
export function carryoverRate(
  events: readonly StoredCarryoverEvent[],
  iterationIds: readonly string[],
  scheduledStoryIds: readonly string[],
): number {
  const affected = new Set(involving(events, iterationIds).map((event) => event.storyId));
  const denominator = new Set([...scheduledStoryIds, ...affected]);
  if (denominator.size === 0) return 0;
  return roundForDisplay((affected.size / denominator.size) * 100, 1);
}

/** One bar pair of the trend chart (CO-BR-39). */
export interface CarryoverTrendPoint {
  iterationId: string;
  name: string;
  startDate: string | null;
  carryIn: number;
  carryOut: number;
}

/** Carry In / Carry Out for every Iteration in scope, in the order given (start date). */
export function buildTrend(
  events: readonly StoredCarryoverEvent[],
  iterations: ReadonlyArray<{ id: string; name: string; startDate: string | null }>,
): CarryoverTrendPoint[] {
  return iterations.map((iteration) => ({
    iterationId: iteration.id,
    name: iteration.name,
    startDate: iteration.startDate,
    carryIn: events.filter((event) => event.targetIterationId === iteration.id).length,
    carryOut: events.filter((event) => event.sourceIterationId === iteration.id).length,
  }));
}
