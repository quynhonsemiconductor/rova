import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { testVerdictEnum } from '../../../../../../../db/schema/enums';

// Derived from the Drizzle enum with `not_run` filtered out (B1) — a Result records an outcome,
// never its absence (D6). Filtering here, rather than a second enum, is exactly what stops the
// two audiences of `testVerdictEnum` (a Test Case's `lastVerdict` vs a Result's own `verdict`)
// from silently drifting apart; see the enum's own docblock in db/schema/enums.ts.
const TEST_RESULT_VERDICTS = testVerdictEnum.enumValues.filter((v) => v !== 'not_run');

/**
 * Add a Test Result (SRS §8). NO `testCaseId` / `workItemId` (BR13) — both are inherited from the
 * route path / the Test Case's own current state at create time, read-only forever; the contract
 * does not advertise what the service refuses, the same reasoning `CreateTestCaseSchema` uses for
 * `projectId`/`teamId`/`workItemId`.
 */
export const CreateTestResultSchema = z.object({
  build: z.string().min(1).max(255).trim(), // BR11: required
  runDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // BR11: required, date-only
  verdict: z.enum(TEST_RESULT_VERDICTS), // not_run excluded (D6)
  durationMinutes: z.number().int().min(0).optional(), // BR11: >= 0; schema default 0
  testerId: z.string().uuid(), // BR11: required; BR8 gated by ProjectsService.assertAssignable
  notes: z.string().max(4000).optional(),
});

export class CreateTestResultDto extends createZodDto(CreateTestResultSchema) {}

/**
 * Edit a Test Result (SRS §9, Phase E). NO `testCaseId` / `workItemId` (BR13) — both are
 * read-only forever, the same reasoning `CreateTestResultSchema` uses for the same two fields:
 * Test Case is fixed at creation and Work Product is a SNAPSHOT taken then, never re-derived.
 * NO `testResultKey` / `createdBy` / timestamps / `id` / `workspaceId` / `projectId` — identity
 * and audit columns are never patchable anywhere in this codebase.
 *
 * `verdict` stays non-nullable when present — a Result records an outcome, never its absence
 * (D6's `not_run` exclusion applies here too); only `notes` may be cleared to `null`.
 */
export const UpdateTestResultSchema = z.object({
  build: z.string().min(1).max(255).trim().optional(),
  runDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  verdict: z.enum(TEST_RESULT_VERDICTS).optional(),
  durationMinutes: z.number().int().min(0).optional(), // BR11: >= 0 on edit too, not just create
  testerId: z.string().uuid().optional(), // BR8: gated by ProjectsService.assertAssignable when changing
  notes: z.string().max(4000).nullable().optional(),
});

export class UpdateTestResultDto extends createZodDto(UpdateTestResultSchema) {}
