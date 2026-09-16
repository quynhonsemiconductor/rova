/**
 * The ONE expression of "may this Iteration hold this Work Item?" — the project half and the team
 * half, as a pure predicate over rows already in memory.
 *
 * It exists because the rule has TWO audiences and they must not be allowed to disagree:
 *
 *   • the WRITE — `WorkItemsService.assertIterationAssignable`, which loads the iteration's scope
 *     and THROWS `ITERATION_PROJECT_MISMATCH` / `ITERATION_TEAM_MISMATCH`;
 *   • a PICKER — Split's Target-Iteration list (`filterSplitTargets`), which must offer exactly the
 *     set the write accepts and therefore cannot use a throwing method as a filter.
 *
 * `CLAUDE.md`'s feed rule states the hazard plainly: "When a picker and a write path disagree, the
 * WRITE is the contract", and the `parent-story-feed` / `iterations/options` incidents are what a
 * second copy of this rule costs. So the rule is written once, here, and the throwing guard becomes
 * a mapping from this function's answer onto the two existing error codes — same codes, same order,
 * same behaviour.
 *
 * **A team-less Iteration is a SHARED sprint and is legal for a team-owned item.** That is Rova's
 * rule, not the Split mockup's: `reference-extras.ts` seeds NXP's future sprint team-less on purpose
 * ("Both are team-LESS on purpose"), and the refusal below fires only when BOTH sides name a team.
 * Ruled binding for Split as §8 Q2 / D8 of `docs/PLAN-phase7-split-unfinished.md`; do not
 * re-implement the mockup's `iteration.team === item.team` equality anywhere.
 */

/** What the caller is allowed to know about the iteration — deliberately no more than this. */
export interface IterationAssignmentScope {
  projectId: string;
  teamId: string | null;
}

/** What the caller is allowed to know about the item — deliberately no more than this. */
export interface IterationAssignmentSubject {
  projectId: string;
  teamId: string | null;
}

/**
 * Which half of the rule refuses, or `null` when the iteration is assignable.
 *
 * A reason code rather than a boolean, so the throwing caller can keep raising the SPECIFIC
 * exception it always raised: "wrong project" and "wrong team" are different facts, and only one of
 * them is something the reader can fix by choosing a different sprint.
 */
export type IterationAssignmentRefusal = 'project' | 'team';

export function iterationAssignmentRefusal(
  scope: IterationAssignmentScope,
  item: IterationAssignmentSubject,
): IterationAssignmentRefusal | null {
  if (scope.projectId !== item.projectId) return 'project';
  // Both sides must name a team for a mismatch to exist: a team-less iteration is shared, and a
  // team-less item is the Project Backlog, which any of the project's sprints may schedule.
  if (scope.teamId && item.teamId && scope.teamId !== item.teamId) return 'team';
  return null;
}
