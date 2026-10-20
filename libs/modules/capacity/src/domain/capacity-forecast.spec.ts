import { describe, expect, it } from 'vitest';

import {
  FORECAST_COMPLEXITY,
  FORECAST_MIN_HISTORY_DAYS,
  forecastCapacity,
  forecastSeed,
  type ForecastInput,
  type VelocitySample,
} from './capacity-forecast';

const sample = (points: number, over: Partial<VelocitySample> = {}): VelocitySample => ({
  iterationId: `it-${points}`,
  iterationName: `Sprint ${points}`,
  points,
  count: Math.round(points / 5),
  days: 14,
  ...over,
});

/** A steady team: five two-week iterations, 70 days of history. */
const STEADY = [sample(20), sample(20), sample(20), sample(20), sample(20)];
/** Same mean, wildly different spread — the case an average cannot describe. */
const ERRATIC = [sample(0), sample(5), sample(20), sample(35), sample(40)];

const input = (over: Partial<ForecastInput> = {}): ForecastInput => ({
  samples: STEADY,
  unit: 'points',
  // Four two-week iterations' worth of window.
  windowDays: 56,
  availabilityPct: 100,
  complexity: 'typical',
  seed: 12345,
  // Enough trials for stable percentiles, few enough to keep the suite fast.
  trials: 4000,
  ...over,
});

