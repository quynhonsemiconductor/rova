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
