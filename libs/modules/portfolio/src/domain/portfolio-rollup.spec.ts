import { describe, expect, it } from 'vitest';
import {
  computeCapacityWarnings,
  computeCutlineIndex,
  computePortfolioProgress,
  defaultAllocationEstimate,
  resolveEstimate,
  type PortfolioForecastInput,
  type PortfolioRollupInput,
} from './portfolio-rollup';

const rollup = (over: Partial<PortfolioRollupInput> = {}): PortfolioRollupInput => ({
  rollupPoints: 0,
  rollupCount: 0,
  acceptedPoints: 0,
  acceptedCount: 0,
  ...over,
});

// The BA-documented default mapping for size M: 5 points / 3 items.
const forecast = (over: Partial<PortfolioForecastInput> = {}): PortfolioForecastInput => ({
  refinedPoints: null,
  refinedCount: null,
  preliminaryPoints: 5,
  preliminaryCount: 3,
  ...over,
});

describe('computePortfolioProgress', () => {
  it('divides accepted by the live rollup for the two Percent Done indicators', () => {
    const p = computePortfolioProgress(
      rollup({ rollupPoints: 40, acceptedPoints: 10, rollupCount: 8, acceptedCount: 2 }),
      forecast(),
    );
    expect(p.percentDoneByPlanEstimate).toBe(0.25);
    expect(p.percentDoneByCount).toBe(0.25);
  });

  it('keeps the two Percent Done dimensions independent', () => {
    // Weighted and unweighted progress genuinely differ: two big stories accepted out
    // of eight is 60% of the points but 25% of the count. Both are shown because they
    // answer different questions.
    const p = computePortfolioProgress(
      rollup({ rollupPoints: 50, acceptedPoints: 30, rollupCount: 8, acceptedCount: 2 }),
      forecast(),
    );
    expect(p.percentDoneByPlanEstimate).toBe(0.6);
    expect(p.percentDoneByCount).toBe(0.25);
  });

  it('scope growth lowers Percent Done, because the denominator is live', () => {
    const before = computePortfolioProgress(
      rollup({ rollupPoints: 10, acceptedPoints: 5 }),
      forecast(),
    );
    const afterAddingWork = computePortfolioProgress(
      rollup({ rollupPoints: 20, acceptedPoints: 5 }),
      forecast(),
    );
    expect(before.percentDoneByPlanEstimate).toBe(0.5);
    expect(afterAddingWork.percentDoneByPlanEstimate).toBe(0.25);
  });

  describe('Estimated Progress uses the forecast as denominator', () => {
    it('uses the refined estimate when supplied', () => {
      const p = computePortfolioProgress(
        rollup({ acceptedPoints: 6, acceptedCount: 4 }),
        forecast({ refinedPoints: 12, refinedCount: 8 }),
      );
      expect(p.estimatedProgressByPoints).toBe(0.5);
      expect(p.estimatedProgressByCount).toBe(0.5);
    });

    it('falls back to the Preliminary Estimate mapping when not refined', () => {
      const p = computePortfolioProgress(
        rollup({ acceptedPoints: 1, acceptedCount: 3 }),
        forecast(), // 5 points / 3 count
      );
      expect(p.estimatedProgressByPoints).toBe(0.2);
      expect(p.estimatedProgressByCount).toBe(1);
    });

    it('falls back per dimension independently', () => {
      // Refining points must not silently change the count indicator's denominator.
      const p = computePortfolioProgress(
        rollup({ acceptedPoints: 5, acceptedCount: 3 }),
        forecast({ refinedPoints: 20, refinedCount: null }),
      );
      expect(p.estimatedProgressByPoints).toBe(0.25); // 5/20 refined
      expect(p.estimatedProgressByCount).toBe(1); // 3/3 preliminary
    });

    it('treats a refined 0 as NOT a forecast and falls back to Preliminary', () => {
      // The tier rule is `refined > 0`, not `refined !== null` — stated that way in the
      // Capacity Planning SRS, the dev handoff and the UI catalog, and the mockup renders
      // a 0 as an em-dash. Since migration 0081 the column is NOT NULL DEFAULT 0, so 0 is
      // the value a real "not forecast" row carries and this path is the NORMAL one, not a
      // defensive edge. `resolveEstimate` in this same file uses the same comparison.
      const p = computePortfolioProgress(
        rollup({ acceptedPoints: 2, acceptedCount: 3 }),
        forecast({ refinedPoints: 0, refinedCount: 0 }),
      );
      // Preliminary is 5 points / 3 items. A `??` fallback would have divided by 0 here
      // and blanked both meters.
      expect(p.estimatedProgressByPoints).toBe(0.4); // 2/5 preliminary
      expect(p.estimatedProgressByCount).toBe(1); // 3/3 preliminary
    });
  });

  describe('null is not zero', () => {
    // "Nothing linked" and "nothing done" both render as an empty bar, but only the
    // first is a data-entry gap. Collapsing them to 0 would hide that.
    it('returns null for Percent Done when nothing is linked', () => {
      const p = computePortfolioProgress(rollup(), forecast());
      expect(p.percentDoneByPlanEstimate).toBeNull();
      expect(p.percentDoneByCount).toBeNull();
    });

    it('returns 0, not null, when work is linked but none accepted', () => {
      const p = computePortfolioProgress(rollup({ rollupPoints: 10, rollupCount: 4 }), forecast());
      expect(p.percentDoneByPlanEstimate).toBe(0);
      expect(p.percentDoneByCount).toBe(0);
    });

    it('returns null for Estimated Progress when the forecast is No Entry', () => {
      // Preliminary 'no_entry' maps to 0/0, so there is no target to measure against.
      const p = computePortfolioProgress(
        rollup({ acceptedPoints: 5 }),
        forecast({ preliminaryPoints: 0, preliminaryCount: 0 }),
      );
      expect(p.estimatedProgressByPoints).toBeNull();
      expect(p.estimatedProgressByCount).toBeNull();
    });
  });

  it('does not clamp Estimated Progress above 1', () => {
    // Delivering more than forecast is real information — the forecast was low.
    // Percent Done cannot exceed 1 (its denominator contains the numerator), but this
    // one can, and truncating it to 100% would hide the miss.
    const p = computePortfolioProgress(
      rollup({ acceptedPoints: 20 }),
      forecast({ refinedPoints: 10 }),
    );
    expect(p.estimatedProgressByPoints).toBe(2);
  });
});

