import { type ColumnSpec } from '@/shared/ui/table'
import { type Iteration } from '@/features/iterations/api'

/**
 * Column descriptors for the Iterations grid — a single ColumnSpec[] consumed by
 * the shared `useDataTable` engine (resize / reorder / show-hide) and rendered
 * through `DataTableFrame`, replacing the hand-rolled flex-grid this page used to
 * carry (FRONTEND_COMPONENT_AUDIT §5.2). `id` is the leading identifier column
 * (a click-to-open key link), matching Iteration Status / real Rally.
 */
export type ColKey =
  'id' | 'name' | 'theme' | 'startDate' | 'endDate' | 'plannedVelocity' | 'taskEstimate' | 'state'

export const ITERATIONS_COLUMNS: ColumnSpec<Iteration, unknown, ColKey>[] = [
  { key: 'id', label: 'ID', defaultWidth: 84, minWidth: 60, locked: true },
  {
    key: 'name',
    label: 'Name',
    defaultWidth: 220,
    minWidth: 120,
    locked: true,
    grow: true,
    sortCol: 'name',
  },
  { key: 'theme', label: 'Theme', defaultWidth: 260, minWidth: 100, sortCol: 'theme' },
  { key: 'startDate', label: 'Start Date', defaultWidth: 130, minWidth: 90, sortCol: 'startDate' },
  { key: 'endDate', label: 'End Date', defaultWidth: 130, minWidth: 90, sortCol: 'endDate' },
  {
    key: 'plannedVelocity',
    label: 'Planned Velocity',
    defaultWidth: 130,
    minWidth: 80,
    align: 'right',
    sortCol: 'plannedVelocity',
  },
  {
    key: 'taskEstimate',
    label: 'Task Estimate',
    defaultWidth: 120,
    minWidth: 80,
    align: 'right',
    sortCol: 'taskEstimate',
  },
  { key: 'state', label: 'State', defaultWidth: 120, minWidth: 80, sortCol: 'state' },
]
