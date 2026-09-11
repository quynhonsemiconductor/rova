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
 * Phase E's PATCH payload at the repository boundary — `undefined` means "leave the column
 * alone", `null` (where nullable) means "clear it". Deliberately the same field list as
 * `UpdateTestResultSchema`: no `testCaseId`/`workItemId` ever reaches this port (BR13).
 */
export interface UpdateTestResultInput {
  build?: string;
  runDate?: string;
  verdict?: 'pass' | 'fail' | 'blocked' | 'error' | 'inconclusive';
  durationMinutes?: number;
  testerId?: string;
  notes?: string | null;
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

  // ── Writes (Phase E) ────────────────────────────────────────────────────────

  /**
   * Column patch only. Updating `runDate`/`verdict`/`deletedAt` is what `trg_test_case_last_result`
   * fires on (D6's UPDATE branch) — this method never touches the parent Test Case's columns
   * itself, the trigger does. `executor` defaults to the pool connection; the service passes `tx`
   * so the write and its activity log land in one transaction.
   */
  update(
    id: string,
    input: UpdateTestResultInput,
    workspaceId: string,
    executor?: DbExecutor,
  ): Promise<TestResult>;
  /** Soft delete (`deleted_at`) — also fires the trigger's UPDATE branch. */
  softDelete(id: string, workspaceId: string, executor?: DbExecutor): Promise<void>;
}
