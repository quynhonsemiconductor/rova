/**
 * Compare the coverage floors in `vitest.config.ts` against the coverage actually measured.
 *
 * Run by `pnpm check:coverage-floors`, AFTER `pnpm test:cov` has written
 * `coverage/coverage-summary.json`. It cannot be a normal spec: this repo's own unit suite is
 * the thing being measured, so at the time the suite runs there is no report to read.
 *
 * Ported from opshub's `test/check-coverage-floors.ts` — see `coverage-floors.ts` for why
 * rova needs this too (rova/CLAUDE.md's "Coverage is a ratchet, not a target" section
 * documents having been burned by exactly this drift once already, caught only by hand).
 *
 * The comparison logic lives in `coverage-floors.ts` and is unit-tested — a drift check that
 * is quietly wrong looks exactly like floors that are fine.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_SLACK,
  floorsAboveActual,
  parseThresholds,
  staleFloors,
  type CoverageTotals,
  type Drift,
} from './coverage-floors';

const ROOT = join(__dirname, '..');
const SUMMARY = join(ROOT, 'coverage', 'coverage-summary.json');

function describeDrift(d: Drift): string {
  return `  ${d.metric.padEnd(11)} floor ${String(d.floor).padStart(6)}   actual ${String(
    d.actual,
  ).padStart(6)}   slack ${d.slack > 0 ? '+' : ''}${d.slack}`;
}

function main(): void {
  if (!existsSync(SUMMARY)) {
    // Exit non-zero. A missing report means `test:cov` did not run, did not emit
    // `json-summary`, or wrote elsewhere — and skipping quietly would turn this check into
    // exactly the kind of gate that passes while testing nothing.
    console.error(
      `No coverage summary at ${SUMMARY}.\n` +
        `Run \`pnpm test:cov\` first, and make sure 'json-summary' is in the coverage ` +
        `reporter list in vitest.config.ts.`,
    );
    process.exit(1);
  }

  const totals = (JSON.parse(readFileSync(SUMMARY, 'utf8')) as { total: CoverageTotals }).total;
  const floors = parseThresholds(readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8'));

  const tooHigh = floorsAboveActual(floors, totals);
  if (tooHigh.length > 0) {
    console.error(
      `Coverage floors are set ABOVE measured coverage, so the suite cannot pass:\n` +
        tooHigh.map(describeDrift).join('\n'),
    );
    process.exit(1);
  }

  const stale = staleFloors(floors, totals);
  if (stale.length > 0) {
    console.error(
      `Coverage floors have fallen more than ${MAX_SLACK} points behind actual coverage, ` +
        `so they no longer protect anything — a large regression would still pass.\n` +
        stale.map(describeDrift).join('\n') +
        `\n\nRaise them in vitest.config.ts to just under the actual values. This is the ` +
        `"raise as suites are added" rule the config asks for, enforced.`,
    );
    process.exit(1);
  }

  console.log(`Coverage floors are within ${MAX_SLACK} points of actual coverage.`);
}

main();
