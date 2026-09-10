/**
 * Test Case domain types (Phase 7, Phase A — read path only).
 */
import type { TestCaseMethod, TestCasePriority, TestVerdict } from '../../../../../db/schema/enums';

export interface TestCase {
  id: string;
  workspaceId: string;
  projectId: string;
  /** NULL = "Project backlog" (SRS §5) — inherited from the Work Item, read-only. */
  teamId: string | null;
  /** NULLABLE (D2) — Phase A exposes only the work-item-scoped routes. */
  workItemId: string | null;
  testCaseKey: string;
  name: string;
  description: string | null;
  objective: string | null;
  preconditions: string | null;
  validationInput: string | null;
  validationExpectedResult: string | null;
  postconditions: string | null;
  notes: string | null;
  /** Text SNAPSHOT of the Type name (D8, BR2) — survives the Type being removed later. */
  type: string;
  method: TestCaseMethod;
  priority: TestCasePriority;
  ownerId: string | null;
  ownerName: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  rank: string;
  /** Maintained by `trg_test_case_last_result` (D6) — never written by the service. */
  lastVerdict: TestVerdict | null;
  lastRun: string | null;
  lastResultId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
