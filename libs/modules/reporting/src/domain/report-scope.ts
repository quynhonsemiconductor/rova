/**
 * The shared report query contract (P6-RPT-01): scope, workspace-local dates and the
 * working-day calendar. Every Phase 6 report resolves its scope through this module so
 * three reports cannot disagree about what "this Team, this timebox, end of that day"
 * means.
 *
 * Pure. No clock, no request, no database — the same reason `portfolio-rollup.ts` is
 * pure: these are the rules the reports are judged on, and they must be verifiable
 * without a database.
 */

// ── Team scope ──────────────────────────────────────────────────────────────

/**
 * `All Teams` is a first-class scope, not "teamId omitted".
 *
 * Modelling it as `teamId?: string` made the two cases indistinguishable from a
 * forgotten parameter, and they behave differently in every report: All Teams fuses
 * per-Team iterations onto one timebox and must de-duplicate work items across Teams,
 * while a selected Team must return that Team ONLY.
 *
 * THE THIRD KIND IS THE READER'S OWN CEILING, NOT THEIR CHOICE (BA ruling, 2026-08-17)
 * ------------------------------------------------------------------------------------
 * "Null means Project Backlog, accessible only to Workspace Admin and Project Admin. Editor …
 * cannot access team-less items. Enforce this consistently in API queries, lists, reports, search,
 * pickers and direct URLs." So a per-project `editor` has no `All Teams` and no Project Backlog:
 * every report they read is bounded by the Teams they hold, and `AccessService.resolveTeamScope` is
 * the one place that answer comes from.
 *
 * `teams` is a SEPARATE kind rather than a flag on the other two, because the difference is not
 * cosmetic in either direction:
 *
 *   • against `all` it excludes other Teams AND the Project Backlog;
 *   • against `team` it excludes the Project Backlog — a team-agnostic row counts inside a
 *     selected Team for an admin (see `inScope` in `release-tracking.ts`, which is shared with the
 *     FROZEN writer and must keep that rule) and must not for an editor.
 *
 * A single-element `teams` scope is therefore NOT the same thing as `{ kind: 'team' }`, and an
 * empty one is a real answer — "no delivery scope", which must produce NO rows. Never flatten it
 * to `all`: that is the fail-open shape, and `scope.kind === 'team' ? predicate : undefined` was
 * exactly it, which is why no such ternary survives in the repository.
 */
export type TeamScope =
  | { readonly kind: 'team'; readonly teamId: string }
  | { readonly kind: 'all' }
  | { readonly kind: 'teams'; readonly teamIds: readonly string[] };

export const ALL_TEAMS: TeamScope = { kind: 'all' };

export function teamScope(teamId: string | null | undefined): TeamScope {
  return teamId ? { kind: 'team', teamId } : ALL_TEAMS;
}

/**
 * The scope of a reader who may only see their own Teams' work.
 *
 * De-duplicated so a doubled roster row cannot turn `IN (…)` into a longer list than the reader
 * has teams, and frozen as `readonly` so a caller cannot widen a scope it was handed.
 */
export function restrictedTeamScope(teamIds: readonly string[]): TeamScope {
  return { kind: 'teams', teamIds: Object.freeze([...new Set(teamIds)]) };
}

/**
 * "This reader holds no Team", which is a report's EMPTY state and never "no filter".
 *
 * Callers short-circuit on it rather than emitting `IN ()`, which is not portable as "match
 * nothing" — the same `null`-versus-`[]` distinction `listReadableProjectIds` documents.
 */
export function isEmptyTeamScope(scope: TeamScope): boolean {
  return scope.kind === 'teams' && scope.teamIds.length === 0;
}

/**
 * Which FROZEN series a scope may be served, or `null` when none exists.
 *
 * Burndown and the release burnup are recorded history: `iteration_daily_snapshots` and
 * `release_daily_snapshots` hold one row per (timebox, team, day) plus a `team_id IS NULL` row that
 * was MEASURED over the whole scope. CLAUDE.md's rule is that a read picks exactly one series,
 * never both and never a sum — for releases the team rows genuinely overlap (a team-agnostic child
 * counts inside every team's row, and a Feature spanning two teams sits in both derived buckets),
 * so a sum double-counts.
 *
 * That leaves three answers for a team-restricted reader, and no fourth:
 *
 *   • ONE team → that team's own rows. Identical to a selected-Team read, and fully measured.
 *   • NO team → nothing. There is no scope to serve.
 *   • TWO OR MORE teams → nothing, reported as unavailable. The `team_id IS NULL` row spans Teams
 *     the reader may not see (serving it is a disclosure) and summing their team rows is forbidden,
 *     so the series they asked for was never measured. The reader selects one of their Teams; the
 *     alternative — inventing an aggregate — is the `buildFallbackSnapshots` mistake IB §5 bans.
 *
 * Worth recording for whoever revisits this: for `iteration_daily_snapshots` ALONE a sum would be
 * arithmetically exact, because `measureIterationDay` resolves each task to exactly one team
 * (`coalesce(task, parent, iteration)`), so the team rows there do not overlap. It is still not
 * done, because the release burnup cannot follow suit and one report silently aggregating where its
 * neighbour refuses is worse than both refusing. A ruling could change this for Burndown only.
 */
export function frozenSeriesScope(
  scope: TeamScope,
): { readonly kind: 'all' } | { readonly kind: 'team'; readonly teamId: string } | null {
  if (scope.kind === 'teams') {
    return scope.teamIds.length === 1 ? { kind: 'team', teamId: scope.teamIds[0] } : null;
  }
  return scope;
}

