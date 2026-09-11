/**
 * Test Results tab column catalog (AC8's exact order): Build, Date, Work Product, Verdict,
 * Duration, Tester.
 *
 * Layout ONLY (label/width/align/sortCol) — no `cell`. Verdict/Tester need a per-row mutation
 * (and Tester a per-row team-scoped options fetch), and a `ColumnSpec.cell` is a plain function
 * that cannot call hooks — `TestResultRow` hand-renders its own cells instead, the same shape
 * `TestCaseRow` / Tasks tab's `TaskRow` use.
 *
 * Widths fit the HEADER (CLAUDE.md's floor: `label.length * 6.9 + 32`px). Build is the link to the
 * Result's own detail page (Phase E's E3, `/test-result/$testResultId`).
 *
 * `duration` was `align: 'right'` — this grid's Duration is rendered TEXT ("45m"), not a
 * right-aligned numeric input the way Tasks tab's hour columns are, so it follows the text-left
 * default like every other column here. Every other column was checked against the same rule and
 * is already correct (Build/Date/Work Product/Verdict/Tester are all text/badge, left-aligned).
 */
import { type ColumnSpec } from '@/shared/ui/table'
import type { TestResult } from '../api'
import { TEST_VERDICT_STYLE } from '../status-colors'

export type TestResultColKey =
  'build' | 'runDate' | 'workProduct' | 'verdict' | 'duration' | 'tester'

/**
 * F1: the ONE verdict-label source, derived from `TEST_VERDICT_STYLE` (which already carries a
 * `label` per verdict, coupled to its badge colour — the same `TEAM_STATUS_STYLE` shape every
 * other status map in this app uses, hardcoded English by that same established convention, not
 * i18n). This was independently redeclared in 3 other files before F1; import it from here.
 */
export const VERDICT_LABEL: Record<TestResult['verdict'], string> = {
  pass: TEST_VERDICT_STYLE.pass.label,
  fail: TEST_VERDICT_STYLE.fail.label,
  blocked: TEST_VERDICT_STYLE.blocked.label,
  error: TEST_VERDICT_STYLE.error.label,
  inconclusive: TEST_VERDICT_STYLE.inconclusive.label,
}

export function testResultColumns(): ColumnSpec<TestResult, unknown, TestResultColKey>[] {
  return [
    {
      key: 'build',
      label: 'Build',
      sortCol: 'build',
      defaultWidth: 160,
      minWidth: 96,
      locked: true,
    },
    { key: 'runDate', label: 'Date', sortCol: 'runDate', defaultWidth: 100, minWidth: 74 },
    { key: 'workProduct', label: 'Work Product', defaultWidth: 130, minWidth: 130 },
    { key: 'verdict', label: 'Verdict', sortCol: 'verdict', defaultWidth: 100, minWidth: 87 },
    {
      key: 'duration',
      label: 'Duration',
      sortCol: 'durationMinutes',
      defaultWidth: 100,
      minWidth: 92,
    },
    { key: 'tester', label: 'Tester', sortCol: 'testerName', defaultWidth: 150, minWidth: 79 },
  ]
}
