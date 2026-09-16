#!/usr/bin/env node
/**
 * Report tests that only passed because Playwright retried them.
 *
 * `retries: 1` in CI is deliberate — a container blip or a cold first paint is not a product
 * defect. What was wrong is that the retry was invisible: a spec that failed and then passed
 * made `E2E (Playwright)` report SUCCESS, so five genuinely unstable specs sat behind a
 * permanently green required check. Same family as a skipped required check counting as passed:
 * the signal exists, nothing surfaces it.
 *
 * So this reads Playwright's JSON report and prints every test whose status is `flaky` —
 * Playwright's own word for "failed, then passed on a retry".
 *
 * It exits 0 on purpose. The specs are not stable yet, and E2E is a required check, so failing
 * here would block every merge. Once the list is empty, `--fail-on-flaky-tests` on the CI
 * command makes it impossible to regress — that flag is the ratchet, this script is the
 * instrument that tells us when we are allowed to set it.
 *
 * Usage: node scripts/report-flaky-e2e.mjs [path-to-report.json]
 */
import { readFileSync } from 'node:fs';

const reportPath = process.argv[2] ?? 'apps/web/playwright-results.json';

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (err) {
  // A missing report means the run died before writing one — the test step's own failure is
  // the story, and inventing a second one here would only bury it.
  console.log(`No Playwright report at ${reportPath} (${err.code ?? 'unreadable'}); nothing to report.`);
  process.exit(0);
}

/** Playwright nests suites arbitrarily deep; specs can hang off any level. */
function* specsOf(suite, trail = []) {
  const here = suite.title ? [...trail, suite.title] : trail;
  for (const spec of suite.specs ?? []) yield { spec, trail: here };
  for (const child of suite.suites ?? []) yield* specsOf(child, here);
}

const flaky = [];
for (const suite of report.suites ?? []) {
  for (const { spec, trail } of specsOf(suite)) {
    for (const test of spec.tests ?? []) {
      if (test.status !== 'flaky') continue;
      flaky.push({
        title: [...trail, spec.title].join(' › '),
        file: spec.file,
        line: spec.line,
        attempts: test.results?.length ?? 0,
      });
    }
  }
}

if (flaky.length === 0) {
  console.log('No flaky tests: nothing needed a retry.');
  console.log('If this holds, add `--fail-on-flaky-tests` to the E2E command to keep it that way.');
  process.exit(0);
}

// Annotations attach to the file and line in the Files-changed view, so the flake is visible
// on the PR that introduces it rather than only in a log nobody opens on a green run.
for (const t of flaky) {
  const where = t.file ? `file=${t.file},line=${t.line ?? 1}` : '';
  console.log(
    `::warning ${where}::Flaky: "${t.title}" failed then passed on retry ` +
      `(${t.attempts} attempts). The check is green only because of the retry.`,
  );
}

console.log(`\n${flaky.length} test(s) passed only on retry:`);
for (const t of flaky) console.log(`  ${t.file}:${t.line ?? '?'}  ${t.title}`);
process.exit(0);
