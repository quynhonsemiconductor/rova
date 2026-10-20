import { roundForDisplay } from './report-scope';

/**
 * Velocity classification and averages (Velocity SRS §3 and §5).
 *
 * Velocity is deliberately NOT snapshotted: it is recalculated from the CURRENT iteration
 * assignment, the current accepted-equivalent state and the persisted `acceptedDate`
 * every time it is asked for. Moving an item out of a closed iteration removes it from
 * that bar; moving one in adds it. That is the opposite of Burndown and is why the two
 * reports cannot share a data path.
 */

/** One currently-assigned Story or Defect, as the classifier needs it. */
export interface VelocityItem {
  /** Stable work item id — the de-duplication key for All Teams. */
  id: string;
  /** `story_points`, the BA's Plan Estimate. Null counts as zero points, not excluded. */
  planEstimate: number | null;
  /** True when schedule_state ∈ {accepted, release}. */
  acceptedEquivalent: boolean;
  /** The persisted acceptance timestamp. Null while not accepted. */
  acceptedDate: Date | null;
  /**
   * `work_items.split_id is not null` — this Story IS a Split's `[Unfinished]` historical
   * placeholder (Phase 7 plan D6), so its points are carried-over history and never delivery.
   *
   * It is the FLAG and not the split id: the classifier asks one yes/no question of the row, and
   * which Split produced it is the Split banner's business, not Velocity's.
   */
  splitCarryover: boolean;
}

export type VelocitySegment =
  'during' | 'after' | 'not-accepted' | 'unclassified' | 'split-carryover';

/**
 * Which of the mutually exclusive segments an item's points belong to.
 *
 * `unclassified` is the outcome the SRS forces us to model: an item that IS
 * accepted-equivalent but has no `acceptedDate`. "An Accepted/Release item without
 * `acceptedDate` is a data-quality error. DEV must backfill it from auditable history;
 * the report must not guess whether it was accepted during or after the Iteration."
 * Guessing either way would misstate velocity, so it is surfaced instead.
 *
 * `split-carryover` is decided FIRST, and the order is load-bearing rather than stylistic
 * (Phase 7 SU-09 9.1). A Split's `[Unfinished]` placeholder is written `accepted` with a real
 * `accepted_date` equal to the Split timestamp (SU-BR-09) — which is inside the source
 * iteration's window — so every later branch would classify it `during` and the source sprint
 * would appear to have delivered exactly the points it carried forward. This is declared
 * divergence #4 in the Phase 7 plan: the ONE deliberate exception to the Phase 6 rule that
 * `accepted` + `accepted_date` means delivered.
 */
export function classify(item: VelocityItem, iterationEndBoundary: Date): VelocitySegment {
  if (item.splitCarryover) return 'split-carryover';
  if (!item.acceptedEquivalent) return 'not-accepted';
  if (item.acceptedDate === null) return 'unclassified';
  return item.acceptedDate.getTime() <= iterationEndBoundary.getTime() ? 'during' : 'after';
}

export interface VelocityBar {
  /** The shared timebox this bar aggregates (one iteration, or N fused Team iterations). */
  timeboxKey: string;
  /** Display label — the timebox name, never a join key. */
  name: string;
  startDate: string | null;
  endDate: string | null;
  acceptedDuring: number;
  acceptedAfter: number;
  notAccepted: number;
  /**
   * Points that could not be classified because an accepted item has no acceptedDate.
   * Excluded from the three segments so the stack cannot silently absorb them, and
   * reported so the gap is visible.
   */
  unclassified: number;
  /** Count of items behind `unclassified`, for the UI's data-quality warning. */
  unclassifiedItems: number;
  /**
   * Points belonging to Split/Carryover placeholders — rendered as its own EXCLUDED segment and in
   * no average (Phase 7 SU-09, SRS §10.4).
   *
   * Not folded into `acceptedDuring`: the work is real and it is visible in this sprint, so hiding
   * the segment would make the bar shorter with nothing on screen to say why — the same argument
   * `unclassified` is surfaced for. It is simply not DELIVERY.
   */
  splitCarryover: number;
  /**
   * The work item ids behind `splitCarryover`, de-duplicated, in first-seen order.
   *
   * Ids rather than a count, because the excluded population has to be IDENTIFIABLE: "which stories
   * were left out of this bar" is a question a reader auditing a sprint asks, and a bare number
   * cannot answer it. The count is `splitStoryIds.length`, so there is no second field to keep in
   * step with the sum.
   */
  splitStoryIds: string[];
  /** How many Team iterations were fused. 1 for a selected Team. */
  iterationCount: number;
}

/**
 * Split one timebox's currently-assigned items into the stacked segments.
 *
 * De-duplicates by work item id first: for All Teams the same item can be reached through
 * more than one Team's iteration join, and counting it twice would inflate the bar
 * (§2 "de-duplicate Work Items by ID").
 *
 * Invariant (§3, as amended by Phase 7 §8 Q7): during + after + notAccepted + unclassified +
 * splitCarryover equals the sum of every distinct assigned item's plan estimate. `unclassified`
 * and `splitCarryover` are part of the identity on purpose — dropping either would break the
 * invariant, and the five-way form is the one that holds in the presence of a data-quality row,
 * which the four-way form the SRS states does not.
 */
