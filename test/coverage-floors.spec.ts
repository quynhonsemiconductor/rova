/**
 * Unit tests for the coverage-drift checker.
 *
 * The checker is what stops the floors in `vitest.config.ts` from rotting, so a checker that
 * is quietly wrong looks exactly like floors that are fine. These tests are the only thing
 * distinguishing the two, which is why they cover the boundaries rather than one happy path.
 *
 * The checker runs against a real coverage report in `check:coverage-floors`, after
 * `test:cov` has produced one. It cannot run in this suite — this suite IS the thing being
 * measured, so there is no report yet when it executes.
 *
 * Ported from opshub's `test/coverage-floors.spec.ts` verbatim except for the final test,
 * which pins against rova's own `vitest.config.ts` instead of opshub's.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_SLACK,
  METRICS,
  floorsAboveActual,
  parseThresholds,
  staleFloors,
} from './coverage-floors';

const totals = (pcts: Partial<Record<string, number>>) =>
  Object.fromEntries(Object.entries(pcts).map(([k, pct]) => [k, { pct: pct! }]));

const ALL_METRICS = { lines: 50, statements: 50, functions: 50, branches: 50 };

describe('floorsAboveActual', () => {
  it('reports a floor set above measured coverage', () => {
    const drifts = floorsAboveActual({ lines: 60 }, totals({ lines: 50 }));
    expect(drifts).toEqual([{ metric: 'lines', floor: 60, actual: 50, slack: -10 }]);
  });

  it('says nothing when a floor exactly equals coverage', () => {
    // The boundary: equal is passing, not failing. vitest thresholds are `>=`.
    expect(floorsAboveActual({ lines: 50 }, totals({ lines: 50 }))).toEqual([]);
  });

  it('says nothing when floors sit below coverage', () => {
    expect(floorsAboveActual(ALL_METRICS, totals({ ...ALL_METRICS, lines: 51 }))).toEqual([]);
  });
});

describe('staleFloors', () => {
  it('reports a floor that has fallen far behind coverage', () => {
    const drifts = staleFloors({ lines: 15 }, totals({ lines: 22.22 }));
    expect(drifts).toEqual([{ metric: 'lines', floor: 15, actual: 22.22, slack: 7.22 }]);
  });

  it('tolerates slack up to and including the limit', () => {
    // Both boundaries, because an off-by-one here either fails every unrelated commit or
    // never fires at all.
    expect(staleFloors({ lines: 50 }, totals({ lines: 53 }), 3)).toEqual([]);
    expect(staleFloors({ lines: 50 }, totals({ lines: 53.01 }), 3)).toHaveLength(1);
  });

  it('does not report a floor that is above coverage as stale', () => {
    // That is the other function's job; reporting it here would double-count one problem.
    expect(staleFloors({ lines: 60 }, totals({ lines: 50 }))).toEqual([]);
  });

  it('checks every metric, not just the first', () => {
    const drifts = staleFloors(
      { lines: 10, statements: 10, functions: 10, branches: 10 },
      totals(ALL_METRICS),
    );
    expect(drifts.map((d) => d.metric).sort()).toEqual(
      ['branches', 'functions', 'lines', 'statements'].sort(),
    );
  });

  it('skips a metric missing from the report rather than reporting a 100-point drift', () => {
    // A renamed or absent metric is a config typo. Treating the absence as 0% would bury
    // the real drifts under a fabricated one.
    expect(staleFloors({ lines: 15 }, totals({ statements: 90 }))).toEqual([]);
  });

  it('skips a metric with no configured floor', () => {
    expect(staleFloors({}, totals({ lines: 90 }))).toEqual([]);
  });

  it('defaults to MAX_SLACK when no limit is given', () => {
    expect(staleFloors({ lines: 50 }, totals({ lines: 50 + MAX_SLACK }))).toEqual([]);
    expect(staleFloors({ lines: 50 }, totals({ lines: 50 + MAX_SLACK + 0.1 }))).toHaveLength(1);
  });
});

describe('parseThresholds', () => {
  it('reads the four metrics out of a config', () => {
    const source = `
      export default defineConfig({
        test: {
          coverage: {
            include: ['libs/**/*.ts'],
            thresholds: { lines: 21, functions: 14, branches: 17, statements: 21 },
          },
        },
      });`;
    expect(parseThresholds(source)).toEqual({
      lines: 21,
      functions: 14,
      branches: 17,
      statements: 21,
    });
  });

  it('ignores a thresholds-like block outside the coverage section', () => {
    // The config has other nested objects; anchoring on `coverage:` is what keeps this from
    // reading, say, a testTimeout block that happens to contain the word.
    const source = `
      export default defineConfig({
        test: {
          thresholds: { lines: 99 },
          coverage: { thresholds: { lines: 21 } },
        },
      });`;
    expect(parseThresholds(source).lines).toBe(21);
  });

  it('throws when there is no thresholds block at all', () => {
    // Loudly, not as an empty object — an empty object would make every check vacuously
    // pass, which is the failure mode this whole file exists to prevent.
    expect(() =>
      parseThresholds('export default defineConfig({ test: { coverage: {} } });'),
    ).toThrow(/thresholds/);
  });

  it('parses the REAL vitest.config.ts and finds every metric', () => {
    // Pins the parser against the actual file, so a reformat that breaks it fails here
    // rather than silently reducing the drift check to nothing.
    const source = readFileSync(join(__dirname, '..', 'vitest.config.ts'), 'utf8');
    const floors = parseThresholds(source);

    for (const metric of METRICS) {
      expect(floors[metric], `no ${metric} floor found in vitest.config.ts`).toBeTypeOf('number');
    }
  });
});
