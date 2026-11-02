/**
 * How a report names its scope, in one place for all four of them.
 *
 * Every Phase 6 UI contract spells the Team half of the scope the same way — Burndown's centred
 * context line is `{Project Name} - {Team Name|All Teams}` (IB §7), Velocity's is
 * `Team: {Team Name|All Teams}` (§6), Team Capacity's header is "report name and selected Team
 * scope" (§6), and Release Tracking's `All Teams` is a named scope in RT-BR-01. On the wire, that
 * scope is `context.teamName === null`.
 *
 * All four rendered it as `teamName ?? ''`. So the aggregate — the DEFAULT scope, the one a reader
 * sees first — printed as nothing: "NextGen Platform - ", "Team: ", "Team Capacity - ". A trailing
 * separator with an empty space after it reads as a value still loading, which is the one thing it
 * is not.
 *
 * A function rather than four call-site `??`s because the fallback is a TERM, and a term that
 * appears in four places drifts in four directions. `capacity.json` and `settings.json` already
 * spell it "All teams"; the SRS says "All Teams", and reports follow the SRS.
 */

/**
 * The Team half of a report scope.
 *
 * @param teamName `null` for the aggregate, as the API sends it.
 * @param allTeamsLabel Translated `common:allTeams`, passed in so this stays pure.
 */
export function teamScopeLabel(teamName: string | null | undefined, allTeamsLabel: string): string {
  return teamName ?? allTeamsLabel
}

/**
 * `{Project} - {Team|All Teams}` — Burndown's context line, and the same pair wherever both halves
 * are shown.
 *
 * An en dash with spaces, matching the SRS's own rendering of the line.
 */
export function reportScopeLabel(
  projectName: string | null | undefined,
  teamName: string | null | undefined,
  allTeamsLabel: string,
): string {
  return `${projectName ?? ''} - ${teamScopeLabel(teamName, allTeamsLabel)}`.trim()
}

/**
 * The iterations a team-scoped report can actually serve: the team's OWN, plus the project's shared
 * ones.
 *
 * This is the client half of `teamOrSharedTimebox`. `iterations.team_id` is optional in this product
 * (real Rally collapses project and team; we do not), so most iterations name no team and belong to
 * every team in the project — the server counts those in a team-scoped report and it has to, or a
 * project running one shared sprint would report nothing at all.
 *
 * The pickers on Burndown and Team Capacity listed EVERY iteration regardless of the selected Team,
 * which fails in both directions: it offers another team's private sprint, where the report can only
 * answer with an empty chart, and it gives no sign that the shared sprints in the list are the ones
 * the numbers come from. Filtering here rather than asking the list endpoint for `teamId` is
 * deliberate — that filter is a strict `team_id = ?`, which drops exactly the shared iterations that
 * matter (SQL equality never matches NULL).
 */
export function iterationsInScope<T extends { teamId: string | null }>(
  iterations: readonly T[],
  teamId: string | undefined,
): readonly T[] {
  if (!teamId) return iterations
  return iterations.filter((iteration) => iteration.teamId === null || iteration.teamId === teamId)
}

/**
 * The iterations the Carryover report can serve for a selected Team: that Team's OWN, without the
 * shared ones {@link iterationsInScope} adds.
 *
 * Carryover uses strict team equality (R7) — a team-less Iteration only ever holds team-less events,
 * which a Team scope withholds — so a shared sprint here could only answer 0/0. The server's trend
 * lists the same population (`listScopedIterations`), so the picker and the trend cannot disagree
 * (US-118 AC5, BA retest TR-110).
 */
export function iterationsOwnedByTeam<T extends { teamId: string | null }>(
  iterations: readonly T[],
  teamId: string | undefined,
): readonly T[] {
  if (!teamId) return iterations
  return iterations.filter((iteration) => iteration.teamId === teamId)
}
