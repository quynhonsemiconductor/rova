/**
 * One draggable row on the Test Cases tab (F3). Mirrors Quality's `SortableItemRow` /
 * Backlog's inline `useSortable` shape: `useSortable` lives here (only the component that calls
 * it can own the activator ref), and the row hands its own grip to the Rank column's `actions`
 * slot via `dragHandle`.
 *
 * `useRerankSensors()` (pointer + KEYBOARD) is the sensor set the PARENT `<DndContext>` supplies —
 * a sensor alone would not be enough: dnd-kit's `KeyboardSensor` activates from the ACTIVATOR's own
 * `onKeyDown`, which only fires if `attributes` (role="button", tabIndex) are on the FOCUSABLE grip,
 * never on the row (CLAUDE.md — this exact mistake shipped on four other grids before being fixed
 * once, centrally, in `DragHandle`/`useRerankSensors`).
 */
import type { ReactNode } from 'react'
import { useSortable } from '@dnd-kit/sortable'

import { DragHandle } from '@/shared/ui/drag-handle'
import { TableRow, useDragRowStyle } from '@/shared/ui/table'

export function TestCaseRow({
  id,
  dragDisabled,
  children,
}: {
  id: string
  /** No grip: a reader without `test_case:edit`, or a column sort is active (rank order has no
   *  meaning once the grid is sorted by something else). */
  dragDisabled: boolean
  /** Receives this row's own grip, to place in the Rank column's `actions` slot. */
  children: (dragHandle: ReactNode) => ReactNode
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: dragDisabled })

  const style = useDragRowStyle({ transform, transition, isDragging })

  // `attributes` (role="button", tabIndex) go on the GRIP, alongside `listeners` — never on the
  // row. Rendered even when disabled: an inert, invisible spacer of the same width, so the columns
  // beside it never shift between a sortable state and a disabled one.
  const grip = (
    <DragHandle
      ref={setActivatorNodeRef}
      disabled={dragDisabled}
      {...(dragDisabled ? {} : { ...attributes, ...listeners })}
    />
  )

  return (
    <TableRow ref={setNodeRef} style={style} className="px-3 text-ui-md">
      {children(grip)}
    </TableRow>
  )
}
