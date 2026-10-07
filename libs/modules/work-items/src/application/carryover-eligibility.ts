/**
 * Story Target End Date and Carryover — the pure half (Phase 7 CO, plan D5).
 *
 * No DB, no DI: every function is a decision over rows already in memory, so each rule is unit-tested
 * on its own (`carryover-eligibility.spec.ts`, one predicate per test). The SAME functions back three
 * callers and that is the point — `GET /work-items/:id/carryover-options` (the picker), the
 * `targetEndDate` PATCH validation (D7) and `POST /work-items/:id/carryover` (D6). A picker and a
 * write that disagree is the fault class `CLAUDE.md` keeps recording; here they cannot.
 *
 * THIS IS NOT SPLIT'S RULE. Two deliberate differences from `split-story.ts` / `iteration-assignable.ts`:
 *
 *   • STRICT TEAM EQUALITY (ruling R7): the Iteration's team must equal the Story's team, and a
 *     team-less Iteration matches only a team-less Story. Split admits a shared (team-less) sprint
 *     for a team-owned item (§8 Q2); Carryover does not.
 *   • "FUTURE" IS THE MOCKUP RULE (ruling R9): an Iteration is a candidate when it IS the current one
 *     or starts AFTER the current one starts — so an overlapping sprint may be a target. Split
 *     requires strictly non-overlapping (`start > source.end`).
 *
 * Dates are ISO `YYYY-MM-DD` strings compared lexicographically, for the reason `split-story.ts`
 * gives: `date` columns arrive as strings and parsing them would add a time zone to a comparison that
 * has none.
 */
import type { IterationState } from '../../../../../db/schema/enums';

/** The Iteration states a Story may be carried into (CO-BR-05). `accepted` is closed history. */
export const CARRYOVER_TARGET_STATES: readonly IterationState[] = ['planning', 'committed'];

/** One Iteration of the Story's project, as the rules need to see it. */
export interface CarryoverIteration {
  id: string;
  name: string;
  iterationKey: string | null;
  state: IterationState;
  startDate: string | null;
  endDate: string | null;
  projectId: string;
  teamId: string | null;
}

/** What the rules need to know about the Story. */
export interface CarryoverStory {
  projectId: string;
  teamId: string | null;
  /** System-managed first In-Progress date (CO-BR-06); `null` before the Story started. */
  startDate: string | null;
}

/** Does `iteration`'s window contain `date` (both ends inclusive)? A dateless one contains nothing. */
export function containsDate(
  iteration: Pick<CarryoverIteration, 'startDate' | 'endDate'>,
  date: string,
): boolean {
  if (iteration.startDate === null || iteration.endDate === null) return false;
  return iteration.startDate <= date && date <= iteration.endDate;
}

/** CO-BR-04 — same project. */
export function isSameProject(
  story: Pick<CarryoverStory, 'projectId'>,
  iteration: Pick<CarryoverIteration, 'projectId'>,
): boolean {
  return story.projectId === iteration.projectId;
}

/** CO-BR-04 / R7 — strict team equality. `null` matches only `null`. */
export function isSameTeam(
  story: Pick<CarryoverStory, 'teamId'>,
  iteration: Pick<CarryoverIteration, 'teamId'>,
): boolean {
  return (story.teamId ?? null) === (iteration.teamId ?? null);
}

/** CO-BR-05 — `planning` or `committed`. */
export function isOpenState(iteration: Pick<CarryoverIteration, 'state'>): boolean {
  return CARRYOVER_TARGET_STATES.includes(iteration.state);
}

/**
 * R9 — the current Iteration itself, or one starting after the current one starts. A dateless
 * candidate or a dateless current Iteration is refused: there is no window to compare.
 */
export function isCurrentOrLater(
  iteration: Pick<CarryoverIteration, 'id' | 'startDate' | 'endDate'>,
  current: Pick<CarryoverIteration, 'id' | 'startDate'>,
): boolean {
  if (iteration.startDate === null || iteration.endDate === null) return false;
  if (iteration.id === current.id) return true;
  if (current.startDate === null) return false;
  return iteration.startDate > current.startDate;
}

/** D5 — all four predicates. */
export function isEligibleIteration(
  story: Pick<CarryoverStory, 'projectId' | 'teamId'>,
  iteration: CarryoverIteration,
  current: Pick<CarryoverIteration, 'id' | 'startDate'>,
): boolean {
  return (
    isSameProject(story, iteration) &&
    isSameTeam(story, iteration) &&
    isOpenState(iteration) &&
    isCurrentOrLater(iteration, current)
  );
}

