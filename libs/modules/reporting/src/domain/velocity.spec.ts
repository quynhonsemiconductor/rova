import { describe, expect, it } from 'vitest';
import { buildBar, classify, computeAverages, selectWindow, type VelocityItem } from './velocity';
import { endOfWorkspaceDay } from './report-scope';

const END = endOfWorkspaceDay('2026-01-16', 'UTC');

const item = (over: Partial<VelocityItem> = {}): VelocityItem => ({
  id: 'i1',
  planEstimate: 5,
  acceptedEquivalent: true,
  acceptedDate: new Date('2026-01-16T10:00:00Z'),
  splitCarryover: false,
  ...over,
});

/**
 * A Split's `[Unfinished]` placeholder, in the shape the database actually stores it (SU-BR-09):
 * `accepted`, with a real `accepted_date` INSIDE the source window. Every field except
 * `splitCarryover` is what a delivered story looks like — which is the whole reason the flag has to
 * be consulted first.
 */
const placeholder = (over: Partial<VelocityItem> = {}): VelocityItem =>
  item({ id: 'ph', splitCarryover: true, ...over });

describe('classify (Velocity §3)', () => {
  it('counts an item accepted ON the end date as During (example 1)', () => {
    expect(classify(item({ acceptedDate: new Date('2026-01-16T23:59:59Z') }), END)).toBe('during');
  });

  it('counts an item accepted the day after as After (example 2)', () => {
    expect(classify(item({ acceptedDate: new Date('2026-01-17T00:00:01Z') }), END)).toBe('after');
  });

  it('counts an item still in Completed as Not Accepted (example 3)', () => {
    // Completed is NOT accepted-equivalent — the distinction the whole report turns on.
    expect(classify(item({ acceptedEquivalent: false, acceptedDate: null }), END)).toBe(
      'not-accepted',
    );
  });

  it('keeps a Release item in During when its acceptance predates the end (example 4)', () => {
    expect(classify(item({ acceptedDate: new Date('2026-01-10T00:00:00Z') }), END)).toBe('during');
  });

  it('refuses to guess for an accepted item with no acceptedDate', () => {
    // "the report must not guess whether it was accepted during or after the Iteration"
    expect(classify(item({ acceptedDate: null }), END)).toBe('unclassified');
  });
});

describe('classify — the Split placeholder (SU-09 9.1, AC2)', () => {
  it('classifies a placeholder as split-carryover even though it looks delivered', () => {
    // Accepted, with an acceptedDate inside the window: `during` by the Phase 6 rule, and wrong.
    expect(classify(placeholder(), END)).toBe('split-carryover');
  });

  it('decides split-carryover BEFORE the accepted checks, which is what makes it hold', () => {
    /**
     * The ORDER, asserted as its own claim rather than inferred from the case above.
     *
     * Each of these would land in a DIFFERENT later bucket if the flag were checked after it —
     * `during` / `after` on the acceptedDate comparison, `unclassified` on the null date,
     * `not-accepted` on the state. All five answer `split-carryover`, so moving the branch down by
     * even one line fails here.
     */
    const shapes = [
      placeholder({ acceptedDate: new Date('2026-01-10T00:00:00Z') }), // would be during
      placeholder({ acceptedDate: new Date('2026-01-20T00:00:00Z') }), // would be after
      placeholder({ acceptedDate: null }), // would be unclassified
      placeholder({ acceptedEquivalent: false, acceptedDate: null }), // would be not-accepted
      placeholder({ planEstimate: null }), // unpointed, still carryover
    ];
    expect(shapes.map((s) => classify(s, END))).toEqual([
      'split-carryover',
      'split-carryover',
      'split-carryover',
      'split-carryover',
      'split-carryover',
    ]);
  });

  it('leaves the [Continued] Story to the normal rule in its TARGET iteration (AC4)', () => {
    /**
     * `[Continued]` is the ORIGINAL row, UPDATEd and moved forward: it carries NO `split_id` (plan D6
     * gives the column to the placeholder alone), so it is classified by `acceptedDate` like anything
     * else. Both directions, because "the normal rule" is two answers and only asserting one of them
     * would pass if the flag were somehow read off the wrong side.
     */
    const continuedAccepted = item({ id: 'c1', acceptedDate: new Date('2026-01-14T00:00:00Z') });
    const continuedOpen = item({ id: 'c2', acceptedEquivalent: false, acceptedDate: null });
    expect(classify(continuedAccepted, END)).toBe('during');
    expect(classify(continuedOpen, END)).toBe('not-accepted');
  });
});