describe('forecastCapacity', () => {
  it('models the window as whole iterations of the TEAM’s own cadence', () => {
    // 56 days over an average iteration of 14 = 4 iterations. A team on three-week
    // iterations must not be modelled as though it ran two-week ones.
    expect(forecastCapacity(input()).iterationsModelled).toBe(4);

    const threeWeek = forecastCapacity(input({ samples: STEADY.map((s) => ({ ...s, days: 21 })) }));
    expect(threeWeek.iterationsModelled).toBe(3); // 56 / 21 ≈ 2.67 → 3
  });

  it('forecasts a steady team as its rate times the window', () => {
    // 20 points per iteration, four iterations. With no variance every trial is identical,
    // so all three lines agree — and that is the honest answer for this history.
    const r = forecastCapacity(input());
    expect(r.min).toBe(80);
    expect(r.median).toBe(80);
    expect(r.max).toBe(80);
    expect(r.insufficientData).toBeNull();
  });

  it('spreads the three lines apart for an erratic team of the SAME average', () => {
    // Both teams average 20/iteration. The whole point of sampling rather than averaging:
    // this one cannot commit to 80 even though its mean says it can.
    const steady = forecastCapacity(input());
    const erratic = forecastCapacity(input({ samples: ERRATIC }));

    expect(erratic.median).toBeGreaterThan(0);
    expect(erratic.min).toBeLessThan(erratic.median);
    expect(erratic.max).toBeGreaterThan(erratic.median);
    // The conservative line is materially lower than the steady team's, from identical means.
    expect(erratic.min).toBeLessThan(steady.min);
  });

  it('orders the lines by the probability of ACHIEVING them, not by rank', () => {
    // Min is delivered 85% of the time, Max only 15% — so Min must be the SMALLER number.
    // Reading the percentiles the other way round is the easiest error in this file.
    const r = forecastCapacity(input({ samples: ERRATIC }));
    expect(r.min).toBeLessThanOrEqual(r.median);
    expect(r.median).toBeLessThanOrEqual(r.max);
  });

  it('is deterministic — the same history and seed give the same forecast', () => {
    // A planner rerunning a forecast on unchanged history must not see a different number,
    // or choosing between two runs becomes arbitrary.
    const a = forecastCapacity(input({ samples: ERRATIC }));
    const b = forecastCapacity(input({ samples: ERRATIC }));
    expect(a).toEqual(b);
  });

  it('actually uses the seed — different seeds are different DRAWS', () => {
    // Shown at a tiny trial count, where sampling noise is visible. At production trial
    // counts two seeds converge on the same percentiles, which is what the next test pins;
    // asserting a difference there would be asserting that the estimator is noisy.
    const a = forecastCapacity(input({ samples: ERRATIC, trials: 5, seed: 1 }));
    const b = forecastCapacity(input({ samples: ERRATIC, trials: 5, seed: 999 }));
    expect(a).not.toEqual(b);
  });

  it('converges: with enough trials the seed stops mattering', () => {
    // The property that makes a seeded sampler safe to ship. If two seeds disagreed at
    // 4,000 trials, the number on screen would be an artefact of the seed rather than of
    // the team's history.
    const a = forecastCapacity(input({ samples: ERRATIC, seed: 1 }));
    const b = forecastCapacity(input({ samples: ERRATIC, seed: 999 }));
    expect(a.median).toBe(b.median);
    expect(Math.abs(a.min - b.min)).toBeLessThanOrEqual(5);
    expect(Math.abs(a.max - b.max)).toBeLessThanOrEqual(5);
  });

  it('scales by team availability', () => {
    // Rally: 100% for a stable team, 200% if it doubled, 50% if it halved.
    expect(forecastCapacity(input({ availabilityPct: 50 })).median).toBe(40);
    expect(forecastCapacity(input({ availabilityPct: 200 })).median).toBe(160);
  });

  it("applies Rally's complexity adjustments exactly", () => {
    expect(FORECAST_COMPLEXITY).toEqual({
      well_understood: 10,
      typical: 0,
      minor_concerns: -10,
      major_concerns: -25,
      many_unknowns: -50,
    });
    expect(forecastCapacity(input({ complexity: 'well_understood' })).median).toBe(88);
    expect(forecastCapacity(input({ complexity: 'many_unknowns' })).median).toBe(40);
  });

  it('combines availability and complexity multiplicatively', () => {
    // Half the team on work with major concerns: 80 × 0.5 × 0.75.
    expect(
      forecastCapacity(input({ availabilityPct: 50, complexity: 'major_concerns' })).median,
    ).toBe(30);
  });

  it('forecasts item COUNT when that is the plan’s unit', () => {
    // 4 items per iteration (20 / 5), four iterations.
    expect(forecastCapacity(input({ unit: 'count' })).median).toBe(16);
  });

  it('never returns a negative forecast', () => {
    // Not reachable through the enum today, but a future adjustment below −100% would make
    // it so, and a negative capacity is meaningless.
    const r = forecastCapacity(input({ availabilityPct: 0 }));
    expect(r.median).toBe(0);
  });

  describe('refuses to invent a forecast', () => {
    it('reports no history rather than zero capacity', () => {
      // A team with no finished iterations is not a team that delivers nothing.
      const r = forecastCapacity(input({ samples: [] }));
      expect(r.insufficientData).toBe('no_history');
      expect(r.median).toBe(0);
    });

    it("reports too little history below Rally's 14-day minimum", () => {
      // Sampling one short iteration 20,000 times returns that iteration dressed up as a
      // distribution.
      const r = forecastCapacity(input({ samples: [sample(20, { days: 7 })] }));
      expect(r.insufficientData).toBe('too_little_history');
      expect(r.historyDays).toBeLessThan(FORECAST_MIN_HISTORY_DAYS);
    });

    it('accepts exactly the minimum', () => {
      const r = forecastCapacity(input({ samples: [sample(20, { days: 14 })] }));
      expect(r.insufficientData).toBeNull();
    });

    it('reports a missing window rather than guessing one', () => {
      // A plan with no planned dates has nothing to forecast INTO.
      expect(forecastCapacity(input({ windowDays: 0 })).insufficientData).toBe('no_window');
      expect(forecastCapacity(input({ windowDays: -5 })).insufficientData).toBe('no_window');
    });

    it('still reports how much history it saw when it refuses', () => {
      // The dialog says "7 days across 1 iteration", which is what tells the planner
      // whether to wait a sprint or to enter a capacity by hand.
      const r = forecastCapacity(input({ samples: [sample(20, { days: 7 })] }));
      expect(r.samplesUsed).toBe(1);
      expect(r.historyDays).toBe(7);
    });
  });

  it('models at least one iteration for a window shorter than the cadence', () => {
    // A five-day window on a two-week cadence: rounding to zero would forecast zero
    // capacity for a real window.
    const r = forecastCapacity(input({ windowDays: 5 }));
    expect(r.iterationsModelled).toBe(1);
    expect(r.median).toBe(20);
  });

  describe('a velocity the PLANNER supplied', () => {
    // The BA's reading: "proposes capacities from a supplied historic velocity" (SRS:142), with
    // velocity-driven AUTOMATIC capacity out of scope (SRS:418). So it is an input, not a
    // derivation, and it replaces the sampled history rather than adjusting it.

    it('multiplies the supplied velocity by the modelled iterations', () => {
      // 30 per iteration over a 56-day window on the history's 14-day cadence = 4 × 30.
      const r = forecastCapacity(input({ velocityPerIteration: 30 }));
      expect(r.basis).toBe('supplied');
      expect(r.iterationsModelled).toBe(4);
      expect([r.min, r.median, r.max]).toEqual([120, 120, 120]);
    });

    it('reports NO spread, because one number carries none', () => {
      // Against ERRATIC history, whose sampled forecast is deliberately wide — proving the
      // supplied number replaced the samples instead of being blended with them.
      const r = forecastCapacity(input({ samples: ERRATIC, velocityPerIteration: 20 }));
      expect(r.min).toBe(r.max);
      expect(forecastCapacity(input({ samples: ERRATIC })).min).toBeLessThan(
        forecastCapacity(input({ samples: ERRATIC })).max,
      );
    });

    it('forecasts for a team with NO history at all, on the project cadence', () => {
      // The case a supplied velocity exists for: nothing to sample, so the history gates must
      // not apply. 56-day window ÷ a 7-day cadence = 8 iterations of 10.
      const r = forecastCapacity(
        input({ samples: [], velocityPerIteration: 10, fallbackIterationDays: 7 }),
      );
      expect(r.insufficientData).toBeNull();
      expect(r.iterationsModelled).toBe(8);
      expect(r.median).toBe(80);
    });

    it('ignores the 14-day minimum, which is a statement about SAMPLING', () => {
      const r = forecastCapacity(
        input({ samples: [sample(20, { days: 3 })], velocityPerIteration: 25 }),
      );
      expect(r.insufficientData).toBeNull();
      expect(r.basis).toBe('supplied');
    });

    it('still scales by availability and complexity', () => {
      // Those describe the window being planned, not where the velocity came from.
      const r = forecastCapacity(
        input({ velocityPerIteration: 30, availabilityPct: 50, complexity: 'many_unknowns' }),
      );
      expect(r.median).toBe(30);
    });

    it('still needs a window', () => {
      expect(
        forecastCapacity(input({ velocityPerIteration: 30, windowDays: 0 })).insufficientData,
      ).toBe('no_window');
    });

    it('reports no cadence rather than assuming a sprint length', () => {
      // No history to average and no project cadence: "so many points per iteration" cannot be
      // spread over a window until something says how long an iteration is. Guessing two weeks
      // would put a number on screen that no data supports.
      const r = forecastCapacity(input({ samples: [], velocityPerIteration: 30 }));
      expect(r.insufficientData).toBe('no_cadence');
      expect(r.median).toBe(0);
    });

    it('falls back to sampling when the supplied velocity is absent or not positive', () => {
      for (const velocityPerIteration of [undefined, null, 0]) {
        const r = forecastCapacity(input({ velocityPerIteration }));
        expect(r.basis).toBe('history');
        expect(r.median).toBe(80);
      }
    });
  });

  it('tolerates a zero-length iteration in the history without dividing by it', () => {
    const r = forecastCapacity(input({ samples: [sample(20, { days: 0 }), sample(30)] }));
    expect(r.insufficientData).toBeNull();
    expect(Number.isFinite(r.median)).toBe(true);
  });
});

describe('forecastSeed', () => {
  it('is stable for one plan and team', () => {
    expect(forecastSeed('plan-1', 'team-1')).toBe(forecastSeed('plan-1', 'team-1'));
  });

  it('differs per team and per plan, so two rows do not share one draw', () => {
    expect(forecastSeed('plan-1', 'team-1')).not.toBe(forecastSeed('plan-1', 'team-2'));
    expect(forecastSeed('plan-1', 'team-1')).not.toBe(forecastSeed('plan-2', 'team-1'));
  });

  it('is never zero', () => {
    expect(forecastSeed('', '')).toBeGreaterThan(0);
  });
});
