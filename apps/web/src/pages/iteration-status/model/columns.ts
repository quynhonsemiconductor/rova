import {
  RANK_COLUMN_MIN_WIDTH,
  RANK_COLUMN_WIDTH,
  type ColumnSpec,
  type DataTableHeaderColumn,
} from '@/shared/ui/table'

export type ColKey =
  | 'rank'
  | 'id'
  | 'name'
  | 'feature'
  | 'iteration'
  | 'startDate'
  | 'targetEndDate'
  | 'state'
  | 'flowState'
  | 'block'
  | 'blockedReason'
  | 'planEstimate'
  | 'taskEstimate'
  | 'toDo'
  | 'tasksPct'
  | 'actual'
  | 'owner'
  | 'milestones'
  | 'devOwner'

export const ITERATION_STATUS_COLUMNS: ColumnSpec<unknown, unknown, ColKey>[] = [
  { key: 'rank', label: 'Rank', defaultWidth: RANK_COLUMN_WIDTH, minWidth: RANK_COLUMN_MIN_WIDTH },
  { key: 'id', label: 'ID', defaultWidth: 132, minWidth: 120 },
  { key: 'name', label: 'Name', defaultWidth: 240, minWidth: 150 },
  { key: 'feature', label: 'Feature', defaultWidth: 200, minWidth: 120 },
  { key: 'iteration', label: 'Iteration', defaultWidth: 160, minWidth: 120 },
  // Phase 7 CO-01 — the Story's system-managed first In-Progress date, read-only.
  { key: 'startDate', label: 'Start Date', defaultWidth: 108, minWidth: 96 },
  // Phase 7 CO-03 — the Story's Target End Date, read-only here (edited on Story Detail).
  { key: 'targetEndDate', label: 'Target End', defaultWidth: 108, minWidth: 96 },
  { key: 'state', label: 'Schedule State', defaultWidth: 132, minWidth: 132 },
  { key: 'flowState', label: 'Flow State', defaultWidth: 132, minWidth: 120 },
  // 60px fitted the CONTENT (one status glyph) but not the HEADER: 'Block' plus its sort caret
  // and the cell padding truncated to 'Bl...', so the column announced itself as an ellipsis.
  { key: 'block', label: 'Block', defaultWidth: 84, minWidth: 76 },
  { key: 'blockedReason', label: 'Blocked Reason', defaultWidth: 160, minWidth: 100 },
  { key: 'planEstimate', label: 'Plan Estimate', defaultWidth: 124 },
  { key: 'taskEstimate', label: 'Task Estimate', defaultWidth: 124 },
  { key: 'toDo', label: 'To Do', defaultWidth: 70 },
  { key: 'tasksPct', label: 'Tasks', defaultWidth: 110, minWidth: 80 },
  { key: 'actual', label: 'Actual', defaultWidth: 70 },
  { key: 'owner', label: 'Owner', defaultWidth: 130 },
  { key: 'milestones', label: 'Milestones', defaultWidth: 140, minWidth: 90 },
  { key: 'devOwner', label: 'Dev Owner', defaultWidth: 130 },
]

// Sticky-header column metadata (labels + sort keys + alignment) for the grid
// header. Shared by the page (headerProps) and the chrome Toolbar's DataTableHeader.
export const HEADER_META: DataTableHeaderColumn<ColKey>[] = [
  // Right, matching the shared rank column: a number read down a column only lines up if
  // the cells share an edge. This was centred and the digits wandered.
  { key: 'rank', label: 'Rank', sortCol: 'rank', align: 'right' },
  { key: 'id', label: 'ID', sortCol: 'id' },
  { key: 'name', label: 'Name', sortCol: 'name' },
  { key: 'feature', label: 'Feature' },
  { key: 'iteration', label: 'Iteration' },
  { key: 'startDate', label: 'Start Date' },
  { key: 'targetEndDate', label: 'Target End' },
  { key: 'state', label: 'Schedule State', sortCol: 'scheduleState' },
  { key: 'flowState', label: 'Flow State', sortCol: 'flowState' },
  { key: 'block', label: 'Block', sortCol: 'block', align: 'center' },
  { key: 'blockedReason', label: 'Blocked Reason' },
  { key: 'planEstimate', label: 'Plan Est', sortCol: 'planEstimate', align: 'right' },
  { key: 'taskEstimate', label: 'Task Est', sortCol: 'taskEstimate', align: 'right' },
  { key: 'toDo', label: 'To Do', sortCol: 'toDo', align: 'right' },
  { key: 'tasksPct', label: 'Tasks' },
  { key: 'actual', label: 'Actual', align: 'right' },
  { key: 'owner', label: 'Owner', sortCol: 'owner' },
  { key: 'milestones', label: 'Milestones' },
  { key: 'devOwner', label: 'Dev Owner', sortCol: 'devOwner' },
]