describe('buildBar', () => {
  const bar = (items: VelocityItem[]) =>
    buildBar({
      timeboxKey: 'tb',
      name: 'Sprint 25.1',
      startDate: '2026-01-05',
      endDate: '2026-01-16',
      endBoundary: END,
      iterationCount: 1,
      items,
    });

  it('puts every point in exactly one segment and preserves the §3 invariant', () => {
    const result = bar([
      item({ id: 'a', planEstimate: 5, acceptedDate: new Date('2026-01-16T09:00:00Z') }),
      item({ id: 'b', planEstimate: 3, acceptedDate: new Date('2026-01-17T09:00:00Z') }),
      item({ id: 'c', planEstimate: 8, acceptedEquivalent: false, acceptedDate: null }),
      item({ id: 'd', planEstimate: 2, acceptedDate: null }), // data-quality gap
    ]);
    expect(result.acceptedDuring).toBe(5);
    expect(result.acceptedAfter).toBe(3);
    expect(result.notAccepted).toBe(8);
    expect(result.unclassified).toBe(2);
    expect(result.unclassifiedItems).toBe(1);
    // during + after + notAccepted + unclassified === every distinct assigned estimate
    expect(
      result.acceptedDuring + result.acceptedAfter + result.notAccepted + result.unclassified,
    ).toBe(18);
  });

  it('de-duplicates by work item id, which is what All Teams needs', () => {
    // The same story reached through two Teams' iteration joins must count once.
    const result = bar([item({ id: 'a', planEstimate: 5 }), item({ id: 'a', planEstimate: 5 })]);
    expect(result.acceptedDuring).toBe(5);
  });

  it('treats a missing plan estimate as zero points rather than dropping the item', () => {
    const result = bar([item({ id: 'a', planEstimate: null, acceptedEquivalent: false })]);
    expect(result.notAccepted).toBe(0);
  });

  it('holds the FIVE-way invariant §8 Q7 rules, not the four-way one the SRS states (AC6)', () => {
    /**
     * `acceptedDuring + acceptedAfter + notAccepted + unclassified + splitCarryover` = the displayed
     * points. Both extra buckets are populated in the SAME bar on purpose: a four-way assertion
     * passes for as long as no data-quality row and no Split coexist, and encoding THAT is how an
     * invariant comes to be trusted for a case it was never shown.
     */
    const result = bar([
      item({ id: 'a', planEstimate: 5, acceptedDate: new Date('2026-01-16T09:00:00Z') }),
      item({ id: 'b', planEstimate: 3, acceptedDate: new Date('2026-01-17T09:00:00Z') }),
      item({ id: 'c', planEstimate: 8, acceptedEquivalent: false, acceptedDate: null }),
      item({ id: 'd', planEstimate: 2, acceptedDate: null }),
      placeholder({ id: 'e', planEstimate: 13 }),
    ]);
    expect(result.acceptedDuring).toBe(5);
    expect(result.acceptedAfter).toBe(3);
    expect(result.notAccepted).toBe(8);
    expect(result.unclassified).toBe(2);
    expect(result.splitCarryover).toBe(13);
    expect(
      result.acceptedDuring +
        result.acceptedAfter +
        result.notAccepted +
        result.unclassified +
        result.splitCarryover,
    ).toBe(31);
  });

  it('keeps the placeholder OUT of acceptedDuring, which is the bucket it would otherwise join', () => {
    const result = bar([placeholder({ planEstimate: 7 })]);
    expect(result.acceptedDuring).toBe(0);
    expect(result.splitCarryover).toBe(7);
  });

  it('names the excluded stories so the population is identifiable, de-duplicated with the sum', () => {
    const result = bar([
      placeholder({ id: 'ph1', planEstimate: 2 }),
      // The same placeholder reached twice through two Teams' iteration joins — All Teams' shape.
      placeholder({ id: 'ph1', planEstimate: 2 }),
      placeholder({ id: 'ph2', planEstimate: 3 }),
    ]);
    expect(result.splitStoryIds).toEqual(['ph1', 'ph2']);
    // The list and the points count the SAME rows: 2 + 3, not 2 + 2 + 3.
    expect(result.splitCarryover).toBe(5);
  });

  it('reports no excluded stories and an empty list for a bar no Split touched', () => {
    // The SPA sums these lengths for its footnote, so "absent" has to be `[]` and `0`, never null.
    const result = bar([item({ id: 'a', planEstimate: 5 })]);
    expect(result.splitCarryover).toBe(0);
    expect(result.splitStoryIds).toEqual([]);
  });
});

