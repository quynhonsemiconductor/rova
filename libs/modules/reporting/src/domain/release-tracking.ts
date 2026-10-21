import { roundForDisplay } from './report-scope';
import type { TeamScope } from './report-scope';

/**
 * Release Tracking classification and totals (RT-BR-01…08).
 *
 * Everything here is a rule the BA wrote down, expressed over plain rows. The repository
 * produces the rows for one Release and one Project/Team scope; this module decides which
 * bucket each row belongs to and what its Status cell says.
 *
 * The classification is deliberately structural: it reads `releaseId` on the Feature and
 * on its children, and NEVER infers membership from a completion percentage or from what
 * fraction of children match the Release (RT §3, and acceptance example 5).
 */

/** One unit selector drives BOTH the grid's Status column and the Burnup chart (RT-BR-05). */
export type ChartUnit = 'points' | 'count';

export type ReleaseBucket = 'direct' | 'derived' | 'unparented';

/**
 * Rows per page over the ACTIVE bucket when the caller does not ask.
 *
 * Paging is a domain concern here, not a transport detail: the row set grows with the
 * PROJECT's Feature count (a Derived Feature is one outside the release, so the population
 * cannot be narrowed by the release), while the summary counts and the Preliminary/Planned/
 * Accepted totals are measured over that whole population and must not move when a page does.
 */
export const RELEASE_TRACKING_PAGE_SIZE = 25;

/** Hard ceiling on one page, so a caller cannot opt out of paging by asking for everything. */
export const RELEASE_TRACKING_MAX_PAGE_SIZE = 200;

/** A Story or Defect. `featureId` null means unparented. */
export interface ReleaseChild {
  id: string;
  itemKey: string;
  type: 'story' | 'defect';
  title: string;
  featureId: string | null;
  releaseId: string | null;
  releaseName: string | null;
  teamId: string | null;
  teamName: string | null;
  planEstimate: number | null;
  /** schedule_state ∈ {accepted, release}. `Completed` is NOT accepted (RT-AC-08). */
  acceptedEquivalent: boolean;
  scheduleState: string;
}

/** A portfolio Feature. */
export interface ReleaseFeature {
  id: string;
  itemKey: string;
  name: string;
  releaseId: string | null;
  teamId: string | null;
  teamName: string | null;
  rank: string;
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  /** Top-down forecast. 0 means "not forecast" since migration 0079. */
  refinedPoints: number;
  refinedCount: number;
  /** What this Feature's Preliminary Estimate size maps to in workspace settings. */
  preliminaryPoints: number;
  preliminaryCount: number;
}

/**
 * Does this row's Team ownership fall inside the selected scope?
 *
 * A row with NO Team is TEAM-AGNOSTIC and therefore inside EVERY scope — the same rule
 * `teamOrSharedTimebox` applies to `iterations.team_id`: the timebox says which window, the
 * work says whose it is, and a row that names no team makes no statement to exclude it on.
 * `portfolio_items.team_id` and `work_items.team_id` are both nullable and `ck_portfolio_epic_shape`
 * constrains only Epics, so a Feature with a Release and no Team is an ordinary row (`FE-2` in the
 * demo seed is one).
 *
 * Without this a team-less Feature failed RT-BR-01's admission test and, because its own
 * `releaseId` equals the selected Release, could not be Derived either (RT-BR-02 requires
 * `releaseId != R`) — so it landed in NO bucket under a selected Team while its children still
 * fed Planned, Accepted and the Burnup, which are keyed on the LEAF's own team. The reader could
 * not reconcile the totals against any of the three buckets.
 *
 * Applied to Features and to leaves alike, deliberately: eligibility has to be counted in the
 * same scope as the measurement. It does mean a team-agnostic row is measured under every Team,
 * so the per-Team totals do not sum to the All Teams total — which is already this report's
 * contract (`release_daily_snapshots.team_id IS NULL` is a MEASURED All Teams row, never a sum).
 *
 * What this does NOT do is admit a Feature owned by a team OUTSIDE the scope. That is a real
 * divergence from Rally, which derives such a Feature, and it is tracked as `P6-RT-9`
 * pending the live-Rally check the decision matrix asked for; RT-BR-01/02 as written exclude it.
 */
