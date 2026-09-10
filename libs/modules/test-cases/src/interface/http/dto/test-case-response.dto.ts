import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { TestCase } from '../../../domain/test-case.types';
import type { TestCaseTypeOption } from '../../../domain/ports/test-case.repository';

export const TestCaseResponseSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  projectId: z.string().uuid(),
  teamId: z.string().uuid().nullable().describe('NULL = "Project backlog" (SRS §5).'),
  workItemId: z.string().uuid().nullable(),
  testCaseKey: z.string().describe('TC-<n>, workspace-unique'),
  name: z.string(),
  description: z.string().nullable(),
  objective: z.string().nullable(),
  preconditions: z.string().nullable(),
  validationInput: z.string().nullable(),
  validationExpectedResult: z.string().nullable(),
  postconditions: z.string().nullable(),
  notes: z.string().nullable(),
  type: z.string().describe('Text snapshot of the Type name at the time it was set (D8, BR2).'),
  method: z.enum(['manual', 'automated']),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  ownerId: z.string().uuid().nullable(),
  ownerName: z.string().nullable(),
  assigneeId: z.string().uuid().nullable(),
  assigneeName: z.string().nullable(),
  rank: z.string(),
  lastVerdict: z
    .enum(['pass', 'fail', 'blocked', 'error', 'inconclusive', 'not_run'])
    .nullable()
    .describe('Maintained by trg_test_case_last_result (D6). NULL renders "Not Run" (BR10).'),
  lastRun: z.string().nullable().describe('YYYY-MM-DD. NULL renders "Not run yet" (BR10).'),
  lastResultId: z.string().uuid().nullable(),
  createdBy: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export class TestCaseResponseDto extends createZodDto(TestCaseResponseSchema) {}

export function toTestCaseDto(tc: TestCase): TestCaseResponseDto {
  return {
    id: tc.id,
    workspaceId: tc.workspaceId,
    projectId: tc.projectId,
    teamId: tc.teamId,
    workItemId: tc.workItemId,
    testCaseKey: tc.testCaseKey,
    name: tc.name,
    description: tc.description,
    objective: tc.objective,
    preconditions: tc.preconditions,
    validationInput: tc.validationInput,
    validationExpectedResult: tc.validationExpectedResult,
    postconditions: tc.postconditions,
    notes: tc.notes,
    type: tc.type,
    method: tc.method,
    priority: tc.priority,
    ownerId: tc.ownerId,
    ownerName: tc.ownerName,
    assigneeId: tc.assigneeId,
    assigneeName: tc.assigneeName,
    rank: tc.rank,
    lastVerdict: tc.lastVerdict,
    lastRun: tc.lastRun,
    lastResultId: tc.lastResultId,
    createdBy: tc.createdBy,
    createdAt: tc.createdAt,
    updatedAt: tc.updatedAt,
  };
}

/** One live Type — the Create modal's dropdown feed. Minimal shape; Type CRUD itself is Phase G. */
export const TestCaseTypeOptionSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
});

export class TestCaseTypeOptionDto extends createZodDto(TestCaseTypeOptionSchema) {}

export function toTestCaseTypeOptionDto(t: TestCaseTypeOption): TestCaseTypeOptionDto {
  return { id: t.id, name: t.name };
}
