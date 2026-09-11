import type { DbExecutor } from '@platform';
import type { TestCaseTypeOption } from './test-case.repository';

export const TEST_CASE_TYPE_REPOSITORY = Symbol('TEST_CASE_TYPE_REPOSITORY');

/** One catalog row, as stored — used by the write methods and the BR16 duplicate check. */
export interface TestCaseType {
  id: string;
  workspaceId: string;
  projectId: string;
  name: string;
  position: number;
  archivedAt: string | null;
}

export interface CreateTestCaseTypeInput {
  id: string;
  workspaceId: string;
  projectId: string;
  name: string;
  position: number;
}

/**
 * The Type catalog CRUD (SRS §3, D8), modelled on `ILabelRepository`. Soft-hide only —
 * `archive` never deletes a row, because `test_cases.type` is a text SNAPSHOT (D8) and a
 * historical Test Case must keep rendering its removed Type (BR17, AC17).
 *
 * No `includeArchived` read: BR17's union is resolved entirely on the CLIENT, from the row's
 * own snapshot `type` string — there is no FK to an archived row to look up (confirmed before
 * building this port; see the Detail page's `typeOptions` union). No separate "list for
 * management" read either: `listSelectable` is the ONE feed for both the Create modal's dropdown
 * and Settings' chip list (G4) — the plan names one `GET` route, and `TestCaseTypeOption` now
 * carries `position` so a single response serves both consumers.
 */
export interface ITestCaseTypeRepository {
  /** Live (non-archived) Types for one project, ordered for BR2's "first selectable" default. */
  listSelectable(projectId: string, workspaceId: string): Promise<TestCaseTypeOption[]>;

  /**
   * Case-insensitive lookup for BR16's pre-check — the SAME `lower(name)` comparison
   * `uq_test_case_types_name` enforces, over ALL rows (live or archived): the index carries no
   * `WHERE archived_at IS NULL` filter, so an archived name is not reusable at the DB level
   * either, and this lookup must agree or a caller gets a raw constraint violation instead of a
   * clean `TEST_CASE_TYPE_NAME_TAKEN`.
   */
  findByName(projectId: string, workspaceId: string, name: string): Promise<TestCaseType | null>;

  /** Next `position` for a new Type — appended after the highest existing one (live or archived). */
  nextPosition(projectId: string, workspaceId: string, executor?: DbExecutor): Promise<number>;

  create(input: CreateTestCaseTypeInput, executor?: DbExecutor): Promise<TestCaseType>;

  /** Soft-hide: sets `archived_at`. Scoped to (id, project, workspace) — never a bare id. */
  archive(
    id: string,
    projectId: string,
    workspaceId: string,
    executor?: DbExecutor,
  ): Promise<TestCaseType | null>;
}
