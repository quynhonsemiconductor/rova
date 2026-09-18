import type { BurndownHistoryState, BurndownPoint, SplitMarker } from './burndown';
import type {
  BurnupHistoryState,
  BurnupPoint,
  ChartUnit,
  ReleaseBucket,
  ReleaseMismatch,
  StatusValue,
} from './release-tracking';
import type { TeamCapacityHours } from './team-capacity';
import type { VelocityAverages, VelocityBar, VelocityWindow } from './velocity';

/**
 * The read contracts the four Phase 6 surfaces return.
 *
 * Every one carries an explicit state for "there is nothing to show" or "this history is
 * not trustworthy yet", because the cross-report contract §6.7 makes that a requirement
 * rather than a nicety: "Empty or unavailable data must produce an explicit
 * empty/data-unavailable state, not a zero that could be mistaken for measured
 * performance."
 */

/** Echoed on every response so the UI can title itself without a second lookup. */
export interface ReportContext {
  projectId: string;
  projectName: string;
  /** Null when the scope is All Teams. */
  teamId: string | null;
  teamName: string | null;
  timeZone: string;
}

export interface ReportTimebox {
  /** The iteration actually selected in the picker. */
  iterationId: string;
  /** The shared timebox All Teams fuses on. Null for a dateless iteration. */
  timeboxGroupId: string | null;
  name: string;
  startDate: string | null;
  endDate: string | null;
  /** How many Team iterations this timebox fused. 1 for a selected Team. */
  iterationCount: number;
}

// ── Iteration Burndown ──────────────────────────────────────────────────────

export interface IterationBurndownReport {
  context: ReportContext;
  timebox: ReportTimebox;
  points: BurndownPoint[];
  /** The frozen Ideal baseline in hours, or null when none was captured. */
  totalTaskEstimateAtStart: number | null;
  historyState: BurndownHistoryState;
  status: 'on-track' | 'behind-plan' | 'unknown';
  latestSnapshotDate: string | null;
  /** Plotted days whose value was not captured at the end of that local day (IB-BR-01). */
  partialCaptureDates: string[];
  /**
   * Whether any Story/Defect is assigned at all. Distinguishes "no scheduled work" from
   * "work exists but the snapshot job has not run for it" — IB §7 requires the empty state
   * to tell those apart.
   */
  hasScheduledWork: boolean;
  /**
   * `SPLIT OUT` — work that LEFT this timebox (SRS §10.2). Empty when no Split touched it.
   *
   * The points behind these markers are deliberately absent from `points[].acceptedPoints`: the
   * `[Unfinished]` placeholder is `accepted` but is excluded from the delivered sum (AC3), and this
   * array is where it stays visible.
   */
  splitOut: SplitMarker[];
  /** `CARRY IN` — work that ARRIVED in this timebox from an earlier one (SRS §10.3). */
  carryIn: SplitMarker[];
}

// ── Velocity ────────────────────────────────────────────────────────────────

export interface VelocityReport {
  context: ReportContext;
  window: VelocityWindow;
  /** Oldest first, matching the chart's left-to-right order. */
  bars: VelocityBar[];
  averages: VelocityAverages;
  /**
   * Accepted items carrying no `acceptedDate`, across the whole window. A data-quality gap
   * the UI must surface rather than absorb: their points are in no segment and in no
   * average.
   */
  unclassifiedItems: number;
}

// ── Team Capacity ───────────────────────────────────────────────────────────

export interface TeamCapacityTeam {
  /** Null for the synthetic `No Team` group. */
  id: string | null;
  name: string;
  /**
   * The Team is archived, and its hours are reported anyway.
   *
   * Archiving a Team does not delete its linked Work Item/Sprint history (DB design §488), so
   * dropping these rows would shrink a total for a reason the reader cannot see. The row is marked
   * instead, because the global Team picker hides archived teams — nothing else on the screen says
   * that this team no longer exists.
   */
  archived: boolean;
  totals: TeamCapacityHours;
  members: Array<{ id: string | null; name: string; hours: TeamCapacityHours }>;
}

export interface TeamCapacityReport {
  context: ReportContext;
  timebox: ReportTimebox;
  totals: TeamCapacityHours;
  teams: TeamCapacityTeam[];
  /** The two absences the empty state has to tell apart (Team Capacity SRS §6). */
  hasCapacity: boolean;
  hasTaskHours: boolean;
}

// ── Release Tracking ────────────────────────────────────────────────────────

export interface ReleaseTrackingRow {
  /**
   * The row's 1-based position in the active bucket's own rank order (RT-AC-04) — NOT the stored
   * lexorank, and NOT its position in the current view.
   *
   * Assigned before `q` and `sort` are applied, because §247 numbers rows "inside the active
   * bucket": under `ID ▼` these therefore appear out of sequence (which is what a rank column is
   * for), and a search shows each match's real position rather than renumbering it 1.
   */
  rank: number;
  id: string;
  itemKey: string;
  name: string;
  /**
   * Feature Team for Direct, the scoped child Team(s) that caused inclusion for Derived,
   * the item's own Team for Unparented (§5).
   */
  teams: Array<{ id: string | null; name: string }>;
  /** `story` / `defect` for an Unparented row, `feature` otherwise. */
  issueType: 'feature' | 'story' | 'defect';
  state: string;
  childCount: number;
  status: StatusValue;
  /** Release-mismatch children. Empty for Derived and Unparented rows. */
  mismatches: ReleaseMismatch[];
  /** Every release-assigned child points elsewhere — warned separately (RT-AC-11). */
  fullMismatch: boolean;
  /** Panel context: the Feature's planned window. Null on an Unparented row. */
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  /** Panel progress lines, from ALL direct children. Null on an Unparented row. */
  progress: { points: StatusValue; stories: StatusValue; defects: StatusValue } | null;
}

export interface ReleaseTrackingReport {
  context: ReportContext;
  release: {
    id: string;
    name: string;
    startDate: string | null;
    releaseDate: string | null;
  };
  unit: ChartUnit;
  bucket: ReleaseBucket;
  /** All three totals stay visible even when the active bucket is empty (§5.1). */
  summary: { direct: number; derived: number; unparented: number };
  /** The requested page of the ACTIVE bucket — not the whole bucket. See {@link page}. */
  rows: ReleaseTrackingRow[];
  /**
   * Which slice of the active bucket `rows` is.
   *
   * `total` is how many rows of the active bucket MATCH the request — the bucket's whole
   * population, and so exactly `summary[bucket]`, whenever no `q` is given. It is separate from
   * `summary` precisely because a search narrows what is paged through without touching the three
   * bucket counts §5.1 keeps visible. Classification, `summary` and `totals` are all measured over
   * the full population before search, sort or this slice — those change which rows travel and in
   * what order, never a number above them.
   */
  page: { page: number; pageSize: number; total: number; pageCount: number };
  totals: { planned: number; accepted: number; preliminary: number };
}

export interface ReleaseBurnupReport {
  unit: ChartUnit;
  points: BurnupPoint[];
  historyState: BurnupHistoryState;
  /** Null when no Ideal target is stored, which is why every point's `ideal` would be null. */
  idealTarget: number | null;
  /** The iteration band under the x-axis: timeboxes the release window crosses (§4.1). */
  iterations: Array<{ id: string; name: string; startDate: string | null; endDate: string | null }>;
}