export function inScope(teamId: string | null, scope: TeamScope): boolean {
  // All Teams = every Team in the selected Project, including work with no Team yet:
  // excluding it would make the three bucket totals disagree with the project's own
  // backlog, and the page's only scope control is the global one.
  if (scope.kind === 'all') return true;
  /**
   * A TEAM-RESTRICTED reader is the one case where a team-agnostic row is OUT of scope.
   *
   * The paragraph above is kept exactly as it was, because it still governs an admin: this
   * predicate is shared with `ReportSnapshotService`, so changing what a `{ kind: 'team' }` scope
   * admits would change what the FROZEN writer records — and `release_team_targets` is captured
   * once, so a widened or narrowed population there is permanent. The writer only ever passes
   * `all` or `team`, so both branches below it are untouched by this addition.
   *
   * For an `editor` the BA ruling of 2026-08-17 is the deciding sentence: `team_id IS NULL` is the
   * Project Backlog and it is admin-only, so a team-less Feature or leaf is not "in every scope"
   * for them — it is a population they may not read. Hence the strict membership test, and hence a
   * one-element `teams` scope is deliberately NOT the same predicate as `{ kind: 'team' }`.
   */
  if (scope.kind === 'teams') return teamId !== null && scope.teamIds.includes(teamId);
  return teamId === null || teamId === scope.teamId;
}

// ── Buckets ─────────────────────────────────────────────────────────────────

export interface FeatureBuckets<F extends ReleaseFeature = ReleaseFeature> {
  direct: F[];
  derived: F[];
  /** For a Derived Feature: the scoped children that caused its inclusion. */
  derivedCause: Map<string, ReleaseChild[]>;
}

/**
 * Split Features into `Features in Release` and `Derived Features`.
 *
 * Direct (RT-BR-01): `Feature.releaseId = R` and the Feature's Team is in scope.
 * Derived (RT-BR-02): `Feature.releaseId != R` (including unassigned) AND at least one
 * direct Story/Defect child has `releaseId = R` with its Team in scope.
 *
 * The two conditions on `Feature.releaseId` are opposites, so the buckets cannot overlap —
 * that is what makes them "mutually exclusive" without a second de-duplication pass. One
 * Feature can still be Direct for Release A and Derived for Release B, which is the SRS's
 * own worked example.
 */
export function bucketFeatures<F extends ReleaseFeature>(
  features: readonly F[],
  children: readonly ReleaseChild[],
  releaseId: string,
  scope: TeamScope,
): FeatureBuckets<F> {
  const scopedChildrenByFeature = new Map<string, ReleaseChild[]>();
  for (const child of children) {
    if (child.featureId === null) continue;
    if (child.releaseId !== releaseId) continue;
    if (!inScope(child.teamId, scope)) continue;
    const list = scopedChildrenByFeature.get(child.featureId);
    if (list) list.push(child);
    else scopedChildrenByFeature.set(child.featureId, [child]);
  }

  const direct: F[] = [];
  const derived: F[] = [];
  const derivedCause = new Map<string, ReleaseChild[]>();

  for (const feature of features) {
    if (feature.releaseId === releaseId) {
      if (inScope(feature.teamId, scope)) direct.push(feature);
      continue;
    }
    const cause = scopedChildrenByFeature.get(feature.id);
    if (cause && cause.length > 0) {
      derived.push(feature);
      derivedCause.set(feature.id, cause);
    }
  }

  return { direct, derived, derivedCause };
}

/**
 * `Unparented User Stories and Defects` (RT-BR-04): release matches, Team in scope, and no
 * Feature parent.
 *
 * Scoped to its OWN release on purpose — RT-Q-01's superseded wording had these appearing
 * under every Release filter.
 */
export function unparentedItems(
  children: readonly ReleaseChild[],
  releaseId: string,
  scope: TeamScope,
): ReleaseChild[] {
  return dedupe(
    children.filter(
      (c) => c.featureId === null && c.releaseId === releaseId && inScope(c.teamId, scope),
    ),
  );
}

// ── Search and sort over the active bucket ──────────────────────────────────

/**
 * The columns the list may be sorted on (§246, RT-AC-05 + the `name` divergence).
 *
 * `Rank`, `ID` and `Team` are the SRS's three; `name` is the declared agile-ALM-parity addition
 * (`P6-RT-5`, decided 2026-08-04 — Rally sorts its Features List on Rank, ID and Name). Anything
 * else is ignored by `parseSort`, which falls the request back to the bucket's own rank order
 * rather than 400-ing on a column a future grid might offer.
 */
export const RELEASE_TRACKING_SORT_FIELDS = ['rank', 'id', 'team', 'name'] as const;
export type ReleaseTrackingSortField = (typeof RELEASE_TRACKING_SORT_FIELDS)[number];