describe('computeAverages (Velocity §5 and §7.7)', () => {
  const bars = (during: number[]) =>
    during.map((v, i) =>
      buildBar({
        timeboxKey: `tb${i}`,
        name: `S${i}`,
        startDate: null,
        endDate: null,
        endBoundary: END,
        iterationCount: 1,
        items: [item({ id: `x${i}`, planEstimate: v })],
      }),
    );

  it('matches the worked example [36, 51, 43, 52, 34]', () => {
    const a = computeAverages(bars([36, 51, 43, 52, 34]));
    expect(a.last3).toBe(43); // [43, 52, 34]
    expect(a.best3).toBe(48.67); // [52, 51, 43]
    expect(a.worst3).toBe(37.67); // [34, 36, 43]
    expect(a.trend).toBe(43.2);
    expect(a.sampleSize).toBe(5);
  });

  it('uses every available value and reports the real sample size below three', () => {
    const a = computeAverages(bars([40, 20]));
    expect(a.last3).toBe(30);
    expect(a.best3).toBe(30);
    expect(a.worst3).toBe(30);
    expect(a.sampleSize).toBe(2);
  });

  it('returns nulls rather than zeros with no eligible iteration', () => {
    // A zero average would read as measured performance; there is nothing measured.
    expect(computeAverages([])).toEqual({
      trend: null,
      last3: null,
      best3: null,
      worst3: null,
      sampleSize: 0,
    });
  });

  it('excludes After and Not Accepted from every average', () => {
    const late = buildBar({
      timeboxKey: 'tb',
      name: 'S',
      startDate: null,
      endDate: null,
      endBoundary: END,
      iterationCount: 1,
      items: [
        item({ id: 'a', planEstimate: 5, acceptedDate: new Date('2026-01-20T00:00:00Z') }),
        item({ id: 'b', planEstimate: 8, acceptedEquivalent: false, acceptedDate: null }),
      ],
    });
    expect(computeAverages([late]).trend).toBe(0);
  });

  it('is IDENTICAL with and without a Split placeholder in the bars (SU-09 9.3, AC3)', () => {
    /**
     * `computeAverages` reads `acceptedDuring` alone, so SU-09 needed no edit here — and 9.3 says to
     * assert that rather than trust it. The two windows are the same delivered history; the second
     * one also carries a 40-point placeholder in its middle bar, which is the largest number in the
     * set and would dominate every average if it leaked in.
     */
    const withoutPlaceholder = [36, 51, 43].map((v, i) =>
      buildBar({
        timeboxKey: `tb${i}`,
        name: `S${i}`,
        startDate: null,
        endDate: null,
        endBoundary: END,
        iterationCount: 1,
        items: [item({ id: `x${i}`, planEstimate: v })],
      }),
    );
    const withPlaceholder = [36, 51, 43].map((v, i) =>
      buildBar({
        timeboxKey: `tb${i}`,
        name: `S${i}`,
        startDate: null,
        endDate: null,
        endBoundary: END,
        iterationCount: 1,
        items:
          i === 1
            ? [item({ id: `x${i}`, planEstimate: v }), placeholder({ id: 'ph', planEstimate: 40 })]
            : [item({ id: `x${i}`, planEstimate: v })],
      }),
    );

    // The premise: the placeholder IS in the second set's bar, so this is not a comparison of two
    // identical inputs.
    expect(withPlaceholder[1].splitCarryover).toBe(40);
    expect(computeAverages(withPlaceholder)).toEqual(computeAverages(withoutPlaceholder));
  });
});

describe('selectWindow (§2, §7.6)', () => {
  it('keeps the most recent N of the ascending list', () => {
    const eligible = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ endDate: `2026-01-0${n}` }));
    expect(selectWindow(eligible, 5).map((e) => e.endDate)).toEqual([
      '2026-01-03',
      '2026-01-04',
      '2026-01-05',
      '2026-01-06',
      '2026-01-07',
    ]);
    expect(selectWindow(eligible, 10)).toHaveLength(7);
  });
});
