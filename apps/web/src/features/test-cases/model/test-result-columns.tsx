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

export type TestResultColKey =
  'build' | 'runDate' | 'workProduct' | 'verdict' | 'duration' | 'tester'

export const VERDICT_LABEL: Record<TestResult['verdict'], string> = {
  pass: 'Pass',
  fail: 'Fail',
  blocked: 'Blocked',
  error: 'Error',
  inconclusive: 'Inconclusive',
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
