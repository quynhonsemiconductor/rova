import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { testVerdictEnum } from '../../../../../../../db/schema/enums';
import type { TestResult } from '../../../domain/test-result.types';

// Derived, `not_run` filtered (B1) — same reasoning as test-result-request.dto.ts.
const TEST_RESULT_VERDICTS = testVerdictEnum.enumValues.filter((v) => v !== 'not_run');

export const TestResultResponseSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  projectId: z.string().uuid(),
  testCaseId: z.string().uuid(),
  workItemId: z
    .string()
    .uuid()
    .nullable()
    .describe('SNAPSHOT of the Test Case Work Product at result-entry time (BR13).'),
  testResultKey: z.string().describe('TR-<n>, workspace-unique'),
  build: z.string(),
  runDate: z.string().describe('YYYY-MM-DD'),
  verdict: z.enum(TEST_RESULT_VERDICTS),
  durationMinutes: z.number().int(),
  testerId: z.string().uuid(),
  testerName: z.string().nullable(),
  notes: z.string().nullable(),
  createdBy: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export class TestResultResponseDto extends createZodDto(TestResultResponseSchema) {}

export function toTestResultDto(tr: TestResult): TestResultResponseDto {
  return {
    id: tr.id,
    workspaceId: tr.workspaceId,
    projectId: tr.projectId,
    testCaseId: tr.testCaseId,
    workItemId: tr.workItemId,
    testResultKey: tr.testResultKey,
    build: tr.build,
    runDate: tr.runDate,
    verdict: tr.verdict,
    durationMinutes: tr.durationMinutes,
    testerId: tr.testerId,
    testerName: tr.testerName,
    notes: tr.notes,
    createdBy: tr.createdBy,
    createdAt: tr.createdAt,
    updatedAt: tr.updatedAt,
  };
}
