import { eq, inArray, isNull, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { iterations } from '../../../../../../db/schema/work';
import type { TeamScope } from '../../domain/report-scope';

/**
 * How a {@link TeamScope} becomes SQL — the ONE home of that translation.
 *
 * Split out of `reporting.drizzle-repository.ts` so it can be asserted without a database. Every
 * report's team narrowing is one of these two predicates, and the failure mode they exist to prevent
 * is silent: the repository used to spell `scope.kind === 'team' ? predicate : undefined` at thirteen
 * call sites, which is a fail-OPEN shape — a scope kind nobody updated lands in the `undefined`
 * branch and reads the whole project. `team-scope.sql.spec.ts` therefore asserts that a
 * team-restricted scope always produces a predicate, and that an EMPTY one produces `false` rather
 * than nothing.
 */

/**
 * A parenthesised SQL list for a raw `in` inside a hand-written predicate.
 *
 * Drizzle's `inArray` cannot be embedded in the OR the task-scoping rule needs, and binding
 * each id separately keeps this parameterised rather than string-concatenated.
 */
export function inList(ids: readonly string[]): SQL {
  return sql`(${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

/**
 * Which iterations a TEAM-scoped report may draw on: the team's own, plus the SHARED ones.
 *
 * `iterations.team_id` is optional in this schema — an iteration needs a project and may name a
 * team (real Rally collapses the two, we do not) — so a project can run one timebox per sprint
 * that every team works inside. Matching `team_id = :team` alone therefore returned NOTHING for
 * such a project: 195 of 206 iterations in the local database are team-less, so a selected Team
 * showed `iterationCount: 0`, empty Velocity bars and zero capacity while Team Status showed the
 * hours. The inverse was just as wrong — the null-group fallback branch dropped the predicate
 * entirely, so a selected Team DID get a shared iteration's data there.
 *
 * The timebox says WHICH window; the work says WHOSE it is. So a shared window is in scope and
 * the per-item predicate below is what narrows the numbers.
 *
 * A team-RESTRICTED reader (BA ruling, 2026-08-17) gets their Teams' timeboxes plus the shared ones
 * for the same reason: a team-less ITERATION is a window, not the Project Backlog — that is a
 * property of a work item's own `team_id`, and {@link teamMatches} is what withholds it.
 */
export function timeboxInScope(scope: TeamScope): SQL | undefined {
  if (scope.kind === 'all') return undefined;
  if (scope.kind === 'team')
    return or(eq(iterations.teamId, scope.teamId), isNull(iterations.teamId));
  // Never `IN ()`, which is not portable as "match nothing": a reader with no Team sees no timebox.
  // Callers short-circuit before this, and this is the defence in depth behind them.
  if (scope.teamIds.length === 0) return sql`false`;
  return or(inArray(iterations.teamId, [...scope.teamIds]), isNull(iterations.teamId));
}

/**
 * The team predicate for a resolved-team expression — `= :team`, `IN (…)`, or nothing.
 *
 * `resolvedTeam` is whatever that query measures ownership by: a column, or the
 * `coalesce(task, parent, iteration)` / `coalesce(item, iteration)` tiers the two-and-three-tier
 * rules use. Passing the expression in is what keeps eligibility and measurement in the same scope —
 * CLAUDE.md records zero-point Velocity bars caused by a join that carried no team predicate while
 * the measurement carried one.
 *
 * For a team-restricted reader the `IN` also excludes `NULL` for free, because SQL equality never
 * matches NULL — and that is exactly the Project Backlog exclusion the 2026-08-17 ruling asks for,
 * in the same clause that scopes the Teams.
 */
export function teamMatches(scope: TeamScope, resolvedTeam: SQLWrapper): SQL | undefined {
  if (scope.kind === 'all') return undefined;
  if (scope.kind === 'team') return sql`${resolvedTeam} = ${scope.teamId}::uuid`;
  if (scope.teamIds.length === 0) return sql`false`;
  return sql`${resolvedTeam} in ${inList([...scope.teamIds])}`;
}
