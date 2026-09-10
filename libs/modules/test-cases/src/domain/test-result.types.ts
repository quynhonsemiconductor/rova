/**
 * Test Result domain types (Phase 7, Phase D). Append-only (BR12) — no `update`/`delete` shape
 * here; those are Phase E/F.
 */
import type { TestVerdict } from '../../../../../db/schema/enums';

/**
 * `not_run` is excluded here (enforced by `ck_test_results_verdict_not_not_run` in the DB) — a
 * Result records an outcome, never its absence (D6). `Exclude<TestVerdict, 'not_run'>` rather than
 * a hand-typed union (B1: derive from the Drizzle enum, never re-type it) — still the NARROWER of
 * `TestVerdict`'s two audiences: `test_cases.last_verdict` is the wider one and keeps `not_run`.
 */
export type TestResultVerdict = Exclude<TestVerdict, 'not_run'>;

export interface TestResult {
  id: string;
  workspaceId: string;
  projectId: string;
  testCaseId: string;
  /** SNAPSHOT of the Test Case's Work Product at result-entry time (BR13) — never re-derived. */
  workItemId: string | null;
  testResultKey: string;
  build: string;
  runDate: string;
  verdict: TestResultVerdict;
  durationMinutes: number;
  testerId: string;
  testerName: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
