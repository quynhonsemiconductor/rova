/**
 * Test Cases tab column catalog (AC2's exact order): Select, Rank, ID, Name, Type, Method,
 * Priority, Owner, Last Verdict, Last Run.
 *
 * Widths fit the HEADER, not just the content — `label.length * 6.9 + 32`px is the floor
 * (CLAUDE.md), so `Last Verdict` needs ~130px. Name is a FIXED width with `break-words`, not
 * `grow: true`: `grow` widens the whole table to fit a long title instead of wrapping it inside
 * its own cell (CLAUDE.md — the same mistake Quality's Name column avoided).
 */
import { type ColumnSpec, rankColumn, RankCell } from '@/shared/ui/table'
import { OwnerCell } from '@/shared/ui/owner-cell'
import type { TestCase } from '../api'
import { VerdictBadge } from '../ui/verdict-badge'
import { TestCaseIdCell } from '../ui/test-case-id-cell'

export type TestCaseColKey =
  | 'select'
  | 'rank'
  | 'id'
  | 'name'
  | 'type'
  | 'method'
  | 'priority'
  | 'owner'
  | 'lastVerdict'
  | 'lastRun'

export interface TestCaseCtx {
  rowNum: (id: string) => number
  openTestCase: (testCaseKey: string) => void
}

const METHOD_LABEL: Record<TestCase['method'], string> = {
  manual: 'Manual',
  automated: 'Automated',
}

const PRIORITY_LABEL: Record<TestCase['priority'], string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
}

export function testCaseColumns(): ColumnSpec<TestCase, TestCaseCtx, TestCaseColKey>[] {
  return [
    {
      key: 'select',
      label: '',
      defaultWidth: 36,
      minWidth: 36,
      locked: true,
      // Phase A: the column renders (AC2 names it) but no bulk bar exists yet — the SRS names no
      // bulk verb for this tab (plan §8 Q5, a declared reading pending BA confirmation). An empty,
      // non-interactive cell keeps the column present without implying a control that does nothing.
      cell: () => null,
    },
    {
      ...rankColumn<TestCase, TestCaseCtx>(),
      cell: (row, ctx) => <RankCell rowNum={ctx.rowNum(row.id)} />,
    },
    {
      key: 'id',
      label: 'ID',
      sortCol: 'id',
      defaultWidth: 90,
      minWidth: 78,
      locked: true,
      cellClassName: 'overflow-hidden px-2',
      cell: (row, ctx) => (
        <TestCaseIdCell
          testCaseKey={row.testCaseKey}
          onOpen={() => ctx.openTestCase(row.testCaseKey)}
        />
      ),
    },
    {
      key: 'name',
      label: 'Name',
      sortCol: 'name',
      defaultWidth: 300,
      minWidth: 160,
      locked: true,
      cellClassName: 'min-w-0 px-2',
      cell: (row) => (
        <span className="block min-w-0 text-ui-md break-words whitespace-normal text-foreground">
          {row.name}
        </span>
      ),
    },
    {
      key: 'type',
      label: 'Type',
      sortCol: 'type',
      defaultWidth: 92,
      minWidth: 60,
      cellClassName: 'px-2',
      cell: (row) => <span className="text-ui-sm text-foreground">{row.type}</span>,
    },
    {
      key: 'method',
      label: 'Method',
      sortCol: 'method',
      defaultWidth: 92,
      minWidth: 73,
      cellClassName: 'px-2',
      cell: (row) => <span className="text-ui-sm text-foreground">{METHOD_LABEL[row.method]}</span>,
    },
    {
      key: 'priority',
      label: 'Priority',
      sortCol: 'priority',
      defaultWidth: 92,
      minWidth: 87,
      cellClassName: 'px-2',
      cell: (row) => (
        <span className="text-ui-sm text-foreground">{PRIORITY_LABEL[row.priority]}</span>
      ),
    },
    {
      key: 'owner',
      label: 'Owner',
      sortCol: 'owner',
      defaultWidth: 160,
      minWidth: 67,
      cellClassName: 'overflow-hidden px-2',
      // No `truncate`: this grid renders ONE person per row (unlike Quality's two), so the full
      // name wraps rather than clipping (CLAUDE.md's OwnerCell rule).
      cell: (row) => <OwnerCell name={row.ownerName} />,
    },
    {
      key: 'lastVerdict',
      label: 'Last Verdict',
      sortCol: 'lastVerdict',
      defaultWidth: 130,
      minWidth: 130,
      cellClassName: 'px-2',
      cell: (row) => <VerdictBadge verdict={row.lastVerdict} />,
    },
    {
      key: 'lastRun',
      label: 'Last Run',
      sortCol: 'lastRun',
      defaultWidth: 100,
      minWidth: 87,
      cellClassName: 'px-2',
      // Never `EMPTY_VALUE` here (BR10) — "Not run yet" is a different sentence from "unknown".
      cell: (row) => (
        <span className="text-ui-sm text-foreground">{row.lastRun ?? 'Not run yet'}</span>
      ),
    },
  ]
}
