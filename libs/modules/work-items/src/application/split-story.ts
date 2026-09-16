/**
 * Split a User Story — the pure half. No DB, no DI, no Nest: every function here is a decision over
 * rows already in memory, so each business rule can be unit-tested on its own (`split-story.spec.ts`
 * asserts ONE predicate per test, because fusing them is how a wrong target rule ships green —
 * `docs/PLAN-phase7-split-unfinished.md` §7).
 *
 * Mirrors `domain/team-read-scope.ts`: a decision table lives in one file that the service reads,
 * rather than as conditions scattered through an orchestration method.
 *
 * The rules implemented here, with their BA ids (`FEATURE.md` §9) and the rulings that bind them:
 *
 *   BR-01/02/03  {@link splitIneligibleReason} — only a Story, not already finished, and scheduled.
 *   BR-05        {@link filterSplitTargets}    — a later, non-overlapping, project/team-compatible,
 *                                                not-yet-accepted Iteration. §8 Q2 + Q3.
 *   BR-06        {@link earliestTarget}        — the earliest valid target is the default.
 *   BR-14/15     {@link defaultTaskSide}       — Completed Tasks stay behind; everything else moves.
 *   Q10          {@link stripSplitPrefix}      — a re-split must not stack `[Continued] [Continued]`.
 *
 * **Dates are compared as ISO `YYYY-MM-DD` strings, never as `Date` objects.** `work.iterations`
 * `start_date`/`end_date` are `date` columns and Drizzle hands them back as strings; an ISO date
 * string sorts and compares lexicographically exactly as the calendar does, so parsing them would
 * add a timezone to a comparison that has none. The Capacity module's `dateOnly` normalisation
 * exists because the OTHER side of its comparison was a timestamp; here neither side is.
 */
import type { IterationState } from '../../../../../db/schema/enums';
import { isCompletedScheduleState } from '../../../../../db/schema/enums';
import { iterationAssignmentRefusal } from '../domain/iteration-assignable';
import type { WorkItem } from '../domain/work-item.types';

/**
 * Which side of the Split an item lands on.
 *
 * `unfinished` is the historical placeholder that STAYS in the source Iteration; `continued` is the
 * original Story, moved forward to the target. Named for the two Stories rather than for screen
 * position ("left"/"right"), which is what the mockup calls them and what a future layout change
 * would falsify.
 */
export type SplitSide = 'unfinished' | 'continued';

/**
 * Why Split is unavailable. Returned by the preview for TELEMETRY AND TESTS ONLY — SRS §11 and every
 * AC require the control to be disabled with no explanatory message, so the UI reads `eligible`
 * alone and must never render this.
 *
 * Five members, decided in three different places, which is why no single function returns all of
 * them: `not_a_story`/`finished_state`/`unscheduled` come from the row ({@link splitIneligibleReason}),
 * `no_target` from the filtered candidate set, and `not_editable` from the permission check.
 */
export type SplitIneligibleReason =
  'not_a_story' | 'finished_state' | 'unscheduled' | 'no_target' | 'not_editable';

/** The subset of {@link SplitIneligibleReason} decidable from the Story row alone. */
export type SplitRowIneligibleReason = Extract<
  SplitIneligibleReason,
  'not_a_story' | 'finished_state' | 'unscheduled'
>;

/**
 * BR-01/02/03 — is this row a splittable Story? `null` means "nothing about the row itself refuses".
 *
 * Order matters and is the BA's: type first (a Defect is refused for BEING a Defect, not for its
 * state), then state, then schedule. A caller reporting only the first reason therefore reports the
 * most fundamental one.
 *
 * `isCompletedScheduleState` is reused rather than the three states re-listed: it already means
 * "at or past completed" (`completed｜accepted｜release`) and is the same helper the release,
 * milestone and portfolio roll-ups read, so a future state added to that end of the lifecycle
 * cannot become silently splittable here.
 */
export function splitIneligibleReason(
  item: Pick<WorkItem, 'type' | 'scheduleState' | 'iterationId'>,
): SplitRowIneligibleReason | null {
  if (item.type !== 'story') return 'not_a_story';
  if (isCompletedScheduleState(item.scheduleState)) return 'finished_state';
  if (item.iterationId === null) return 'unscheduled';
  return null;
}

/** The source Iteration, as {@link filterSplitTargets} needs to see it. */
export interface SplitSourceIteration {
  id: string;
  /** `null` for a dateless sprint — see {@link isLaterThanSource}. */
  endDate: string | null;
}

/**
 * One candidate Target Iteration.
 *
 * Deliberately not the Iteration RECORD: the target selector needs an identity, a window and a
 * state, and shipping `goal`/`theme`/`notes`/`plannedVelocity` would put the timebox record — which
 * `timebox:view` guards — into a feed every Story editor reads.
 */
export interface SplitTargetCandidate {
  id: string;
  name: string;
  iterationKey: string | null;
  state: IterationState;
  startDate: string | null;
  endDate: string | null;
  projectId: string;
  teamId: string | null;
}

