import type { ActivityDiffConfig } from '@modules/activity';

/**
 * Fields whose changes appear in a Test Case's Revision History (SRS §6, Phase C's C3).
 *
 * The seven content fields (`description`, `objective`, `preconditions`, `validationInput`,
 * `validationExpectedResult`, `postconditions`, `notes`) are declared as RICH TEXT so the logger
 * records that they changed without storing the body — the same rule `PORTFOLIO_ACTIVITY_CONFIG`
 * follows and the reason `activity_logs` never holds rich text: the history is a feed, not a
 * second copy of the document.
 *
 * Deliberately excluded: `rank` (reordering is not a content change), and `lastVerdict` /
 * `lastRun` / `lastResultId` (BR9 — trigger-maintained, never part of this write's diff; a Result
 * add/edit logs its own activity in Phase D).
 */
export const TEST_CASE_ACTIVITY_CONFIG: ActivityDiffConfig<Record<string, unknown>> = {
  fields: [
    'name',
    'description',
    'objective',
    'preconditions',
    'validationInput',
    'validationExpectedResult',
    'postconditions',
    'notes',
    'type',
    'method',
    'priority',
    'ownerId',
    'assigneeId',
  ],
  richText: [
    'description',
    'objective',
    'preconditions',
    'validationInput',
    'validationExpectedResult',
    'postconditions',
    'notes',
  ],
  action: () => 'test_case.updated',
};