describe('resolveEstimate — Allocated → Refined → Preliminary', () => {
  it('prefers allocated over every forecast', () => {
    // Once demand is committed, that total is the truth.
    expect(resolveEstimate({ totalAllocated: 30, refined: 20, preliminary: 5 })).toEqual({
      value: 30,
      tier: 'allocated',
    });
  });

  it('prefers refined over preliminary when nothing is allocated', () => {
    expect(resolveEstimate({ totalAllocated: 0, refined: 20, preliminary: 5 })).toEqual({
      value: 20,
      tier: 'refined',
    });
  });

  it('falls back to preliminary', () => {
    expect(resolveEstimate({ totalAllocated: 0, refined: null, preliminary: 5 })).toEqual({
      value: 5,
      tier: 'preliminary',
    });
  });

  it('reports none when every tier is empty', () => {
    // Drives the "Point Estimated missing" warning.
    expect(resolveEstimate({ totalAllocated: 0, refined: null, preliminary: 0 })).toEqual({
      value: 0,
      tier: 'none',
    });
  });

  it('treats a zero refined estimate as absent', () => {
    // The DB CHECK forbids storing 0, but a caller computing it must agree.
    expect(resolveEstimate({ totalAllocated: 0, refined: 0, preliminary: 5 }).tier).toBe(
      'preliminary',
    );
  });
});