/**
 * The four values search and sort are applied over, for one bucket entry.
 *
 * Deliberately NOT the assembled `ReleaseTrackingRow`: a Direct row's Status, mismatches and
 * progress are computed over every one of its children, so building the whole bucket's rows to
 * sort them would undo the paging this endpoint exists to provide. The caller assembles rows for
 * the page slice only.
 */
export interface BucketSortKeys {
  /**
   * The 1-based position in the bucket's OWN rank order, assigned BEFORE search and sort.
   *
   * That is what makes `Rank` mean something: §247 numbers rows "inside the active bucket", so a
   * row's rank is a property of the bucket and not of the current view. Sorting by ID therefore
   * shows the bucket's ranks out of order (which is the point of having the column), sorting by
   * Rank shows a strict sequence, and a search shows the matching rows' real positions rather than
   * renumbering them 1, 2, 3 and claiming a row is first in a bucket it sits 57th in.
   */
  rank: number;
  itemKey: string;
  name: string;
  /** What the Team column prints, joined for a Derived row's several cause teams. `''` for none. */
  teamLabel: string;
}

/**
 * Case- and accent-insensitive, digit-aware ordering.
 *
 * `numeric: true` because every sortable string here is a KEY or a name with numbers in it, and
 * `'FE-10' < 'FE-2'` under a plain code-unit comparison — sorting `ID` descending would put FE-9
 * above FE-10 and read as a broken column rather than a lexicographic one.
 */
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * Search and sort the ACTIVE bucket — the whole bucket, not the page (§259: "Search applies
 * within the active bucket"; RT-AC-05: "Rank, ID and Team sort both directions").
 *
 * Both used to run in the browser over the 25 rows that had arrived, so `ID ▼` sorted the page
 * rather than the bucket while the header's caret said otherwise. They run here, after
 * classification and before the caller's slice: classification already needs the whole population
 * (a Derived Feature is by definition one OUTSIDE the release, so it cannot be found by a
 * `WHERE release_id = …`), which is why this costs no extra query.
 *
 * The search term matches the row's KEY or its name, the two identifiers the grid prints. The
 * three summary counts are NOT filtered by it — they are the buckets' populations and §5.1 keeps
 * all three visible — but the page total is, so paging walks the matches.
 *
 * Every comparison falls back to `rank` ascending, so the order is total: a sort on a column where
 * many rows tie (Team, most of all) would otherwise be free to reshuffle between two page
 * requests and drop or repeat rows at the boundary.
 */
export function refineBucket<T extends BucketSortKeys>(
  entries: readonly T[],
  opts: {
    q?: string | null;
    sort?: { sortBy: ReleaseTrackingSortField; sortDirection: 'asc' | 'desc' } | null;
  },
): T[] {
  const term = (opts.q ?? '').trim().toLowerCase();
  const matched = term
    ? entries.filter(
        (e) => e.name.toLowerCase().includes(term) || e.itemKey.toLowerCase().includes(term),
      )
    : [...entries];

  const sort = opts.sort;
  if (!sort || sort.sortBy === 'rank') {
    return sort?.sortDirection === 'desc' ? matched.sort((a, b) => b.rank - a.rank) : matched;
  }

  const direction = sort.sortDirection === 'desc' ? -1 : 1;
  const key = (e: T): string =>
    sort.sortBy === 'id' ? e.itemKey : sort.sortBy === 'name' ? e.name : e.teamLabel;
  return matched.sort((a, b) => {
    const primary = collator.compare(key(a), key(b)) * direction;
    return primary !== 0 ? primary : a.rank - b.rank;
  });
}

// ── Status cells ────────────────────────────────────────────────────────────

export interface StatusValue {
  accepted: number;
  total: number;
  /** Floored percent, or null when the denominator is zero. Derived rows have no percent. */
  percent: number | null;
}

const measure = (items: readonly ReleaseChild[], unit: ChartUnit): number =>
  unit === 'points'
    ? roundForDisplay(items.reduce((sum, i) => sum + (i.planEstimate ?? 0), 0))
    : items.length;

/**
 * A DIRECT Feature's Status uses EVERY direct child — including children assigned to
 * another Release or to none (RT-BR-05). The cell shows the floored percentage plus
 * `accepted/total`.
 *
 * `Math.floor`, not rounding: 99.6% must not display as 100% while work is outstanding.
 */
export function directStatus(children: readonly ReleaseChild[], unit: ChartUnit): StatusValue {
  const all = dedupe(children);
  const total = measure(all, unit);
  const accepted = measure(
    all.filter((c) => c.acceptedEquivalent),
    unit,
  );
  return { accepted, total, percent: total > 0 ? Math.floor((accepted / total) * 100) : null };
}

/**
 * A DERIVED Feature's Status uses ONLY the children whose Release matches and whose Team
 * is in scope, and shows `accepted/total` with NO percentage (RT-BR-05).
 *
 * No percentage because the denominator is a slice of the Feature, not the Feature: a
 * percentage would invite reading it as the Feature's progress, which is what the Direct
 * cell means.
 */
export function derivedStatus(
  scopedChildren: readonly ReleaseChild[],
  unit: ChartUnit,
): StatusValue {
  const all = dedupe(scopedChildren);
  return {
    accepted: measure(
      all.filter((c) => c.acceptedEquivalent),
      unit,
    ),
    total: measure(all, unit),
    percent: null,
  };
}

// ── Release totals and the tracked population ───────────────────────────────

/**
 * `TrackedLeaves(R, S)` — the ONE population behind Planned, Accepted and the Burnup
 * (RT §4.1): distinct Story/Defect with `releaseId = R` whose Team is in scope.
 *
 * Features are never counted as Release work items, and neither are Tasks: Plan Estimate
 * and release classification are owned by Story/Defect in this model.
 */
export function trackedLeaves(
  children: readonly ReleaseChild[],
  releaseId: string,
  scope: TeamScope,
): ReleaseChild[] {
  return dedupe(children.filter((c) => c.releaseId === releaseId && inScope(c.teamId, scope)));
}

export interface ReleaseTotals {
  planned: number;
  accepted: number;
  preliminary: number;
}

/**
 * Planned (RT-BR-06), Accepted (RT-BR-07) and Preliminary (RT-BR-08) in the selected unit.
 *
 * Accepted admits {Accepted, Release} only. `Completed` contributes to Planned but not to
 * Accepted — the distinction the whole report turns on.
 */
export function releaseTotals(
  leaves: readonly ReleaseChild[],
  featuresInRelease: readonly ReleaseFeature[],
  unit: ChartUnit,
): ReleaseTotals {
  return {
    planned: measure(leaves, unit),
    accepted: measure(
      leaves.filter((c) => c.acceptedEquivalent),
      unit,
    ),
    preliminary: preliminaryTotal(featuresInRelease, unit),
  };
}

/**
 * The Preliminary Estimate line: the sum of the TOP-DOWN Feature estimate over the Direct
 * and Derived Features, de-duplicated by Feature id.
 *
 * Tier order matches the portfolio module's existing `resolveEstimate`: the refined
 * forecast when it is greater than zero, otherwise the workspace's Preliminary Estimate
 * size mapping. Since migration 0079 the refined columns are NOT NULL DEFAULT 0, so 0 is
 * the single representation of "not forecast" and falls through to the mapping.
 *
 * This is a planning reference line, never the denominator of Feature progress.
 */
export function preliminaryTotal(features: readonly ReleaseFeature[], unit: ChartUnit): number {
  const seen = new Set<string>();
  let total = 0;
  for (const feature of features) {
    if (seen.has(feature.id)) continue;
    seen.add(feature.id);
    total +=
      unit === 'points'
        ? feature.refinedPoints > 0
          ? feature.refinedPoints
          : feature.preliminaryPoints
        : feature.refinedCount > 0
          ? feature.refinedCount
          : feature.preliminaryCount;
  }
  return roundForDisplay(total);
}

// ── Issues ──────────────────────────────────────────────────────────────────

export interface ReleaseMismatch {
  childId: string;
  childKey: string;
  childTitle: string;
  childType: 'story' | 'defect';
  /** The Release the child actually points at. Never null — an unassigned child is not a mismatch. */
  itemReleaseId: string;
  itemReleaseName: string | null;
}

/**
 * Release-mismatch issues for a Direct Feature (RT §5).
 *
 * "A Direct Feature displays an Issue warning when at least one direct child has a
 * non-null `releaseId` different from the selected Release. An unassigned child does not
 * trigger the warning." An unassigned child is not ready for Release Tracking (RT-BR-03),
 * which is a planning gap rather than a contradiction.
 */
export function releaseMismatches(
  children: readonly ReleaseChild[],
  releaseId: string,
): ReleaseMismatch[] {
  return dedupe(children)
    .filter((c) => c.releaseId !== null && c.releaseId !== releaseId)
    .map((c) => ({
      childId: c.id,
      childKey: c.itemKey,
      childTitle: c.title,
      childType: c.type,
      itemReleaseId: c.releaseId as string,
      itemReleaseName: c.releaseName,
    }));
}

/**
 * Does EVERY release-assigned child point somewhere else?
 *
 * Warned separately because it means something different: the Feature's own `releaseId`
 * is probably stale or plain wrong, rather than a few children having drifted. Independent
 * of `% Done` — a Feature can be 100% accepted and still fully mismatched (example 8).
 */
export function isFullMismatch(children: readonly ReleaseChild[], releaseId: string): boolean {
  const assigned = dedupe(children).filter((c) => c.releaseId !== null);
  return assigned.length > 0 && assigned.every((c) => c.releaseId !== releaseId);
}

/**
 * The Issues panel's progress lines: total points, Story only, Defect only.
 *
 * Calculated from ALL direct children and independent of mismatch classification (§5).
 * The approved mockup shows two lines (total points and defects); the SRS asks for Story
 * progress as well, so all three are returned and the mockup's omission is treated as the
 * fixture gap it is.
 */
export function featureProgress(children: readonly ReleaseChild[]): {
  points: StatusValue;
  stories: StatusValue;
  defects: StatusValue;
} {
  const all = dedupe(children);
  return {
    points: directStatus(all, 'points'),
    stories: directStatus(
      all.filter((c) => c.type === 'story'),
      'count',
    ),
    defects: directStatus(
      all.filter((c) => c.type === 'defect'),
      'count',
    ),
  };
}

// ── Burnup ──────────────────────────────────────────────────────────────────

/**
 * What the burnup's SNAPSHOT history looks like (RT-BR-09, §5.1).
 *
 * Says nothing about the Ideal target, for the same reason `BurndownHistoryState` does not:
 * whether a target exists and whether the days were measured are different questions, and
 * `no-baseline` used to be reachable ONLY when nothing was measured — so a release with
 * history but no target reported `partial` and the client could not tell why every `ideal`
 * came back null. `idealTarget` on the result answers that directly.
 */
export type BurnupHistoryState = 'complete' | 'partial' | 'missing' | 'no-window';

export interface BurnupPoint {
  date: string;
  accepted: number | null;
  planned: number | null;
  preliminary: number | null;
  /** The straight trajectory from 0 at Release start to the approved target at end. */
  ideal: number | null;
}

export interface StoredBurnupRow {
  date: string;
  accepted: number;
  planned: number;
  preliminary: number;
}

/**
 * Assemble the four series from stored snapshots plus the persisted Ideal target.
 *
 * The mockup generates its curves from today's totals; RT-BR-09 forbids that
 * ("The current data model contains only present-state records and cannot reconstruct a
 * trustworthy historical burnup"), so measured days come from snapshots and days with no
 * snapshot are emitted as `null` — a visible gap, not a zero.
 *
 * `Ideal` is drawn from the PERSISTED baseline only. With no baseline there is no ideal
 * trajectory, and inventing one from today's mutable Planned value would silently redraw
 * history every time scope changed.
 */
export function buildBurnup(input: {
  /** Every calendar date in the release window, ascending. */
  axis: readonly string[];
  idealTarget: number | null;
  snapshots: readonly StoredBurnupRow[];
}): {
  points: BurnupPoint[];
  historyState: BurnupHistoryState;
  /** Echoed so a client can say WHY every `ideal` is null: no target, versus no snapshot. */
  idealTarget: number | null;
} {
  const byDate = new Map(input.snapshots.map((s) => [s.date, s]));
  const last = input.axis.length - 1;

  const points: BurnupPoint[] = input.axis.map((date, i) => {
    const snap = byDate.get(date);
    return {
      date,
      accepted: snap ? roundForDisplay(snap.accepted) : null,
      planned: snap ? roundForDisplay(snap.planned) : null,
      preliminary: snap ? roundForDisplay(snap.preliminary) : null,
      ideal:
        input.idealTarget === null
          ? null
          : last <= 0
            ? roundForDisplay(input.idealTarget)
            : roundForDisplay((input.idealTarget * i) / last),
    };
  });

  const measured = points.filter((p) => p.accepted !== null).length;
  const historyState: BurnupHistoryState =
    input.axis.length === 0
      ? 'no-window'
      : measured === 0
        ? 'missing'
        : measured === input.axis.length
          ? 'complete'
          : 'partial';

  return { points, historyState, idealTarget: input.idealTarget };
}

// ── shared ──────────────────────────────────────────────────────────────────

/**
 * De-duplicate by stable id.
 *
 * Applied at every aggregation boundary because an All Teams query reaches the same work
 * item through more than one join path, and "Aggregation must de-duplicate by stable Work
 * Item or Task ID" is a data-quality rule, not an optimisation.
 */
function dedupe(items: readonly ReleaseChild[]): ReleaseChild[] {
  const seen = new Set<string>();
  const out: ReleaseChild[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}
