import type { ActivityDiffConfig } from '@modules/activity';

/**
 * Fields whose changes appear in a Test Result's Revision History (SRS §9, Phase E's E2).
 *
 * Modelled directly on `TEST_CASE_ACTIVITY_CONFIG`: scalar values only. `notes` is free text like
 * a Test Case's content fields, so it is declared `richText` — the logger records a bounded
 * plain-text preview of each side, never the markup or the whole body (DE-18: it used to record
 * neither, so US-97 TC-37 read "Notes changed from (empty) to (empty)").
 *
 * Deliberately excluded: `testCaseId` / `workItemId` (BR13 — read-only, never part of this
 * write's diff at all, `UpdateTestResultSchema` omits them).
 */
export const TEST_RESULT_ACTIVITY_CONFIG: ActivityDiffConfig<Record<string, unknown>> = {
  fields: ['build', 'runDate', 'verdict', 'durationMinutes', 'testerId', 'notes'],
  richText: ['notes'],
  action: () => 'test_result.updated',
};
