/**
 * Delivery health — "is this on track?", derived from progress against a planned
 * window. Pure: no IO, no dates from the environment, no defaults hidden inside.
 *
 * WHY THIS IS NOT A STATUS ENUM
 *
 * The app already colours *state*: a stored value maps to a badge
 * (`milestone.status = 'at_risk'` → amber, `SCHEDULE_STATE_CONFIG` for work items).
 * Health is the second, computed indicator that sits beside those — it answers a
 * question no stored field can, namely whether the accepted work so far is keeping
 * pace with the time elapsed. A Feature at 50% is fine in week one and late in the
 * final week; only this function can tell them apart.
 *
 * WHY THRESHOLDS ARE A PARAMETER
 *
 * Rally deliberately uses a different scheme per surface — Portfolio Items warn at
 * 20%/40% behind the required acceptance rate, Release Tracking uses ≥90% Good /
 * 70–89% At Risk / <70% Critical, and Milestone Delivery Confidence is a third
 * scheme again. Hard-coding one set here would mean a second copy of this algorithm
 * the first time another surface adopts it. Callers pass their own thresholds; only
 * Portfolio Items is wired in Phase 5.
 */

/** Health verdict, ordered from best to worst. */
export type HealthState = 'complete' | 'on_track' | 'at_risk' | 'late' | 'not_started';

export interface HealthThresholds {
  /** Percentage points behind the required rate at which health becomes `at_risk`. */
  atRiskPctBehind: number;
  /** Percentage points behind at which health becomes `late`. Must exceed atRisk. */
  latePctBehind: number;
}

/**
 * Portfolio Items thresholds, matching Rally: at risk from 20% behind the required
 * acceptance rate, late from 40% behind.
 */
export const PORTFOLIO_HEALTH_THRESHOLDS: HealthThresholds = {
  atRiskPctBehind: 20,
  latePctBehind: 40,
};

export interface HealthInput {
  /** Accepted amount so far — points or item count, matching `total`. */
  accepted: number;
  /** Total amount in scope, in the same unit as `accepted`. */
  total: number;
  /** Planned start. `null` when not set — Rally allows a portfolio item with no dates. */
  start: Date | null;
  /** Planned end. `null` when not set. */
  end: Date | null;
  /** Evaluation date, always injected so this stays pure and testable. */
  today: Date;
  thresholds: HealthThresholds;
}

export interface HealthResult {
  state: HealthState;
  /** Fraction of work accepted, 0–1. `null` when `total` is 0 (nothing to be done). */
  percentDone: number | null;
  /**
   * Fraction of the planned window elapsed, 0–1, clamped. `null` when health could
   * not be evaluated — no dates, or a window with no duration.
   */
  percentElapsed: number | null;
  /**
   * Why the verdict could not be computed, for the "missing estimates or dates"
   * warning Rally shows in its hover callout. `null` when health was evaluated.
   */
  indeterminate: 'no_dates' | 'no_work' | null;
}

const MS_PER_DAY = 86_400_000;

/** Whole days between two dates, ignoring time-of-day. */
function daysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return (b - a) / MS_PER_DAY;
}

/**
 * Compare progress against the planned window.
 *
 * Reads as: by the time X% of the window has passed, roughly X% of the work should
 * be accepted. Falling `atRiskPctBehind` points short of that is At Risk; falling
 * `latePctBehind` short is Late.
 *
 * Degenerate inputs return `not_started` with `indeterminate` set rather than
 * throwing or guessing, because every one of them is reachable from real data:
 * a Feature with no children, or with no planned dates, is legitimate.
 */
export function computeHealth(input: HealthInput): HealthResult {
  const { accepted, total, start, end, today, thresholds } = input;

  const percentDone = total > 0 ? clamp01(accepted / total) : null;

  // Nothing to deliver — not a health problem, and dividing by zero would invent one.
  if (total <= 0) {
    return { state: 'not_started', percentDone, percentElapsed: null, indeterminate: 'no_work' };
  }

  const isDone = percentDone !== null && percentDone >= 1;

  // No window means no required rate. Rally shows these as gray and warns about the
  // missing dates rather than assuming a schedule — including when the work is finished,
  // because Rally's blue is defined in terms of the Planned End Date.
  if (start === null || end === null) {
    return { state: 'not_started', percentDone, percentElapsed: null, indeterminate: 'no_dates' };
  }

  /**
   * Complete = Rally's BLUE, which requires BOTH conditions:
   * "current date is after the Planned End Date and the artifacts in the portfolio item
   * are 100% done" (Broadcom TechDocs, "Using the Portfolio Items Page").
   *
   * So finishing EARLY does not turn the item blue — it stays green (on track, indeed
   * ahead) until the planned end passes. This function previously reported `complete` on
   * 100% alone, which read more intuitively but disagreed with Rally; parity won.
   */
  if (isDone && daysBetween(end, today) > 0) {
    return { state: 'complete', percentDone, percentElapsed: 1, indeterminate: null };
  }

  const windowDays = daysBetween(start, end);
  if (windowDays <= 0) {
    // A zero- or negative-length window has no meaningful rate. Treated as missing
    // dates rather than instantly late, which would punish a data-entry slip.
    return { state: 'not_started', percentDone, percentElapsed: null, indeterminate: 'no_dates' };
  }

  const elapsedDays = daysBetween(start, today);

  // Before the start date: gray, matching Rally's "future start date" case.
  if (elapsedDays < 0) {
    return { state: 'not_started', percentDone, percentElapsed: 0, indeterminate: null };
  }

  const percentElapsed = clamp01(elapsedDays / windowDays);

  // Behind is measured in PERCENTAGE POINTS, not as a ratio, so the thresholds read
  // the way Rally states them ("20% below the required rate").
  const pctBehind = (percentElapsed - (percentDone ?? 0)) * 100;

  if (pctBehind >= thresholds.latePctBehind) {
    return { state: 'late', percentDone, percentElapsed, indeterminate: null };
  }
  if (pctBehind >= thresholds.atRiskPctBehind) {
    return { state: 'at_risk', percentDone, percentElapsed, indeterminate: null };
  }
  return { state: 'on_track', percentDone, percentElapsed, indeterminate: null };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
