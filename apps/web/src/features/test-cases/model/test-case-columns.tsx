/**
 * Test Cases tab column catalog (AC2's order): Rank, ID, Name, Type, Method, Priority, Owner,
 * Last Verdict, Last Run. Selection is the shared `RowGutter` leading gutter (grip + checkbox),
 * matching Tasks tab / Backlog / Quality / Iteration Status — not a declared column, so it is
 * never resizable, reorderable or hideable.
 *
 * Layout ONLY (label/width/align/sortCol) — no `cell`. Type/Method/Priority/Owner need a
 * per-row mutation and (for Owner) a per-row team-scoped options fetch, and a `ColumnSpec.cell`
 * is a plain function that cannot call hooks — the same reason Tasks tab's `TaskRow` hand-renders
 * its own cells instead of going through `useDataTable().renderCells`. `TestCaseRow` is this
 * grid's equivalent; this file only supplies `useDataTable` with what it needs for the header,
 * `colStyles` and click-to-sort.
 *
 * Widths fit the HEADER, not just the content — `label.length * 6.9 + 32`px is the floor
 * (CLAUDE.md), so `Last Verdict` needs ~130px. Name is a FIXED width with `break-words`, not
 * `grow: true`: `grow` widens the whole table to fit a long title instead of wrapping it inside
 * its own cell (CLAUDE.md — the same mistake Quality's Name column avoided).
 */
import { type ColumnSpec, rankColumn } from '@/shared/ui/table'
import type { TestCase } from '../api'

export type TestCaseColKey =
  'rank' | 'id' | 'name' | 'type' | 'method' | 'priority' | 'owner' | 'lastVerdict' | 'lastRun'

export const METHOD_LABEL: Record<TestCase['method'], string> = {
  manual: 'Manual',
  automated: 'Automated',
}

export const PRIORITY_LABEL: Record<TestCase['priority'], string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
}

export function testCaseColumns(): ColumnSpec<TestCase, unknown, TestCaseColKey>[] {
  return [
    rankColumn<TestCase, unknown>(),
    { key: 'id', label: 'ID', sortCol: 'id', defaultWidth: 90, minWidth: 78, locked: true },
    {
      key: 'name',
      label: 'Name',
      sortCol: 'name',
      defaultWidth: 300,
      minWidth: 160,
      locked: true,
    },
    // 92px was sized to the 4-char HEADER label, not the DATA — Type values are catalog names
    // ("Acceptance", "Performance", "Regression", plus whatever a project adds), and every one
    // past ~7 characters truncated ("Functi…"). 130px matches Tasks tab's similarly enum-valued
    // `state`/`owner` columns (132/150px) rather than a guessed number.
    { key: 'type', label: 'Type', sortCol: 'type', defaultWidth: 130, minWidth: 90 },
    { key: 'method', label: 'Method', sortCol: 'method', defaultWidth: 92, minWidth: 73 },
    { key: 'priority', label: 'Priority', sortCol: 'priority', defaultWidth: 92, minWidth: 87 },
    { key: 'owner', label: 'Owner', sortCol: 'owner', defaultWidth: 160, minWidth: 67 },
    {
      key: 'lastVerdict',
      label: 'Last Verdict',
      sortCol: 'lastVerdict',
      defaultWidth: 130,
      minWidth: 130,
    },
    { key: 'lastRun', label: 'Last Run', sortCol: 'lastRun', defaultWidth: 100, minWidth: 87 },
  ]
}
