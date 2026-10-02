/**
 * PanelTable — the small, fixed-column table that lives inside a dashboard CARD.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT `DataTableFrame`
 * ---------------------------------------------------
 * `DataTableFrame` is the shell for a full data GRID: it owns a scroll region, a sticky resizable
 * header, column drag-reorder, a Show-Fields menu, totals and pagination, and it takes its widths
 * from `useDataTable().colStyles`. A panel inside a card has none of that — no resize, no reorder,
 * no pagination — so adopting it there would mean synthesising a `colStyles` map and an `onResize`
 * for a table that can do neither. Home's two tables therefore hand-rolled their own chrome, and
 * that is exactly the drift this file closes: they are the same shape twice, so they get one
 * component, sized by ONE declaration per column.
 *
 * THE DEFECT IT FIXES
 * -------------------
 * Both tables laid columns out with `flex-1` on the Name column and fixed `w-*` classes on the
 * rest — but a flex item's default is `min-width: auto`, so `flex-1` cannot shrink below its own
 * content. A long project name therefore GREW past its share and pushed the fixed columns until
 * they ran out of room, at which point every remaining header wrapped: `OPEN DEFECTS` broke across
 * two lines, and the wrap changed the header's height while the body rows kept theirs. The header
 * labels wrapping is what a reader sees; the cause is one missing `min-w-0`.
 *
 * Widths are declared ONCE, in a `columns` array, and applied to the header and to every row
 * through the same {@link PanelTableCell} — so a header and its column cannot be given different
 * widths, which is how the two Home tables had already drifted apart from each other.
 */
import type { ReactNode } from 'react'

import { cn } from '@/shared/lib/utils'

export interface PanelTableColumn {
  /** Stable key — also the React key for the header cell. */
  key: string
  /** Header label. Rendered uppercase, like every other table heading in the app. */
  label: string
  /**
   * Fixed width in px. Omit for exactly ONE column, which then absorbs the remaining space.
   *
   * A fixed column is `shrink-0`, so it always gets its width; the flexible one is `min-w-0`, so it
   * yields instead of pushing. That pairing is the whole layout rule, and it is why these are
   * declared rather than passed as class strings — a caller writing `flex-1` without `min-w-0` is
   * the original bug, and there is no longer a place to write it.
   */
  width?: number
  /** Horizontal alignment of the header AND its cells. */
  align?: 'left' | 'right' | 'center'
}

const alignClass = (align: PanelTableColumn['align']) =>
  align === 'right' ? 'justify-end text-right' : align === 'center' ? 'justify-center' : ''

/** The width/shrink style a column contributes, shared by the header cell and every body cell. */
function cellStyle(col: PanelTableColumn) {
  return col.width === undefined
    ? // `min-w-0` is load-bearing: without it this column refuses to shrink below its content and
      // squeezes the fixed ones until their headers wrap.
      { flex: '1 1 0%', minWidth: 0 }
    : { width: col.width, flexShrink: 0 }
}

/**
 * One body cell. A row renders these in the SAME order as `columns`, so the two cannot disagree
 * about width — the caller supplies content, never geometry.
 */
export function PanelTableCell({
  column,
  className,
  children,
  ...rest
}: {
  column: PanelTableColumn
  className?: string
  children?: ReactNode
  // A cell occasionally has to stop a click reaching a clickable ROW (an actions column whose icons
  // act alone). The geometry stays the component's; the behaviour stays the caller's.
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'style' | 'className' | 'children'>) {
  return (
    <div
      {...rest}
      style={cellStyle(column)}
      className={cn('flex items-center', alignClass(column.align), className)}
    >
      {children}
    </div>
  )
}

export interface PanelTableProps {
  columns: PanelTableColumn[]
  /** Gap between columns, in the Tailwind scale used by the row. Header and rows share it. */
  gapClassName?: string
  /** Horizontal padding, applied to the header and expected on the rows. */
  padClassName?: string
  /** Body: the caller's own rows, or a single state node (empty / error). */
  children?: ReactNode
  className?: string
}

/**
 * Header + body. The caller renders rows with {@link PanelTableRow} so the geometry stays in one
 * place; states (empty, error) are passed as `children` too, since they replace the rows entirely.
 */
export function PanelTable({
  columns,
  gapClassName = 'gap-3',
  padClassName = 'px-4',
  children,
  className,
}: PanelTableProps) {
  return (
    <div className={cn('flex min-w-0 flex-col', className)}>
      <div
        className={cn(
          'flex h-7 items-center border-b border-border-subtle bg-surface-hover select-none',
          gapClassName,
          padClassName,
        )}
      >
        {columns.map((col) => (
          <div
            key={col.key}
            style={cellStyle(col)}
            className={cn(
              // `truncate`, so a heading that outgrows its column is clipped rather than wrapped:
              // a wrapped heading changes the header's height and stops it aligning with the rows
              // beneath it, which is the visible half of the defect above.
              'flex truncate text-ui-xs font-semibold tracking-widest text-foreground-subtle uppercase',
              alignClass(col.align),
            )}
            title={col.label}
          >
            {col.label}
          </div>
        ))}
      </div>
      {children}
    </div>
  )
}

/** One body row, matching the header's gap and padding. */
export function PanelTableRow({
  gapClassName = 'gap-3',
  padClassName = 'px-4',
  className,
  style,
  children,
  ...rest
}: {
  gapClassName?: string
  padClassName?: string
  className?: string
  style?: React.CSSProperties
  children?: ReactNode
  /** Forwarded to the row element (React 19 ref-as-prop) — e.g. a dnd-kit draggable node. */
  ref?: React.Ref<HTMLDivElement>
  // A row is often the click target that opens a record, so it takes the interaction props a
  // caller needs (`role`, `tabIndex`, `onClick`, `onKeyDown`). What it never takes is geometry.
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'style' | 'className' | 'children'>) {
  return (
    <div
      {...rest}
      style={style}
      className={cn(
        // `min-h-*` rather than a fixed height, so a cell that wraps grows the row instead of
        // being clipped by it.
        'flex min-h-9 items-center border-b border-border-inner transition-colors hover:bg-surface-hover',
        gapClassName,
        padClassName,
        className,
      )}
    >
      {children}
    </div>
  )
}
