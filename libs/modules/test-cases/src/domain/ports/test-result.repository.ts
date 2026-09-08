import type { DbExecutor } from '@platform';
import type { TestResult } from '../test-result.types';

export const TEST_RESULT_REPOSITORY = Symbol('TEST_RESULT_REPOSITORY');

export interface CreateTestResultInput {
  id: string;
  workspaceId: string;
  projectId: string;
  testCaseId: string;
  /** Snapshotted from the Test Case's `workItemId` at create time (BR13) — see `TestResultsService.create`. */
  workItemId: string | null;
  testResultKey: string;
  build: string;
  runDate: string;
  verdict: 'pass' | 'fail' | 'blocked' | 'error' | 'inconclusive';
  durationMinutes: number;
  testerId: string;
  notes: string | null;
  createdBy: string;
}

/**
 * BR19/BR20 apply here exactly as on `ITestCaseRepository`: the boundary is
 * `TestCasesService.getById` in the CALLER, before any of these run — there is no scope
 * parameter on this port because a Result is only ever reached through its own Test Case, which
 * the caller has already authorised.
 */
export interface ITestResultRepository {
  /** Ordered `run_date desc, created_at desc, id desc` (BR14) — the existing `ix_test_results_case_run_date` index. */
  listByTestCase(testCaseId: string, workspaceId: string): Promise<TestResult[]>;
  findById(id: string, workspaceId: string): Promise<TestResult | null>;
  /** `MAX(existing)+1` for this workspace's `TR-<n>` keys (D4) — not atomic; the service retries once. */
  nextKeyNumber(workspaceId: string, executor?: DbExecutor): Promise<number>;
  create(input: CreateTestResultInput, executor: DbExecutor): Promise<TestResult>;
}