describe('defaultAllocationEstimate — the anti-circularity rule', () => {
  // The subtlest rule in the feature. The Allocate dialog's blank default must NOT
  // consult the allocated tier: folding it back in would mean a blank field commits
  // the sum of the very allocations it is being used to create.
  it('ignores allocated even when allocations already exist', () => {
    expect(defaultAllocationEstimate({ refined: 20, preliminary: 5 })).toEqual({
      value: 20,
      tier: 'refined',
    });
  });

  it('differs from resolveEstimate for the same feature', () => {
    const input = { totalAllocated: 30, refined: 20, preliminary: 5 };
    expect(resolveEstimate(input).tier).toBe('allocated');
    expect(defaultAllocationEstimate(input).tier).toBe('refined');
  });

  it('falls back to preliminary, then none', () => {
    expect(defaultAllocationEstimate({ refined: null, preliminary: 5 }).tier).toBe('preliminary');
    expect(defaultAllocationEstimate({ refined: null, preliminary: 0 })).toEqual({
      value: 0,
      tier: 'none',
    });
  });
});

describe('computeCapacityWarnings', () => {
  /** A team row with a real ceiling — the common case. */
  const team = (over: Partial<Parameters<typeof computeCapacityWarnings>[0]> = {}) =>
    computeCapacityWarnings({ kind: 'team', rollup: 0, estimated: 0, capacity: 100, ...over });

  /** A Feature row: no ceiling of its own, and an estimate that came from some tier. */
  const feature = (over: Partial<Parameters<typeof computeCapacityWarnings>[0]> = {}) =>
    computeCapacityWarnings({
      kind: 'feature',
      rollup: 0,
      estimated: 30,
      capacity: null,
      tier: 'refined',
      ...over,
    });

  it('warns when the rollup outgrows the commitment', () => {
    expect(team({ rollup: 40, estimated: 30 })).toContain('rollup_exceeds_estimated');
  });

  it('warns when the rollup exceeds capacity', () => {
    expect(team({ rollup: 120, estimated: 130 })).toContain('rollup_exceeds_capacity');
  });

  it('warns when committed demand exceeds capacity', () => {
    expect(team({ estimated: 130 })).toContain('estimated_exceeds_capacity');
  });

  it('returns nothing when everything fits', () => {
    expect(team({ rollup: 20, estimated: 30 })).toEqual([]);
  });

  describe("Rally's missing-data errors, which are the CAUSE of the comparison ones", () => {
    it('warns that a team has no capacity entered', () => {
      // Rally raises this by itself and describes it as cascading into the capacity
      // comparisons. Silence here would read as "all clear" on a row whose checks were
      // skipped entirely.
      expect(team({ capacity: null })).toContain('team_missing_capacity');
      expect(team({ capacity: 0 })).toContain('team_missing_capacity');
    });

    it('reports the missing capacity INSTEAD of unevaluable comparisons', () => {
      // With no ceiling, "exceeds capacity" has no meaning — only the estimate comparison,
      // which does not need one, may still fire.
      const w = team({ capacity: null, rollup: 40, estimated: 30 });
      expect(w).toEqual(['team_missing_capacity', 'rollup_exceeds_estimated']);
    });

    it("warns that a Feature has no estimate at all — Rally's Missing Estimate Error", () => {
      // Tier `none` means no allocation, no refined forecast, no preliminary mapping.
      expect(feature({ tier: 'none', estimated: 0 })).toContain('feature_missing_estimate');
    });

    it('reports the missing estimate BEFORE the rollup comparison it causes', () => {
      // A zero estimate is why the rollup exceeds it. Leading with the consequence would
      // send the planner to fix the wrong field.
      expect(feature({ tier: 'none', estimated: 0, rollup: 12 })).toEqual([
        'feature_missing_estimate',
        'rollup_exceeds_estimated',
      ]);
    });

    it('stays quiet for a Feature whose estimate came from any real tier', () => {
      expect(feature({ tier: 'preliminary' })).toEqual([]);
      expect(feature({ tier: 'allocated' })).toEqual([]);
    });

    it('never raises the Feature rule on a team row, or the team rule on a Feature', () => {
      // The two rules are mutually exclusive by row kind, which is exactly why `kind` is
      // stated rather than inferred from a null capacity.
      expect(team({ capacity: null })).not.toContain('feature_missing_estimate');
      expect(feature({ tier: 'none', estimated: 0 })).not.toContain('team_missing_capacity');
    });
  });

  describe('Feature rows carry no capacity of their own', () => {
    it('evaluates only the rollup-vs-estimated rule', () => {
      expect(feature({ rollup: 40, estimated: 30 })).toEqual(['rollup_exceeds_estimated']);
    });

    it('returns nothing for a healthy Feature row', () => {
      expect(feature({ rollup: 10, estimated: 30 })).toEqual([]);
    });
  });

  describe('inside capacity is not a warning', () => {
    /**
     * There used to be a `load_above_target` rule: committed demand past
     * `capacity_plans.target_load_pct` (default 80) while still under capacity. Nothing in the BA's
     * advisory set rations headroom, and every surface drew it with the SAME red triangle as a real
     * breach — so a team at 85%, healthy and exactly where Rally's guidance suggests, looked
     * identical to one that had blown its ceiling.
     */
    it('says nothing about a team at 85% of capacity', () => {
      expect(team({ rollup: 85, estimated: 85, capacity: 100 })).toEqual([]);
    });

    it('says nothing about a team planned exactly to its ceiling', () => {
      // Strictly-greater comparisons: 100 of 100 is planned to the line, not over it.
      expect(team({ rollup: 100, estimated: 100, capacity: 100 })).toEqual([]);
    });

    it('still warns once genuinely over capacity', () => {
      expect(team({ rollup: 130, estimated: 130, capacity: 100 })).toEqual([
        'rollup_exceeds_capacity',
        'estimated_exceeds_capacity',
      ]);
    });
  });

  it('treats a zero capacity as missing rather than as a ceiling of zero', () => {
    // Dividing a target by zero is meaningless, and a planner who typed 0 has not yet
    // stated a real ceiling — Rally's missing-capacity error is the honest report.
    expect(team({ rollup: 5, estimated: 5, capacity: 0 })).toEqual(['team_missing_capacity']);
  });
});

