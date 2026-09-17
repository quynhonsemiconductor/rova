import type { CursorPayload, DbExecutor, PagedResult } from '@platform';
import type { TestCase } from '../test-case.types';
import type { TeamReadScope } from '../team-read-scope';
import type { TestCaseMethod, TestCasePriority } from '../../../../../../db/schema/enums';

export const TEST_CASE_REPOSITORY = Symbol('TEST_CASE_REPOSITORY');

/**
 * One (project, live Type) row — the Create modal's dropdown, BR2's "first selectable" source,
 * and (Phase G) the Settings chip list's row shape too, since both read the same `GET` route.
 * Lives here (not on `test-case-type.repository.ts`) because it predates the Type catalog's own
 * port (Phase B's stopgap) and both `TestCaseTypeOptionDto` and `ITestCaseTypeRepository.listSelectable`
 * still return this exact shape — moving it would be a pure rename with no behaviour change.
 */
export interface TestCaseTypeOption {
  id: string;
  name: string;
  position: number;
}

export interface CreateTestCaseInput {
  id: string;
  workspaceId: string;
  projectId: string;
  teamId: string | null;
  workItemId: string;
  testCaseKey: string;
  name: string;
  type: string;
  method: TestCaseMethod;
  priority: TestCasePriority;
  ownerId: string | null;
  assigneeId: string | null;
  rank: string;
  createdBy: string;
}

/**
 * Phase C's PATCH payload at the repository boundary — `undefined` means "leave the column
 * alone", `null` (where nullable) means "clear it". Deliberately the same field list as
 * `UpdateTestCaseSchema`: no `projectId`/`teamId`/`workItemId`/`lastVerdict`/`lastRun`/
 * `lastResultId`/`rank` ever reaches this port.
 */
export interface UpdateTestCaseInput {
  name?: string;
  description?: string | null;
  objective?: string | null;
  preconditions?: string | null;
  validationInput?: string | null;
  validationExpectedResult?: string | null;
  postconditions?: string | null;
  notes?: string | null;
  type?: string;
  method?: TestCaseMethod;
  priority?: TestCasePriority;
  ownerId?: string | null;
  assigneeId?: string | null;
}

/**
 * `scope` is REQUIRED on the LIST-shaped reads, structurally — see `team-read-scope.ts` for why
 * it is never applied as a predicate here. The real boundary is
 * `TestCasesService.requireReadable`, called before either of these; the parameter exists so a
 * future call site cannot forget to ask.
 *
 * `findById` / `findByKey` carry no scope parameter, matching `IWorkItemRepository.findById`: a
 * single-row lookup is checked by the CALLER immediately after loading (resolve the row, read its
 * `workItemId`, authorise that work item, then return or refuse) — there is no list to leak rows
 * from, and passing an unused scope here would be a null structural guard.
 */
export interface ITestCaseRepository {
  /** Ordered by rank (the tab's own order, AC2) — matches the `(work_item_id, rank)` index. */
  listByWorkItem(
    workItemId: string,
    workspaceId: string,
    args: { limit: number; cursor: CursorPayload | null },
    scope: TeamReadScope,
  ): Promise<PagedResult<TestCase>>;
  /** For the tab badge when it must render before the tab itself opens (A7 option b). */
  countByWorkItem(workItemId: string, workspaceId: string, scope: TeamReadScope): Promise<number>;
  findById(id: string, workspaceId: string): Promise<TestCase | null>;
  /** Keys are workspace-unique — resolves across the workspace, like `IWorkItemRepository.findByKey`. */
  findByKey(testCaseKey: string, workspaceId: string): Promise<TestCase | null>;

  // ── Writes (Phase B) ───────────────────────────────────────────────────────

  /** `MAX(existing)+1` for this workspace's `TC-<n>` keys (D4) — not atomic; the service retries once. */
  nextKeyNumber(workspaceId: string, executor?: DbExecutor): Promise<number>;
  /**
   * Serialise rank assignment for one Work Item's Test Case list (BR7: "after existing Test Cases
   * of the same Work Item"). Call this first, then {@link findMaxRank} with the SAME executor —
   * the read-modify-write shape every ranked create in this repo follows.
   */
  lockRankScope(workItemId: string, executor: DbExecutor): Promise<void>;
  /** Highest existing rank among this Work Item's live Test Cases. Null if none exist. */
  findMaxRank(
    workItemId: string,
    workspaceId: string,
    executor: DbExecutor,
  ): Promise<string | null>;
  create(input: CreateTestCaseInput, executor: DbExecutor): Promise<TestCase>;

