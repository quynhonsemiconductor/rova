/**
 * Test Results tab column catalog (AC8's exact order): Build, Date, Work Product, Verdict,
 * Duration, Tester.
 *
 * Widths fit the HEADER (CLAUDE.md's floor: `label.length * 6.9 + 32`px). Build is the link to the
 * Result's own detail page (Phase E's E3, `/test-result/$testResultId`) — Phase D built the plain
 * text placeholder because no such page existed yet.
 */
import { Link } from '@tanstack/react-router'
import { type ColumnSpec } from '@/shared/ui/table'
import { formatDate, EMPTY_VALUE } from '@/shared/lib/utils'
import type { TestResult } from '../api'
import { VerdictBadge } from '../ui/verdict-badge'

export type TestResultColKey =
  'build' | 'runDate' | 'workProduct' | 'verdict' | 'duration' | 'tester'

export interface TestResultCtx {
  /** The Test Case's own Work Product item key — ONE value for the whole tab (BR13: every row's
   *  snapshot is this same Test Case's, since Phase D has no path that ever changes it). `null`
   *  when the Test Case carries no Work Item. */
  workItemKey: string | null
}

export function testResultColumns(): ColumnSpec<TestResult, TestResultCtx, TestResultColKey>[] {
  return [
    {
      key: 'build',
      label: 'Build',
      sortCol: 'build',
      defaultWidth: 160,
      minWidth: 96,
      locked: true,
      cellClassName: 'min-w-0 px-2',
      cell: (row) => (
        <Link
          to="/test-result/$testResultId"
          params={{ testResultId: row.id }}
          className="block min-w-0 truncate font-mono text-ui-md text-primary-light underline-offset-2 hover:underline"
        >
          {row.build}
        </Link>
      ),
    },
    {
      key: 'runDate',
      label: 'Date',
      sortCol: 'runDate',
      defaultWidth: 100,
      minWidth: 74,
      cellClassName: 'px-2',
      cell: (row) => (
        <span className="font-mono text-ui-sm text-foreground">{formatDate(row.runDate)}</span>
      ),
    },
    {
      key: 'workProduct',
      label: 'Work Product',
      defaultWidth: 130,
      minWidth: 130,
      cellClassName: 'px-2',
      cell: (_row, ctx) => (
        <span className="font-mono text-ui-sm text-foreground">
          {ctx.workItemKey ?? EMPTY_VALUE}
        </span>
      ),
    },
    {
      key: 'verdict',
      label: 'Verdict',
      sortCol: 'verdict',
      defaultWidth: 100,
      minWidth: 87,
      cellClassName: 'px-2',
      cell: (row) => <VerdictBadge verdict={row.verdict} />,
    },
    {
      key: 'duration',
      label: 'Duration',
      sortCol: 'durationMinutes',
      defaultWidth: 100,
      minWidth: 92,
      align: 'right',
      cellClassName: 'px-2',
      cell: (row) => (
        <span className="font-mono text-ui-sm text-foreground">{row.durationMinutes}m</span>
      ),
    },
    {
      key: 'tester',
      label: 'Tester',
      sortCol: 'testerName',
      defaultWidth: 150,
      minWidth: 79,
      cellClassName: 'overflow-hidden px-2',
      cell: (row) => (
        <span className="truncate text-ui-sm text-foreground">{row.testerName ?? EMPTY_VALUE}</span>
      ),
    },
  ]
}