export function buildBar(input: {
  timeboxKey: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  endBoundary: Date;
  iterationCount: number;
  items: readonly VelocityItem[];
}): VelocityBar {
  const seen = new Set<string>();
  let during = 0;
  let after = 0;
  let notAccepted = 0;
  let unclassified = 0;
  let unclassifiedItems = 0;
  let splitCarryover = 0;
  const splitStoryIds: string[] = [];

  for (const item of input.items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const points = item.planEstimate ?? 0;
    switch (classify(item, input.endBoundary)) {
      case 'during':
        during += points;
        break;
      case 'after':
        after += points;
        break;
      case 'not-accepted':
        notAccepted += points;
        break;
      case 'unclassified':
        unclassified += points;
        unclassifiedItems += 1;
        break;
      case 'split-carryover':
        splitCarryover += points;
        // Pushed inside the de-duplication guard, so the list and the sum count the same rows.
        splitStoryIds.push(item.id);
        break;
    }
  }

  return {
    timeboxKey: input.timeboxKey,
    name: input.name,
    startDate: input.startDate,
    endDate: input.endDate,
    acceptedDuring: roundForDisplay(during),
    acceptedAfter: roundForDisplay(after),
    notAccepted: roundForDisplay(notAccepted),
    unclassified: roundForDisplay(unclassified),
    unclassifiedItems,
    splitCarryover: roundForDisplay(splitCarryover),
    splitStoryIds,
    iterationCount: input.iterationCount,
  };
}

export interface VelocityAverages {
  /** AVG of every During value in the window — the flat Trend line. */
  trend: number | null;
  last3: number | null;
  best3: number | null;
  worst3: number | null;
  /**
   * How many values each average actually used. "If fewer than three eligible Iterations
   * exist, Last/Best/Worst use all available values and the UI must expose the actual
   * sample size."
   */
  sampleSize: number;
}

/**
 * Trend and the three averages, from `acceptedDuring` ONLY.
 *
 * "`acceptedAfter` and `notAccepted` are visual context and are excluded from every
 * trend/average calculation." Work accepted late did not happen in that iteration, so
 * counting it would make a chronically late team look fast.
 *
 * UNCHANGED BY PHASE 7 SU-09, and deliberately so: reading `acceptedDuring` alone means
 * `unclassified` and `splitCarryover` are out of Trend / Last 3 / Best 3 / Worst 3 for free (AC3).
 * That is asserted rather than trusted — `velocity.spec.ts` compares the averages of the same
 * bars with and without a placeholder present, because "for free" is exactly the kind of claim
 * that stops being true when someone adds a fifth term to the wrong sum.
 */
export function computeAverages(barsOldestFirst: readonly VelocityBar[]): VelocityAverages {
  const during = barsOldestFirst.map((b) => b.acceptedDuring);
  if (during.length === 0) {
    return { trend: null, last3: null, best3: null, worst3: null, sampleSize: 0 };
  }
  const avg = (xs: readonly number[]): number =>
    roundForDisplay(xs.reduce((a, b) => a + b, 0) / xs.length);
  const take = Math.min(3, during.length);
  const descending = [...during].sort((a, b) => b - a);
  const ascending = [...during].sort((a, b) => a - b);

  return {
    trend: avg(during),
    // "3 most recent" — the window is ordered oldest first, so the tail.
    last3: avg(during.slice(-take)),
    best3: avg(descending.slice(0, take)),
    worst3: avg(ascending.slice(0, take)),
    sampleSize: during.length,
  };
}

/** The two windows the report offers. */
export const VELOCITY_WINDOWS = [5, 10] as const;
export type VelocityWindow = (typeof VELOCITY_WINDOWS)[number];

/**
 * RALLY PARITY (differs from BA design)
 * Rally: the velocity chart plots "all accepted plan estimate units for each of the last 10
 * completed iterations", and its trend line is "the average accepted points in the last 10
 * iterations" — 10 is Rally's window, and Rally does not offer a choice.
 * https://techdocs.broadcom.com/us/en/ca-enterprise-software/valueops/rally/rally-help/reporting/rally-reports-and-charts.html
 * BA spec said: default Last 5 (Velocity SRS §6).
 * Decided 2026-08-04: Rally wins on the DEFAULT. See
 * 09_Gap_Audit/PHASE_5_6_DECISION_MATRIX.md#P6-R-4
 *
 * The 5-iteration option stays selectable: §6 asks for both windows and a shorter one is
 * genuinely useful for a team that has recently re-formed. Only which one opens changed —
 * a new team with 6 finished iterations now sees all of them rather than dropping the oldest,
 * and Trend / Last 3 / Best 3 / Worst 3 are averaged over Rally's population by default.
 */
export const DEFAULT_VELOCITY_WINDOW: VelocityWindow = 10;

/**
 * The most recent N eligible timeboxes, oldest first.
 *
 * "Sort eligible Iterations by end date ascending, then display the most recent 5 or 10."
 * Eligibility itself (ended before today, at least one Story/Defect assigned) is a query
 * concern — a timebox with no scheduled work never reaches this function.
 */
export function selectWindow<T extends { endDate: string | null }>(
  eligibleOldestFirst: readonly T[],
  window: VelocityWindow,
): T[] {
  return eligibleOldestFirst.slice(-window);
}