/**
 * §8 Q3 — "later than the Source Iteration" is `target.startDate > source.endDate`: STRICTLY
 * non-overlapping, the mockup's rule, ruled binding. `> source.startDate` would admit a sprint that
 * overlaps the one the work is being moved out of, and "move the unfinished work forward" means a
 * later sprint rather than a concurrent one.
 *
 * A NULL on either side is refused rather than guessed. A dateless iteration belongs to no timebox
 * at all — `iterations.timeboxGroupId`'s own comment says it is excluded from All Teams aggregation
 * for exactly this reason — so it cannot be shown to be later than anything, and a source with no
 * end date has no "after" to be later than. Refusing yields `no_target`, which disables the control;
 * admitting would offer a target whose burndown and marker clamp have no x-axis to sit on.
 */
export function isLaterThanSource(
  source: Pick<SplitSourceIteration, 'endDate'>,
  candidate: Pick<SplitTargetCandidate, 'startDate'>,
): boolean {
  if (source.endDate === null || candidate.startDate === null) return false;
  return candidate.startDate > source.endDate;
}

/**
 * BR-05 — the valid Target Iterations for one Story, EARLIEST FIRST.
 *
 * Four independent predicates, and the unit spec asserts each on its own:
 *   1. not the source itself (moving a Story to the sprint it is already in is not a Split);
 *   2. `state !== 'accepted'` — an accepted Iteration is closed history, and landing work in it
 *      would change a delivered number after the fact;
 *   3. project + team compatibility, via the ONE shared predicate the write path also uses
 *      (`iterationAssignmentRefusal`) — so this picker can never offer what `splitWorkItem` would
 *      then refuse, which is the "picker narrower/wider than the write" fault class;
 *   4. strictly later than the source ({@link isLaterThanSource}).
 *
 * Ordered `startDate` then `id`: a total order, matching the repository's own `orderBy`, so
 * {@link earliestTarget}'s answer is deterministic when two sprints open on the same day.
 */
export function filterSplitTargets(
  source: SplitSourceIteration,
  candidates: readonly SplitTargetCandidate[],
  story: Pick<WorkItem, 'projectId' | 'teamId'>,
): SplitTargetCandidate[] {
  return candidates
    .filter((candidate) => candidate.id !== source.id)
    .filter((candidate) => candidate.state !== 'accepted')
    .filter((candidate) => iterationAssignmentRefusal(candidate, story) === null)
    .filter((candidate) => isLaterThanSource(source, candidate))
    .sort(compareByWindowThenId);
}

