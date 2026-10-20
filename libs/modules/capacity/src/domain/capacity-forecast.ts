/**
 * Rally's Capacity Forecast, as pure arithmetic.
 *
 * Rally: "This technique randomly samples up to 52 weeks of historical
 * throughput/velocity data 20,000 times to produce accurate capacity forecasts for a
 * selected team" (Broadcom TechDocs, "Rally Capacity Forecast"). It reports three lines —
 * Min is the amount delivered 85% of the time, Median 50%, Max 15% — and lets a planner
 * scale the result by team availability and by how well understood the work is.
 *
 * Why Monte Carlo rather than an average: an average answers "what usually happens" and a
 * planner needs "what can I commit to". A team averaging 30 points with a range of 10–50
 * cannot commit to 30, and the average alone cannot say that.
 *
 * ONE DIVERGENCE, deliberate. Rally samples WEEKLY buckets, because its tool also serves
 * Kanban teams with no timeboxes. We sample ITERATIONS:
 *   • nothing in this schema records WHEN a story was accepted — there is no `accepted_at`
 *     and no state-change history — so weekly acceptance totals are not derivable at all;
 *     an iteration's accepted sum is the finest-grained truth available.
 *   • an iteration is this product's planning cadence, so a forecast expressed in
 *     iterations is the one a planner can act on.
 * The trial count, the three percentiles, the availability multiplier and the complexity
 * adjustments all follow Rally exactly.
 */

/** One finished iteration's delivery for the team being forecast. */
export interface VelocitySample {
  iterationId: string;
  iterationName: string;
  /** Accepted points — ACCEPTED_SCHEDULE_STATES, i.e. signed off, not merely finished. */
  points: number;
  /** Accepted item count, for a plan measured in items rather than points. */
  count: number;
  /** Calendar length of the iteration, used to convert a window into a trial size. */
  days: number;
}

/**
 * How well understood the work is. Rally's five options and their exact adjustments —
 * "Well Understood - Easier than Normal" through "Many Unknowns - major concerns".
 */
export const FORECAST_COMPLEXITY = {
  well_understood: 10,
  typical: 0,
  minor_concerns: -10,
  major_concerns: -25,
  many_unknowns: -50,
} as const;

export type ForecastComplexity = keyof typeof FORECAST_COMPLEXITY;

/** Rally samples "up to 52 weeks" of history. */
export const FORECAST_HISTORY_DAYS = 364;

/** Rally runs 20,000 trials. */
export const FORECAST_TRIALS = 20_000;

/**
 * Rally "requires at least 14 days of data for the team to forecast a capacity, and if
 * your team has less than 14 days of data, a warning message indicates that a capacity
 * cannot be calculated". Sampling one short iteration 20,000 times would return that same
 * iteration dressed up as a distribution.
 */
export const FORECAST_MIN_HISTORY_DAYS = 14;

export interface ForecastInput {
  /** Finished iterations, newest or oldest first — order does not matter to sampling. */
  samples: readonly VelocitySample[];
  /**
   * A velocity the PLANNER supplied, per iteration, in the plan's unit — the BA's reading of
   * this feature: "It is a planner aid that proposes capacities from a supplied historic
   * velocity" (`02_Capacity_Planning/SRS.md:142`), with "velocity-driven AUTOMATIC capacity"
   * explicitly out of scope (SRS:418).
   *
   * When set it REPLACES the sampled history rather than adjusting it, so the number is the
   * planner's own and the minimum-history rule does not apply — a brand-new team with no
   * accepted iterations is exactly the case a supplied velocity exists for. Availability and
   * complexity still scale it, because those are statements about the window being planned
   * and not about where the velocity came from.
   */
  velocityPerIteration?: number | null;
  /**
   * How long one iteration runs, in days, when there is no history to average.
   *
   * Only consulted alongside a supplied velocity. Callers pass the project's real iteration
   * cadence; a guessed sprint length would turn "so many points per iteration" into a
   * different number of iterations than the team actually runs.
   */
  fallbackIterationDays?: number | null;
  /** Which number the plan is measured in. */
  unit: 'points' | 'count';
  /** Length of the window being planned, in days. */
  windowDays: number;
  /** 100 = the team as it has recently been; 200 if it doubled, 50 if it halved. */
  availabilityPct: number;
  complexity: ForecastComplexity;
  /**
   * Seed for the sampler.
   *
   * Deterministic on purpose: a planner who reruns a forecast on unchanged history must see
   * the same number, or the tool looks broken and the choice between two runs becomes
   * arbitrary. Callers derive it from the plan and team, so two teams still get independent
   * draws.
   */
  seed: number;
  /** Overridable only so tests can run a small number of trials quickly. */
  trials?: number;
}