/** The eligible set, ordered `startDate`, then `name`, then `id` (a total order). */
export function eligibleIterations(
  story: Pick<CarryoverStory, 'projectId' | 'teamId'>,
  candidates: readonly CarryoverIteration[],
  current: Pick<CarryoverIteration, 'id' | 'startDate'>,
): CarryoverIteration[] {
  return candidates
    .filter((iteration) => isEligibleIteration(story, iteration, current))
    .sort(compareIterations);
}

function compareIterations(a: CarryoverIteration, b: CarryoverIteration): number {
  const left = a.startDate ?? '';
  const right = b.startDate ?? '';
  if (left !== right) return left < right ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * CO-BR-13/14 — the earliest selectable date: the Story's Start Date when it has one, otherwise the
 * start of the earliest DATED eligible Iteration. `null` when nothing is selectable at all.
 *
 * Skips dateless entries rather than trusting `eligible[0]` (PR #653 review, round 3):
 * `compareIterations` sorts a null start FIRST, so a list that did not come through
 * {@link eligibleIterations} would otherwise disable the whole calendar. A dateless Iteration
 * contains no day, so skipping it never changes the answer for a filtered list.
 */
export function minDate(
  story: Pick<CarryoverStory, 'startDate'>,
  eligible: readonly CarryoverIteration[],
): string | null {
  const firstDated = eligible.find((iteration) => iteration.startDate !== null);
  if (!firstDated) return null;
  if (story.startDate !== null) return story.startDate;
  return firstDated.startDate;
}

/**
 * CO-BR-15/16 — on or after {@link minDate}, and inside at least one eligible Iteration.
 *
 * R6: when the CURRENT Iteration is not itself eligible (it is `accepted`), only dates after it ends
 * are enabled — every one of them opens a Carryover. Otherwise an overlapping future sprint could
 * enable a date inside the accepted window that neither saves sensibly nor resolves a target.
 */
export function isEnabledDate(
  date: string,
  story: Pick<CarryoverStory, 'startDate'>,
  current: Pick<CarryoverIteration, 'id' | 'endDate'>,
  eligible: readonly CarryoverIteration[],
): boolean {
  const min = minDate(story, eligible);
  if (min === null || date < min) return false;
  const currentEligible = eligible.some((iteration) => iteration.id === current.id);
  if (!currentEligible && !isAfterCurrent(date, current)) return false;
  return eligible.some((iteration) => containsDate(iteration, date));
}

/**
 * CO-BR-18/19/20 — the Carryover targets for a date: eligible Iterations other than the current one
 * that contain it, and only when the date is AFTER the current Iteration ends. An empty list for a
 * date inside the current window (that is a plain save, CO-BR-17).
 *
 * The current Iteration needs no explicit exclusion (PR #653 review, round 3): past the
 * `isAfterCurrent` guard the date is later than `current.endDate`, so `containsDate(current, date)`
 * is false by construction.
 */
export function resolveTargets(
  date: string,
  current: Pick<CarryoverIteration, 'endDate'>,
  eligible: readonly CarryoverIteration[],
): CarryoverIteration[] {
  if (!isAfterCurrent(date, current)) return [];
  return eligible.filter((iteration) => containsDate(iteration, date));
}

/** Is the date after the current Iteration's end? A dateless current Iteration has no "after". */
export function isAfterCurrent(
  date: string,
  current: Pick<CarryoverIteration, 'endDate'>,
): boolean {
  return current.endDate !== null && date > current.endDate;
}

/**
 * D7's verdict for a non-null Target End Date on a SCHEDULED Story — what the PATCH may do with it.
 *
 *   • `invalid`            — not an enabled date (412 `TARGET_END_DATE_INVALID`);
 *   • `requires_carryover` — after the current Iteration (412 `TARGET_END_REQUIRES_CARRYOVER`);
 *   • `save`               — inside the current window: save, move nothing.
 */
export type TargetEndVerdict = 'invalid' | 'requires_carryover' | 'save';

export function targetEndVerdict(
  date: string,
  story: Pick<CarryoverStory, 'startDate'>,
  current: Pick<CarryoverIteration, 'id' | 'endDate'>,
  eligible: readonly CarryoverIteration[],
): TargetEndVerdict {
  if (!isEnabledDate(date, story, current, eligible)) return 'invalid';
  if (isAfterCurrent(date, current)) return 'requires_carryover';
  return 'save';
}
