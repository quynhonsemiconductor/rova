import type { CursorPayload, PagedResult } from '@platform';
import type { TestCase } from '../test-case.types';
import type { TeamReadScope } from '../team-read-scope';

export const TEST_CASE_REPOSITORY = Symbol('TEST_CASE_REPOSITORY');

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
}