export interface ForecastResult {
  /** Delivered 85% of the time — the conservative commitment. */
  min: number;
  /** Delivered 50% of the time. */
  median: number;
  /** Delivered 15% of the time — the optimistic case, not a target. */
  max: number;
  /** How many iterations the window was modelled as. */
  iterationsModelled: number;
  /** How many historical iterations fed the sampler. */
  samplesUsed: number;
  /** Total calendar days of history behind the forecast. */
  historyDays: number;
  /**
   * Where the velocity came from. A planner reading three identical lines needs to know it is
   * because THEY supplied one number, not because the sampler collapsed.
   */
  basis: 'history' | 'supplied';
  /**
   * Why no forecast was produced, or null. Reported rather than thrown: "not enough
   * history" is a normal state for a new team and the dialog explains it, it does not fail.
   *
   * `no_cadence` belongs to the supplied-velocity path alone: a velocity per iteration cannot
   * be extended over a window until something says how long an iteration is.
   */
  insufficientData: 'no_history' | 'too_little_history' | 'no_window' | 'no_cadence' | null;
}

/**
 * Deterministic PRNG (mulberry32).
 *
 * `Math.random()` cannot be used here: it would make every rerun disagree, and no test
 * could assert a percentile without stubbing a global.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The value at a percentile of a SORTED array, by nearest rank.
 *
 * Nearest-rank rather than interpolation: every trial total is a real sum of real
 * iterations, so a reported number stays something the team actually delivered in some
 * combination rather than an average of two outcomes.
 */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

/** Rounded to one decimal — a forecast implying more precision than its inputs is a lie. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function forecastCapacity(input: ForecastInput): ForecastResult {
  const historyDays = input.samples.reduce((sum, s) => sum + Math.max(0, s.days), 0);
  const supplied =
    input.velocityPerIteration !== null &&
    input.velocityPerIteration !== undefined &&
    input.velocityPerIteration > 0;
  const basis: ForecastResult['basis'] = supplied ? 'supplied' : 'history';
  const empty = (
    reason: NonNullable<ForecastResult['insufficientData']>,
    iterationsModelled = 0,
  ): ForecastResult => ({
    min: 0,
    median: 0,
    max: 0,
    iterationsModelled,
    samplesUsed: input.samples.length,
    historyDays,
    basis,
    insufficientData: reason,
  });

  // The history gates apply to the SAMPLED path only. A supplied velocity is the planner's
  // own number, so "the team has not delivered enough yet" is not a reason to withhold it —
  // that is the situation it exists for.
  if (!supplied) {
    if (input.samples.length === 0) return empty('no_history');
    if (historyDays < FORECAST_MIN_HISTORY_DAYS) return empty('too_little_history');
  }
  // A plan with no dates has no window to forecast INTO. Guessing one would put a number
  // on the screen that answers a question nobody asked.
  if (!(input.windowDays > 0)) return empty('no_window');

  /**
   * How many iterations the window is worth, from the team's own average cadence rather
   * than an assumed sprint length — a team on three-week iterations must not be modelled
   * as though it ran two-week ones.
   *
   * With a supplied velocity and no history at all, the caller's cadence stands in; with no
   * cadence either, the window cannot be expressed in iterations and there is nothing to
   * multiply, which is `no_cadence` rather than a fabricated two-week sprint.
   */
  const cadenceDays =
    input.samples.length > 0
      ? historyDays / input.samples.length
      : (input.fallbackIterationDays ?? 0) > 0
        ? (input.fallbackIterationDays as number)
        : 0;
  if (!(cadenceDays > 0)) return empty('no_cadence');
  const iterationsModelled = Math.max(1, Math.round(input.windowDays / cadenceDays));

  // A supplied velocity is ONE value, so every trial draws the same number and the three
  // lines agree. That is honest: the planner gave a point estimate, not a distribution, and
  // `basis: 'supplied'` is what tells the reader why there is no spread.
  const values = supplied
    ? [input.velocityPerIteration as number]
    : input.samples.map((s) => (input.unit === 'points' ? s.points : s.count));
  const rand = mulberry32(input.seed);
  const trials = input.trials ?? FORECAST_TRIALS;

  const totals = new Array<number>(trials);
  for (let trial = 0; trial < trials; trial += 1) {
    let sum = 0;
    // WITH replacement: each iteration of the plan window is an independent draw from the
    // team's history. Sampling without replacement would cap the window at the number of
    // iterations on record and quietly change the question.
    for (let i = 0; i < iterationsModelled; i += 1) {
      sum += values[Math.floor(rand() * values.length)];
    }
    totals[trial] = sum;
  }
  totals.sort((a, b) => a - b);

  // Rally's three lines. Delivered 85% of the time = the 15th percentile of outcomes, and
  // so on — the probability of ACHIEVING a number and the number's rank run opposite ways,
  // which is the easiest thing to get backwards here.
  const scale = (input.availabilityPct / 100) * (1 + FORECAST_COMPLEXITY[input.complexity] / 100);
  const at = (p: number) => round1(Math.max(0, percentile(totals, p) * scale));

  return {
    min: at(15),
    median: at(50),
    max: at(85),
    iterationsModelled,
    samplesUsed: input.samples.length,
    historyDays,
    basis,
    insufficientData: null,
  };
}

/**
 * A stable seed for one (plan, team) pair.
 *
 * FNV-1a over the two ids: same inputs give the same forecast on every replica and after
 * every deploy, while two teams on one plan still draw independently.
 */
export function forecastSeed(planId: string, teamId: string): number {
  let hash = 0x811c9dc5;
  const key = `${planId}:${teamId}`;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Never 0: mulberry32 seeded with 0 is a valid but needlessly degenerate start.
  return hash === 0 ? 1 : hash;
}
