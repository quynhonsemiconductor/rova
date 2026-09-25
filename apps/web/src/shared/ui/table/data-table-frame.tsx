/**
 * DataTableFrame — the single, shared *shell* for every data-grid page.
 *
 * Why this exists
 * ---------------
 * We already shared the grid *engine* (`useDataTable`) and the *header*
 * (`DataTableHeader`), but every page still hand-assembled the surrounding
 * chrome — the scroll container, the leading gutter, the totals row, the
 * loading/error/empty states and the pagination footer. Three different call
 * conventions grew up (some pages spread `{...table.headerProps}`, some put the
 * header inside the scroll region, some outside), so the tables visibly drifted
 * apart even though they shared the header.
 *
 * This component owns that chrome so it can never drift again. A page supplies:
 *   - `header`   → spread of `useDataTable().headerProps`
 *   - `leading`  → the SAME gutter node its body rows render (keeps columns
 *                  aligned across header / totals / rows)
 *   - `totals`   → an optional <TableTotalsRow>
 *   - `loading` / `error` / `empty` → declarative body states
 *   - `children` → the body rows (page-specific — grouped, DnD, inline-edit…)
 *   - `footer`   → an optional <PaginationFooter>
 *
 * Structure is fixed: one horizontal+vertical scroll region containing a
 * vertically-sticky header, the totals row, then the body; the footer sits
 * below the scroll region. Every table that uses this frame gets identical
 * chrome, scroll behaviour and state handling for free.
 *
 * Table *kinds* (feature policy, applied by callers)
 * --------------------------------------------------
 *   - Editable planning grids (Backlog, Quality, Iteration Status, Tasks tab):
 *     pass a selection/drag `leading` gutter + `sort` + `totals`.
 *   - Read-only reports / lists (Team Status, Releases, Projects, Milestones):
 *     pass `sort` + `totals` where numbers aggregate; no selection/drag gutter.
 * The frame does not force a feature set — it guarantees that whatever a page
 * uses is laid out identically to every other page.
 */
import type { CSSProperties, ReactNode } from 'react'

import { BRAND } from '@/shared/config/brand'
import {
  DataTableHeader,
  type DataTableColumnDrag,
  type DataTableHeaderColumn,
  type DataTableSort,
} from '@/shared/ui/data-table-header'
import { SkeletonList } from '@/shared/ui/skeleton'

/** The exact shape returned by `useDataTable().headerProps`. */
export interface DataTableFrameHeader<K extends string> {
  columns: DataTableHeaderColumn<K>[]
  colStyles: Record<string, CSSProperties>
  onResize: (key: K, e: React.MouseEvent) => void
  columnDrag?: DataTableColumnDrag<K>
  sort?: DataTableSort
}

export interface DataTableFrameProps<K extends string> {
  /** Spread of `useDataTable().headerProps` — columns, colStyles, resize, drag, sort. */
  header: DataTableFrameHeader<K>
  /**
   * Leading gutter rendered before the header columns. Pass the SAME node the
   * body rows use (e.g. `<RowGutter … />` or a `w-6` spacer) so the header,
   * totals row and body stay column-aligned. Omit for gutter-less grids.
   */
  leading?: ReactNode
  /** Horizontal padding applied to the header + totals bars. Default `px-3`. */
  padClassName?: string
  /** Optional totals row (a `<TableTotalsRow>`), rendered under the header. */
  totals?: ReactNode
  /** When true, renders a `<SkeletonList>` in place of the body. */
  loading?: boolean
  /** Skeleton dimensions used while `loading`. */
  skeleton?: { rows?: number; cols?: number }
  /** Rendered (after loading) when truthy — e.g. a failed-load message. */
  error?: ReactNode
  /** Rendered when truthy and not loading/error — e.g. an `<EmptyState>`. */
  empty?: ReactNode
  /** Body rows (page-specific structure). */
  children?: ReactNode
  /** Footer below the scroll region — e.g. a `<PaginationFooter>`. */
  footer?: ReactNode
  /** Background of the scroll region. Defaults to the surface token. */
  bodyBackground?: string
  /** Extra classes for the outer flex column wrapper. */
  className?: string
}

export function DataTableFrame<K extends string>({
  header,
  leading,
  padClassName = 'px-3',
  totals,
  loading = false,
  skeleton,
  error,
  empty,
  children,
  footer,
  bodyBackground = BRAND.surface,
  className,
}: DataTableFrameProps<K>) {
  return (
    <div className={`flex min-h-0 flex-1 flex-col ${className ?? ''}`}>
      {/*
        `[&>*]:shrink-0` is load-bearing, and it is the whole of the row-height defect.

        This scroll region is a COLUMN flex container with a definite height (`flex-1` inside a
        `min-h-0` column). Its children — the sticky header, the totals bar and every body row — are
        therefore flex items, and a flex item's default `flex-shrink: 1` applies to the MAIN axis,
        which here is height. As soon as the rows overflow the viewport, the browser shrinks them all
        to fit, down to whatever floor they declare: `TableRow`'s `min-h-[35px]`. Overflow scrolling
        does not save it — the shrink happens first, and the scrollbar then measures the shrunken
        content.

        So a row whose Name wrapped to two or three lines was squeezed back to one row's worth of
        height while its text kept the height it needed, and the surplus painted OVER the row above
        and was cut off at the bottom (DE-21). Removing the cells' `overflow-hidden` — the earlier
        fix in `status-row.tsx` — made that surplus visible rather than clipped; it could not make
        the row grow, because nothing in the cell was ever the constraint.

        Fixed here, once, rather than per row component: every grid in the app renders its rows as
        direct children of this element (`children` is spread inline, not wrapped), so this is the
        single place that governs all of them, including the skeleton/empty/error nodes.
      */}
      <div
        className="flex flex-1 flex-col overflow-auto [&>*]:shrink-0"
        style={{ backgroundColor: bodyBackground }}
      >
        <DataTableHeader {...header} leading={leading} className={padClassName} />

        {totals}

        {loading && <SkeletonList rows={skeleton?.rows} cols={skeleton?.cols} />}

        {!loading && error}

        {!loading && !error && children}

        {!loading && !error && empty}
      </div>

      {footer}
    </div>
  )
}