/** The scope every report query is bounded by. Project is never optional. */
export interface ReportScope {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly team: TeamScope;
  /** IANA zone from `workspace_settings.timezone`. Every date cutoff uses it. */
  readonly timeZone: string;
  /** ISO day numbers from `workspace_settings.working_days` (1 = Mon … 7 = Sun). */
  readonly workingDays: readonly number[];
}

// ── The working-day calendar ────────────────────────────────────────────────

/** Mon–Fri. The column default; repeated here for pure callers and tests. */
export const DEFAULT_WORKING_DAYS: readonly number[] = [1, 2, 3, 4, 5];

/** ISO day of week (1 = Monday … 7 = Sunday) for a `YYYY-MM-DD` calendar date. */
export function isoDayOfWeek(localDate: string): number {
  // Parsed as UTC midnight on purpose: a calendar date has no zone, and using local
  // parsing would shift the weekday for anyone west of UTC.
  const day = new Date(`${localDate}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

export function isWorkingDay(localDate: string, workingDays: readonly number[]): boolean {
  return workingDays.includes(isoDayOfWeek(localDate));
}

/**
 * Whether this is a real `YYYY-MM-DD` calendar date.
 *
 * Shape AND validity: `'2026-02-30'` has the right shape and is not a date, and every helper
 * here reaches for `new Date(...)` immediately after.
 */
export function isCalendarDate(value: string | null | undefined): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Add whole days to a `YYYY-MM-DD` date, staying in the calendar (no zone involved). */
export function addDays(localDate: string, days: number): string {
  const d = new Date(`${localDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Every working day from `start` to `end` inclusive.
 *
 * This is the Burndown x-axis (IB §2) and the denominator of the Ideal line's
 * working-day index (IB-BR-03). Weekend snapshots may still be STORED for audit; they
 * are simply not plotted.
 *
 * Returns `[]` when either endpoint is missing or unparseable, when the range is inverted, or
 * when the window contains no working day at all — an empty axis is an explicit empty state,
 * never a fabricated one.
 *
 * The missing-endpoint guard is load-bearing, not defensive dressing. A dateless iteration
 * reaches here as `''` (the caller has nothing else to pass), and `'' < ''` is false, so the
 * inverted-range check let it through into the loop — where `addDays('')` calls
 * `toISOString()` on an Invalid Date and throws `RangeError`. That was a 500 on every
 * iteration with no dates.
 */
export function workingDaysBetween(
  start: string,
  end: string,
  workingDays: readonly number[] = DEFAULT_WORKING_DAYS,
): string[] {
  if (!isCalendarDate(start) || !isCalendarDate(end)) return [];
  if (end < start) return [];
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    if (isWorkingDay(d, workingDays)) out.push(d);
  }
  return out;
}

// ── Workspace-local date boundaries ─────────────────────────────────────────
//
// MOVED TO `@platform` (`utils/date.util.ts`) BY SU-06, and RE-EXPORTED here so every existing
// import in this module keeps working. The Split write path needs the same workspace-local
// conversion to clamp its burndown marker dates, and the two alternatives were worse: `work-items`
// importing `@modules/reporting` inverts the dependency, and a second copy of the offset math is
// what §8 Q17 forbids. The implementations are unchanged and still have exactly one home.
import { endOfWorkspaceDay, startOfWorkspaceDay, workspaceLocalDate } from '@platform';

export { workspaceLocalDate, endOfWorkspaceDay, startOfWorkspaceDay };

/**
 * Was this snapshot taken at the END of its own local day, or partway through it?
 *
 * IB-BR-01 calls the Burndown source an "end-of-day snapshot", and the job is what makes that true:
 * it writes TODAY repeatedly and the last write before local midnight is the value that survives. If
 * the job stops early — a crash, a deploy, a paused schedule — the surviving value is whatever the
 * morning looked like, and `finalizeSnapshotsBefore` freezes it anyway, because a closed day cannot be
 * re-measured. Freezing is right; presenting a 10:00 reading as the closing figure is not.
 *
 * The cron runs hourly, so a genuine end-of-day capture lands within an hour of local midnight. A
 * wider window would call a mid-afternoon crash "end of day"; a narrower one would flag a tick that
 * merely ran a few minutes early. `windowHours` is a parameter so a different schedule can say so
 * rather than silently inheriting an assumption about this one.
 */
export function isEndOfDayCapture(
  capturedAt: Date,
  localDate: string,
  timeZone: string,
  windowHours = 1,
): boolean {
  const closes = endOfWorkspaceDay(localDate, timeZone).getTime();
  const opensWindow = closes - windowHours * 60 * 60 * 1000;
  const at = capturedAt.getTime();
  // `<= closes` and not `< closes`: the final tick can land inside the same millisecond as the
  // boundary, and a capture AFTER the day closed belongs to the next day, not this one.
  return at >= opensWindow && at <= closes;
}

/**
 * Has this workspace-local date finished?
 *
 * What makes a daily snapshot finalizable (IB §4): a closed day is frozen, today is
 * still being written. Comparing dates as strings rather than instants keeps the answer
 * in the workspace's own calendar.
 */
export function isDayClosed(localDate: string, now: Date, timeZone: string): boolean {
  return localDate < workspaceLocalDate(now, timeZone);
}

// ── Display rounding ────────────────────────────────────────────────────────

/**
 * "Aggregate full-precision source values first, then display… maximum two decimals."
 *
 * A number, not a string: the API returns numbers and the SPA formats them. Rounding
 * here exists so a sum of fractional points does not arrive as 43.000000000000004.
 */
export function roundForDisplay(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
