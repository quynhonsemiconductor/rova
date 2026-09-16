import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Which Terraform files filter on a log field the application emits?
 *
 * Two specs assert this coupling — `fail-open.spec.ts` and `abstract-outbox-relay.spec.ts` —
 * because in both cases an alarm is defined in Terraform against a field name defined in
 * TypeScript, and nothing connects the two. Rename either side and the alarm silently stops
 * firing: the app still logs, the metric filter still exists, and it matches nothing forever.
 *
 * Both used to shell out to `grep -rl --include=*.tf --exclude-dir=.terraform`. That works on
 * the runners and fails on Windows, which is worse than it sounds — a guard that throws
 * ENOENT on a contributor's machine has never guarded anything for them, and the whole point
 * of these two tests is to fail at the moment someone edits one side of the coupling.
 *
 * Searching the tree rather than naming a file is deliberate and predates this helper: the
 * filters used to live in each `live/<env>/main.tf` and moved into `modules/stack` when the
 * two environments were de-duplicated. Asserting on a path would have to be edited every time
 * the Terraform is reorganised, which is how a guard quietly stops guarding.
 */

/** Repo-root `infra/`. This file is `test/helpers/`, so two levels up. */
const INFRA_ROOT = join(__dirname, '..', '..', 'infra');

/**
 * `.terraform` holds cached provider binaries and vendored module copies. Skipping it is not
 * an optimisation: scanning them took long enough to blow the test timeout.
 */
const SKIP_DIRS = new Set(['.terraform']);

function* terraformFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* terraformFiles(join(dir, entry.name));
    } else if (entry.name.endsWith('.tf')) {
      yield join(dir, entry.name);
    }
  }
}

/**
 * Terraform files containing a CloudWatch-style JSON selector for `field`.
 *
 * Matches the literal `$.<field>`, which is stricter than the `grep` it replaces: without
 * `-F`, grep read `$.` as a regex, so the `.` matched any character and `$.securityFailOpen`
 * would also have accepted `$XsecurityFailOpen`. Nothing exploited that, but the looser
 * pattern was never the intent.
 *
 * Returns [] when nothing matches — callers assert on that, so the failure is the point.
 * A MISSING `infra/` throws instead, because "the directory moved" and "the filter is gone"
 * are different problems and should not produce the same message.
 */
export function terraformFilesFilteringOn(field: string): string[] {
  if (!existsSync(INFRA_ROOT)) {
    throw new Error(
      `Expected Terraform under ${INFRA_ROOT}, but the directory does not exist. ` +
        `If infra/ moved, update INFRA_ROOT in test/helpers/terraform-filters.ts — ` +
        `do not delete the guards that depend on it.`,
    );
  }
  const selector = `$.${field}`;
  return [...terraformFiles(INFRA_ROOT)].filter((file) =>
    readFileSync(file, 'utf8').includes(selector),
  );
}
