import { describe, expect, it } from 'vitest';
import {
  computeHealth,
  PORTFOLIO_HEALTH_THRESHOLDS,
  type HealthInput,
  type HealthThresholds,
} from './health';

// A 100-day window makes "percent elapsed" readable as a day count: day 50 is 50%.
const START = new Date('2026-01-01T00:00:00Z');
const END = new Date('2026-04-11T00:00:00Z'); // START + 100 days

const dayN = (n: number) => new Date(START.getTime() + n * 86_400_000);

const base = (over: Partial<HealthInput> = {}): HealthInput => ({
  accepted: 0,
  total: 100,
  start: START,
  end: END,
  today: dayN(50),
  thresholds: PORTFOLIO_HEALTH_THRESHOLDS,
  ...over,
});

describe('computeHealth', () => {
  describe('Rally thresholds — 20% at risk, 40% late', () => {
    it('is on track when progress keeps pace with the window', () => {
      // 50% elapsed, 50% accepted — 0 points behind.
      const r = computeHealth(base({ accepted: 50 }));
      expect(r.state).toBe('on_track');
      expect(r.percentDone).toBe(0.5);
      expect(r.percentElapsed).toBe(0.5);
      expect(r.indeterminate).toBeNull();
    });

    it('is on track while behind by less than the at-risk threshold', () => {
      // 50% elapsed, 31% accepted — 19 points behind, just inside 20.
      expect(computeHealth(base({ accepted: 31 })).state).toBe('on_track');
    });

    it('is at risk exactly at the at-risk threshold', () => {
      // 20 points behind — the spec says "20% or more below", so 20 counts.
      expect(computeHealth(base({ accepted: 30 })).state).toBe('at_risk');
    });

    it('is at risk between the two thresholds', () => {
      expect(computeHealth(base({ accepted: 20 })).state).toBe('at_risk'); // 30 behind
    });

    it('is late exactly at the late threshold', () => {
      expect(computeHealth(base({ accepted: 10 })).state).toBe('late'); // 40 behind
    });

    it('is late when far behind', () => {
      expect(computeHealth(base({ accepted: 0 })).state).toBe('late'); // 50 behind
    });

    it('is on track when ahead of the window', () => {
      // Ahead means negative "behind", which must not trip either threshold.
      expect(computeHealth(base({ accepted: 90 })).state).toBe('on_track');
    });
  });

  /**
   * Rally's BLUE needs BOTH conditions: "current date is after the Planned End Date and
   * the artifacts in the portfolio item are 100% done" (Broadcom TechDocs, "Using the
   * Portfolio Items Page"). Finishing early therefore does NOT turn an item blue.
   */
  describe('complete is Rally blue — 100% done AND past the planned end', () => {
    it('is complete once the planned end has passed and all work is accepted', () => {
      const r = computeHealth(base({ accepted: 100, today: dayN(200) }));
      expect(r.state).toBe('complete');
      expect(r.percentDone).toBe(1);
    });

    it('stays ON TRACK when finished EARLY, because the end date has not passed', () => {
      // Ahead of schedule is still green in Rally; blue is reserved for "done and the
      // window has closed". Reporting complete here would be friendlier but wrong.
      const r = computeHealth(base({ accepted: 100, today: dayN(50) }));
      expect(r.state).toBe('on_track');
      expect(r.percentDone).toBe(1);
    });

    it('clamps an over-total rollup to 100% rather than reporting 130%', () => {
      // Defensive: a rollup can momentarily exceed its own denominator mid-write.
      const r = computeHealth(base({ accepted: 130, today: dayN(200) }));
      expect(r.state).toBe('complete');
      expect(r.percentDone).toBe(1);
    });

    it('is INDETERMINATE when finished but there are no planned dates', () => {
      // Rally's blue is defined against the Planned End Date, so without one there is
      // nothing to compare against — it warns about the missing dates instead.
      const r = computeHealth(base({ accepted: 100, start: null, end: null }));
      expect(r.state).toBe('not_started');
      expect(r.indeterminate).toBe('no_dates');
      // The percentage is still reported — only the VERDICT is unavailable.
      expect(r.percentDone).toBe(1);
    });
  });

  describe('indeterminate inputs — every one is reachable from real data', () => {
    it('reports no_work when nothing is linked', () => {
      // A Feature with no children. Not a health problem; dividing by zero would
      // invent one.
      const r = computeHealth(base({ total: 0, accepted: 0 }));
      expect(r.state).toBe('not_started');
      expect(r.percentDone).toBeNull();
      expect(r.indeterminate).toBe('no_work');
    });

    it('reports no_dates when the planned window is missing', () => {
      // Rally allows a portfolio item with no dates; it warns rather than assuming.
      const r = computeHealth(base({ accepted: 10, start: null, end: null }));
      expect(r.state).toBe('not_started');
      expect(r.indeterminate).toBe('no_dates');
      expect(r.percentDone).toBe(0.1);
    });

    it('reports no_dates when only the start is missing', () => {
      expect(computeHealth(base({ accepted: 10, start: null })).indeterminate).toBe('no_dates');
    });

    it('reports no_dates when only the end is missing', () => {
      expect(computeHealth(base({ accepted: 10, end: null })).indeterminate).toBe('no_dates');
    });

    it('treats a zero-length window as no_dates, not instantly late', () => {
      // Same start and end is a data-entry slip. Reporting "late" would punish it.
      const r = computeHealth(base({ accepted: 10, start: START, end: START }));
      expect(r.state).toBe('not_started');
      expect(r.indeterminate).toBe('no_dates');
    });

    it('treats an inverted window as no_dates', () => {
      const r = computeHealth(base({ accepted: 10, start: END, end: START }));
      expect(r.indeterminate).toBe('no_dates');
    });
  });

  describe('window boundaries', () => {
    it('is not_started before the planned start', () => {
      // Rally's gray "future start date" case.
      const r = computeHealth(base({ accepted: 0, today: dayN(-10) }));
      expect(r.state).toBe('not_started');
      expect(r.percentElapsed).toBe(0);
      expect(r.indeterminate).toBeNull();
    });

    it('is late past the end date with work outstanding', () => {
      const r = computeHealth(base({ accepted: 40, today: dayN(150) }));
      expect(r.state).toBe('late');
      // Elapsed clamps at 1 rather than reporting 150%.
      expect(r.percentElapsed).toBe(1);
    });

    it('evaluates on the start date itself as 0% elapsed', () => {
      const r = computeHealth(base({ accepted: 0, today: START }));
      expect(r.percentElapsed).toBe(0);
      expect(r.state).toBe('on_track');
    });

    it('ignores time of day', () => {
      // Dates are whole days; a late-evening evaluation must not shift the verdict.
      const morning = computeHealth(
        base({ accepted: 50, today: new Date('2026-02-20T01:00:00Z') }),
      );
      const evening = computeHealth(
        base({ accepted: 50, today: new Date('2026-02-20T23:59:00Z') }),
      );
      expect(morning.percentElapsed).toBe(evening.percentElapsed);
      expect(morning.state).toBe(evening.state);
    });
  });

  describe('thresholds are a parameter, not a constant', () => {
    // The whole reason this lives in shared-kernel: Rally uses a different scheme per
    // surface (Portfolio 20/40, Release Tracking 90/70, Milestone confidence a third).
    // A second surface must not need a second copy of this algorithm.
    const strict: HealthThresholds = { atRiskPctBehind: 5, latePctBehind: 10 };

    it('applies caller-supplied thresholds', () => {
      // 6 points behind: on_track under Portfolio's 20/40, at_risk under 5/10.
      const input = base({ accepted: 44 });
      expect(computeHealth(input).state).toBe('on_track');
      expect(computeHealth({ ...input, thresholds: strict }).state).toBe('at_risk');
    });

    it('applies the stricter late threshold', () => {
      // 12 points behind.
      const input = base({ accepted: 38 });
      expect(computeHealth(input).state).toBe('on_track');
      expect(computeHealth({ ...input, thresholds: strict }).state).toBe('late');
    });

    it('exposes Rally portfolio thresholds as 20 and 40', () => {
      // Pinned: these are quoted from Rally's documented behaviour, so a silent
      // edit here would silently change what "At Risk" means.
      expect(PORTFOLIO_HEALTH_THRESHOLDS).toEqual({ atRiskPctBehind: 20, latePctBehind: 40 });
    });
  });

  it('never returns a percentage outside 0–1', () => {
    const cases: HealthInput[] = [
      base({ accepted: -5 }),
      base({ accepted: 500 }),
      base({ today: dayN(-999) }),
      base({ today: dayN(999) }),
    ];
    for (const c of cases) {
      const r = computeHealth(c);
      for (const v of [r.percentDone, r.percentElapsed]) {
        if (v !== null) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