/** Total order over candidates — window first, `id` as the tiebreaker. */
function compareByWindowThenId(a: SplitTargetCandidate, b: SplitTargetCandidate): number {
  // Both are non-null by the time this runs (`isLaterThanSource` refused every NULL), but the
  // comparator is written to be total on its own so it cannot be broken by a future caller.
  const left = a.startDate ?? '';
  const right = b.startDate ?? '';
  if (left !== right) return left < right ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * BR-06 — the earliest valid target is the default. `null` when there is none, which is the
 * `no_target` ineligibility: a Story with nowhere to move cannot be split.
 *
 * Takes an ALREADY-FILTERED, already-sorted list — it does not re-sort. Handing it raw candidates is
 * a caller error, not something to defend against here, because a second sort would be a second
 * expression of the ordering rule.
 */
export function earliestTarget(
  targets: readonly SplitTargetCandidate[],
): SplitTargetCandidate | null {
  return targets[0] ?? null;
}

/**
 * The prefixes Split puts on the two resulting Stories. Exported so the default-title builder and
 * the stripper cannot drift apart.
 */
export const SPLIT_TITLE_PREFIX = {
  unfinished: '[Unfinished] ',
  continued: '[Continued] ',
} as const;

/**
 * §8 Q10 — strip an existing `[Continued] ` / `[Unfinished] ` prefix before applying a new one, so
 * re-splitting a `[Continued]` Story never produces `[Continued] [Continued] Foo`.
 *
 * Case-insensitive and anchored, and it strips ONE prefix, not all of them: a title that genuinely
 * begins `[Unfinished] [Continued] x` is already the artefact of a bug this cannot repair, and a
 * greedy loop would silently rewrite a title a user typed deliberately.
 */
export function stripSplitPrefix(title: string): string {
  return title.replace(/^\[(Continued|Unfinished)\]\s*/i, '');
}

/**
 * BR-12's starting point — the two default titles, both derived from the bare title so a re-split
 * cannot stack prefixes (Q10).
 *
 * Named `Title` rather than `Name` because the column is `work_items.title` and every other
 * work-item payload in this contract says `title`. The modal's visible LABEL still reads "Name",
 * from `t()` — that is a display concern and deliberately not a field name.
 */
export function defaultSplitTitles(title: string): {
  unfinishedTitle: string;
  continuedTitle: string;
} {
  const bare = stripSplitPrefix(title);
  return {
    unfinishedTitle: `${SPLIT_TITLE_PREFIX.unfinished}${bare}`,
    continuedTitle: `${SPLIT_TITLE_PREFIX.continued}${bare}`,
  };
}

/**
 * BR-14 — a Completed Task defaults to `[Unfinished]` (the work is done, so it belongs with the
 * historical record); every other Task defaults to `[Continued]` and follows the Story forward.
 *
 * Decided on the SERVER and shipped as `defaultSide` on each preview row, never re-derived in the
 * browser: the same rule computed twice is the same rule diverging once.
 *
 * `isCompletedScheduleState` is the shared helper again — `listTasksByParent` projects
 * `tasks.state` onto `scheduleState`, so a Task arrives here carrying `completed`.
 */
export function defaultTaskSide(state: WorkItem['scheduleState']): SplitSide {
  return isCompletedScheduleState(state) ? 'unfinished' : 'continued';
}

/**
 * BR-15 — Defects and Test Cases always default to `[Continued]`.
 *
 * A constant rather than an inlined literal at the two call sites: BR-15 is one rule about two
 * collections, and if it ever becomes conditional there must be one place to make it so.
 */
export const DEFAULT_RELATED_SIDE: SplitSide = 'continued';

// ── The preview read model ───────────────────────────────────────────────────
//
// Everything the Split modal needs in ONE round trip (plan §3.1), so the enabled/disabled state of
// `Split story` is decided by the SERVER and the browser never holds a second copy of the
// eligibility rule. Declared here beside the predicates that produce it rather than in
// `domain/work-item.types.ts`, so the Split vocabulary — sides, reasons, targets, defaults — reads
// as one thing.
//
// FIELD NAMING mirrors each entity's own column rather than flattening to one word: a work item and
// a task carry `title` (`work_items.title` / `tasks.title`, as every other work-item payload in this
// contract already says), an iteration carries `name` (`iterations.name`), and a test case carries
// `name` (`test_cases.name`). The modal's visible label may still read "Name" — that comes from
// `t()` and is a display concern.

/** The Story being split, as the modal's header and its two read-only panels need it. */
export interface SplitPreviewStory {
  id: string;
  itemKey: string;
  title: string;
  /** `work_items.story_points` (D2), as a number — the BA's "Plan Estimate". `null` = unpointed. */
  planEstimate: number | null;
  scheduleState: WorkItem['scheduleState'];
  releaseId: string | null;
  releaseName: string | null;
  iterationId: string | null;
  iterationName: string | null;
  teamId: string | null;
  projectId: string;
}

/** One offered Target Iteration. The same shape the filter produced, minus the scope it filtered on. */
export interface SplitPreviewTarget {
  id: string;
  name: string;
  iterationKey: string | null;
  state: IterationState;
  startDate: string | null;
  endDate: string | null;
}

/** BR-06/BR-12's starting values. `targetIterationId` is `null` when there is no valid target. */
export interface SplitPreviewDefaults {
  unfinishedTitle: string;
  continuedTitle: string;
  targetIterationId: string | null;
}

/**
 * One Task row in the distribution panel.
 *
 * `state` is `work.tasks.state` (`defined｜in_progress｜completed`), which `listTasksByParent`
 * projects onto the read model's `scheduleState` — a strict subset of the work-item schedule states,
 * so the type is honest rather than widened.
 */
export interface SplitPreviewTask {
  id: string;
  itemKey: string;
  title: string;
  state: WorkItem['scheduleState'];
  todoHours: number | null;
  estimateHours: number | null;
  actualHours: number | null;
  defaultSide: SplitSide;
}

/** One child Defect row. `explicitIteration*` is the Iteration the Defect owns and Split never touches (BR-18). */
export interface SplitPreviewDefect {
  id: string;
  itemKey: string;
  title: string;
  scheduleState: WorkItem['scheduleState'];
  priority: WorkItem['priority'];
  explicitIterationId: string | null;
  explicitIterationName: string | null;
  defaultSide: SplitSide;
}

/** One linked Test Case row. `lastVerdict` is trigger-maintained; `null` renders as `Not Run` (BR10). */
export interface SplitPreviewTestCase {
  id: string;
  testCaseKey: string;
  name: string;
  type: string;
  lastVerdict: string | null;
  defaultSide: SplitSide;
}

/**
 * The whole preview.
 *
 * `ineligibleReason` is present for TELEMETRY AND TESTS ONLY. SRS §11 requires the control to be
 * disabled with no explanatory message, so the UI reads {@link SplitPreview.eligible} alone.
 *
 * The collections are EMPTY rather than absent when the Story is ineligible: a nullable `story` or
 * optional arrays would make every consumer branch twice for a modal that never opens in that case.
 */
export interface SplitPreview {
  eligible: boolean;
  ineligibleReason: SplitIneligibleReason | null;
  story: SplitPreviewStory;
  targets: SplitPreviewTarget[];
  defaults: SplitPreviewDefaults;
  tasks: SplitPreviewTask[];
  defects: SplitPreviewDefect[];
  testCases: SplitPreviewTestCase[];
}