describe('computeCutlineIndex', () => {
  /**
   * Rally's rule, verbatim from the Items tab doc: "Items above the cutline fit within the defined plan
   * capacity. Items below the line exceed the capacity of the plan" — and it "only displays when you
   * sort portfolio items by rank in ascending order", because in any other order a running total means
   * nothing.
   *
   * A declared divergence from SRS §189, which puts the overflowing Feature ABOVE the line. See the
   * function's own note and `CLAUDE.md`.
   */
  it('returns the index of the last item that fits', () => {
    // 30+25+20+25 = 100 exactly; the fifth item would exceed.
    expect(computeCutlineIndex([30, 25, 20, 25, 15], 100)).toBe(3);
  });

  it('includes an item that lands exactly on capacity', () => {
    // `>` not `>=`: a plan filled to the line fits, so that item stays above it.
    expect(computeCutlineIndex([50, 50], 100)).toBe(1);
  });

  it('keeps the TIPPING Feature BELOW the line — it does not fit', () => {
    /**
     * The one row §189 disagrees about. 90 + 20 = 110 against 100, so the 20 does not fit and belongs
     * below the line; §189 would keep it above. Rally's sentence is what settles it: above the line
     * means fits.
     *
     * Also NOT a bin-packing optimisation: the 5 would fit in the 10 the plan has left, and still stays
     * below, because the cutline follows priority order.
     */
    expect(computeCutlineIndex([90, 20, 5], 100)).toBe(0);
  });

  it('returns -1 when the first item alone exceeds capacity', () => {
    // Nothing fits, so the line sits above everything.
    expect(computeCutlineIndex([150, 10], 100)).toBe(-1);
  });

  it('returns the last index when everything fits', () => {
    expect(computeCutlineIndex([10, 20, 30], 100)).toBe(2);
  });

  it('returns null when no capacity has been entered', () => {
    expect(computeCutlineIndex([10, 20], null)).toBeNull();
    expect(computeCutlineIndex([10, 20], 0)).toBeNull();
  });

  it('handles an empty list', () => {
    expect(computeCutlineIndex([], 100)).toBe(-1);
  });

  it('treats a zero-estimate item as fitting', () => {
    // An unestimated Feature consumes no capacity, so it must not push the line up.
    expect(computeCutlineIndex([50, 0, 50], 100)).toBe(2);
  });
});