  // ── Writes (Phase C) ────────────────────────────────────────────────────────

  /**
   * Column patch only — no rank, no team/project/work-item repointing. Returns the updated row.
   * `executor` defaults to the pool connection; the service passes `tx` so the write and its
   * activity log land in one transaction.
   */
  update(
    id: string,
    input: UpdateTestCaseInput,
    workspaceId: string,
    executor?: DbExecutor,
  ): Promise<TestCase>;

  // ── Writes (Phase F) ────────────────────────────────────────────────────────

  /**
   * Soft-delete ONE Test Case (F1). `test_results.test_case_id` carries `ON DELETE cascade`, but a
   * soft delete is an UPDATE of `deleted_at`, so that FK never fires (same reason
   * `work_item_id`/`work.tasks` carry none) — the caller must also soft-delete this row's Results
   * (see `softDeleteResultsByTestCase` on `ITestResultRepository`) in the SAME transaction. This
   * method touches ONLY `test_cases`.
   */
  softDelete(id: string, workspaceId: string, executor?: DbExecutor): Promise<void>;

  /**
   * All live Test Case ids under one Work Item — used by the F1/F4 cascade to soft-delete a Work
   * Item's Test Cases (and, via `softDeleteResultsByTestCase`, their Results) in one transaction.
   * Read-then-write rather than a single `UPDATE … RETURNING id`, so the same id list can also be
   * handed to the Results cascade without a second query.
   */
  listLiveIdsByWorkItem(
    workItemId: string,
    workspaceId: string,
    executor: DbExecutor,
  ): Promise<string[]>;

  /** Soft-delete every LIVE Test Case under one Work Item, one set-based UPDATE (F4's cascade). */
  softDeleteByWorkItem(
    workItemId: string,
    workspaceId: string,
    executor: DbExecutor,
  ): Promise<void>;

  /**
   * Neighbour lookup for the rank drag (F3) — mirrors `IWorkItemRepository.findByIds`. Only `id`
   * and `rank` are needed; the service resolves `between(low, high)` from the two returned ranks
   * and refuses a neighbour that does not belong to the same Work Item (`WORK_ITEM_PARENT_SCOPE_MISMATCH`).
   */
  findRanksByIds(
    ids: string[],
    workspaceId: string,
  ): Promise<Array<{ id: string; workItemId: string | null; rank: string }>>;

  /** Single-row rank UPDATE — the write half of the neighbour-based reorder (F3). */
  updateRank(id: string, rank: string, workspaceId: string, executor?: DbExecutor): Promise<void>;

  /**
   * Move a set of Test Cases' WORK PRODUCT to another Work Item — the Split write path's step 7
   * (SU-BR-19), and the only caller.
   *
   * **This port had no way to write `work_item_id` before SU-06, and that was deliberate rather than
   * an oversight:** `UpdateTestCaseInput` excludes it by design (its docblock says so), because the
   * Phase C PATCH must not let a client re-file a Test Case under another Story as a side effect of
   * editing its name. Split is a different verb with its own authorization, so it gets its own
   * method instead of a widened one — the same reasoning that keeps `split_id` out of every
   * `Update*` schema.
   *
   * `work_item_id` ONLY. `test_results.work_item_id` is a SNAPSHOT of the Work Product at
   * result-entry time and must not follow (plan D10, SU-BR-20), and
   * `trg_test_case_last_result` fires on `run_date, verdict, deleted_at, test_case_id` — not on
   * `work_item_id` — so `last_verdict`/`last_run` keep pointing at the newest Result by
   * construction. Both facts were verified against a live database in SU-05 5.3.
   *
   * Set-based: one UPDATE for the whole selection, inside the Split transaction.
   */
  reparentToWorkItem(
    ids: string[],
    workItemId: string,
    workspaceId: string,
    executor: DbExecutor,
  ): Promise<void>;
}
