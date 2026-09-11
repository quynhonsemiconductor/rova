import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PageQuerySchema } from '@platform';

// No filters in Phase A — the tab loads one Work Item's Test Cases whole, in rank order (AC2).
export const TestCaseListQuerySchema = PageQuerySchema;

export class TestCaseListQueryDto extends createZodDto(TestCaseListQuerySchema) {}

/**
 * Create a Test Case under a Work Item (SRS §5).
 *
 * NO `projectId` / `teamId` / `workItemId` (BR5) — both are inherited from the Work Item in the
 * route path, read-only, and the contract does not advertise what the service refuses (the same
 * reasoning `CreateTaskSchema` uses for `iterationId`). NO content fields (description, objective,
 * preconditions, …) — BR1 says every content field starts blank on create; they are Phase C's.
 */
export const CreateTestCaseSchema = z.object({
  name: z.string().min(1).max(500).trim(),
  // Omitted = service defaults to the project's first selectable Type (BR2). A value is validated
  // against the project's live Type list, then stored as a text SNAPSHOT (D8).
  type: z.string().max(60).trim().optional(),
  method: z.enum(['manual', 'automated']).optional(), // BR3: schema default 'manual'
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(), // BR3: schema default 'normal'
  ownerId: z.string().uuid().optional(), // BR4/BR8: gated by ProjectsService.assertAssignable
  assigneeId: z.string().uuid().optional(), // BR6: absent = Unassigned
});

export class CreateTestCaseDto extends createZodDto(CreateTestCaseSchema) {}

/**
 * Edit a Test Case (SRS §6.3, Phase C).
 *
 * NO `projectId` / `teamId` / `workItemId` (BR5) — inherited at create, read-only forever; the
 * sidebar renders `Project backlog` for a null team rather than offering a picker. NO
 * `lastVerdict` / `lastRun` / `lastResultId` (BR9) — all three are maintained EXCLUSIVELY by
 * `trg_test_case_last_result` (D6); the contract does not advertise what the trigger owns, the
 * same reasoning `CreateTaskSchema` uses for `iterationId`. NO `rank` — reordering is
 * `PATCH /test-cases/:id/rank`, a separate neighbour-based route (F3). NO `testCaseKey` / `createdBy` /
 * timestamps / `id` / `workspaceId` — identity and audit columns are never patchable anywhere in
 * this codebase.
 *
 * `type` is re-validated against the project's live selectable Types UNLESS it equals the row's
 * OWN current value — BR17: a historical Type surviving its own removal must stay settable back
 * to itself (a no-op save must not become a refusal) without appearing in the live dropdown.
 */
export const UpdateTestCaseSchema = z.object({
  name: z.string().min(1).max(500).trim().optional(),
  description: z.string().nullable().optional(),
  objective: z.string().nullable().optional(),
  preconditions: z.string().nullable().optional(),
  validationInput: z.string().nullable().optional(),
  validationExpectedResult: z.string().nullable().optional(),
  postconditions: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  type: z.string().max(60).trim().optional(),
  method: z.enum(['manual', 'automated']).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  ownerId: z.string().uuid().nullable().optional(), // BR8: gated by ProjectsService.assertAssignable
  assigneeId: z.string().uuid().nullable().optional(), // BR8: same rule as ownerId
});

export class UpdateTestCaseDto extends createZodDto(UpdateTestCaseSchema) {}

// ── Reorder (rank drag, F3) ──────────────────────────────────────────────────

/**
 * `PATCH /test-cases/:id/rank` — a single-item NEIGHBOUR-based reorder, mirroring
 * `RankWorkItemSchema`/`WorkItemsService.rankWorkItem` exactly (the shape every other rank-drag
 * grid in this codebase already uses — Backlog, Quality's `useRankAnyWorkItem` — because
 * `useRowRerank`'s `onReorder` callback hands `{id, beforeId, afterId}`, not a full recomputed
 * rank list). `beforeId`/`afterId` are the rows immediately above/below the target's NEW position
 * (either may be absent at a list boundary); the service computes a LexoRank strictly between
 * their stored ranks with `between()` — a single-row UPDATE, no full re-numbering.
 */
export const RankTestCaseSchema = z.object({
  workItemId: z.string().uuid(),
  beforeId: z.string().uuid().nullable().optional(),
  afterId: z.string().uuid().nullable().optional(),
});

export class RankTestCaseDto extends createZodDto(RankTestCaseSchema) {}

// ── Type catalog (SRS §3, Phase G) ────────────────────────────────────────────

/**
 * `POST /projects/:id/test-case-types` (`workspace:edit`, Workspace-Admin-only). BR16: required,
 * trimmed, ≤60 chars — the service's own `findByName` pre-check (case-insensitive) is what
 * produces a clean `TEST_CASE_TYPE_NAME_TAKEN` instead of a raw `uq_test_case_types_name`
 * violation; this schema only enforces shape.
 */
export const CreateTestCaseTypeSchema = z.object({
  name: z.string().min(1).max(60).trim(),
});

export class CreateTestCaseTypeDto extends createZodDto(CreateTestCaseTypeSchema) {}
