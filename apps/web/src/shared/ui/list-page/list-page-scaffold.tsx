/**
 * ListPageScaffold — the single, shared layout for every entity LIST page
 * (Iteration Status, Milestones, Releases, Timeboxes/Iterations, …).
 *
 * Why this exists
 * ---------------
 * The list pages already shared the *pieces* (`PageToolbar`, `MetricStrip`,
 * `DataTableFrame`, `RowGutter`, `TableTotalsRow`, `PaginationFooter`,
 * `BulkActionBar`, `useRowSelection`) but each page re-wired them — the fixed
 * order, the selection gutter, the client-side pagination and the bulk bar —
 * so they drifted (some had a metric strip, some a totals row, some pagination).
 * This component composes those pieces in ONE fixed order that mirrors Broadcom
 * Broadcom's Rally Iteration Status screen, and OWNS the shared state (client-side
 * pagination + row selection), so a page only declares its columns, rows,
 * metrics, filters and bulk actions.
 *
 * Fixed layout (top → bottom):
 *   header?            — title bar (title + context selector); page-supplied
 *   metrics?           — a MetricStrip of KPI cards
 *   PageToolbar        — search · actions · Show Filters · Show Fields
 *   BulkActionBar      — only when ≥1 row selected
 *   DataTableFrame     — sticky sortable header + selection gutter + totals
 *                        + body rows + pagination footer
 *
 * State ownership: the scaffold paginates `items` client-side and derives the
 * selection over the *visible page*. The page receives per-row selection wiring
 * via `renderRow`'s `gutter` node and the whole `RowSelection` via `bulkActions`.
 */
import { useMemo, useState, type ComponentProps, type CSSProperties, type ReactNode } from 'react'

import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'
import { BulkActionBar } from '@/shared/ui/bulk-action-bar'
import { type DataTableFrameHeader, DataTableFrame } from '@/shared/ui/table/data-table-frame'
import { PageToolbar, type PageToolbarSearch } from '@/shared/ui/page-toolbar'
import { PaginationFooter } from '@/shared/ui/pagination-footer'
import { RowGutter } from '@/shared/ui/row-gutter'
import { TableTotalsRow } from '@/shared/ui/table-totals-row'
import { useRowSelection, type RowSelection } from '@/shared/lib/hooks/use-row-selection'
import type { DataTableSort } from '@/shared/ui/data-table-header'

/** Optional totals row config — pass formatted values keyed by column. */
export interface ListPageTotals {
  label?: ReactNode
  values?: Record<string, ReactNode>
}

export interface ListPageScaffoldProps<Row extends { id: string }, K extends string> {
  // ── Chrome slots ───────────────────────────────────────────────────────────
  /** Title bar rendered above the metric strip (page-supplied, e.g. ListPageHeader). */
  header?: ReactNode
  /** A `<MetricStrip>` of KPI cards. */
  metrics?: ReactNode
  /** Toolbar search field. */
  search: PageToolbarSearch
  /** Primary action(s) — e.g. an "+ Add" button. */
  actions?: ReactNode
  /** Filter controls revealed under the "Show Filters" toggle. */
  filters?: ReactNode
  /**
   * Controls pushed to the FAR RIGHT of the toolbar — a row count, an export, a legend.
   *
   * Forwarded to `PageToolbar`, which already had the slot; the scaffold simply never passed it
   * through, so every page that wanted one had to drop the scaffold entirely.
   */
  trailing?: ReactNode
  /** Active filter count (badge on the toggle; also auto-opens the panel). */
  activeFilterCount?: number
  /** "Show Fields" column menu. */
  fields?: ReactNode
  /**
   * Whether rows are multi-selectable (renders the checkbox gutter + bulk bar).
   * Default `true`. Set `false` for read-only lists with no bulk operations
   * (e.g. Iterations, whose lifecycle is commit/accept, not delete) — then no
   * selection gutter is shown and `renderRow`'s `gutter` is empty.
   */
  selectable?: boolean
  /** Bulk actions rendered inside the BulkActionBar; receives live selection. */
  bulkActions?: (selection: RowSelection) => ReactNode
  /** Inline error surfaced by a failed bulk action. */
  bulkError?: string | null

  // ── Grid ─────────────────────────────────────────────────────────────────
  /** `useDataTable().headerProps`. */
  headerProps: DataTableFrameHeader<K>
  /** Click-to-sort wiring for the header. */
  sort?: DataTableSort
  /** `useDataTable().headerColumns` (used for totals-cell alignment). */
  headerColumns: readonly { key: K; align?: 'center' | 'right' }[]
  /** `useDataTable().colStyles` (used for totals-cell widths). */
  colStyles: Record<string, CSSProperties>
  /** Horizontal padding for header/totals bars. Match the row padding. */
  padClassName?: string
  /** Optional totals row (rendered under the header when there are rows). */
  totals?: ListPageTotals

  // ── Data + rows ────────────────────────────────────────────────────────────
  /** The fully filtered + sorted list (the scaffold paginates it). */
  items: Row[]
  loading?: boolean
  error?: ReactNode
  empty?: ReactNode
  skeleton?: { rows?: number; cols?: number }
  /**
   * Render one body row. Receives the per-row selection `gutter` node (an inert
   * grip + selection checkbox) to place at the start of the row so every grid's
   * columns stay aligned under the shared header.
   */
  renderRow: (
    row: Row,
    ctx: {
      gutter: ReactNode
      selected: boolean
      /**
       * The gutter's configuration, for rows that must render the gutter THEMSELVES.
       *
       * A draggable row owns dnd-kit's `useSortable`, so only the row can supply
       * `ref={setActivatorNodeRef}` and `dragListeners={listeners}` to `RowGutter` — the
       * scaffold has no access to that state. Such rows ignore `gutter` and build their
       * own from these props; every other page keeps using `gutter` unchanged.
       */
      gutterProps: {
        stopPropagation: true
        checkbox?: { checked: boolean; onChange: () => void; ariaLabel: string }
      }
      /**
       * This row is the one `revealRowId` named.
       *
       * Optional to honour: a row that ignores it still gets the page jump, which is the part
       * that decides whether the row is on screen at all.
       */
      revealed: boolean
      /** 1-based position in the whole list, page offset included — for a `Rank` column. */
      rowNum: number
    },
  ) => ReactNode
  /** Initial rows-per-page (default 25). */
  initialPageSize?: number
  /**
   * Bring a row into view — pass the id of a row the user just created or acted on.
   *
   * Lives here rather than in a page because it is a consequence of the scaffold's OWN
   * client-side pagination: a new row appended in rank order lands on the last page, so on a
   * populated list "Create" appeared to do nothing at all. Every paginated list has that
   * problem, so it is fixed once.
   *
   * Jumps to the page holding the row and marks it. The mark lasts until the user pages away
   * or a different row is revealed — deliberately not a timed flash, which would vanish while
   * they were still reading. The row opts in by reading `ctx.revealed`; rows that ignore it
   * still get the page jump, which is the part that decides whether it is on screen at all.
   */
  revealRowId?: string | null
  /**
   * dnd-kit wiring from `useRowRerank()` — pass to enable drag-to-rank.
   *
   * Mirrors `SelectableTable`'s `dnd` prop so the two table shells behave identically.
   * The page is responsible for disabling reorder while a column sort is active: rank
   * only means anything in natural rank order, and dragging inside a Name-sorted view
   * would compute neighbours from an order the ranks do not share.
   */
  dnd?: {
    dndContextProps: Omit<ComponentProps<typeof DndContext>, 'children'>
    sortableContextProps: Omit<ComponentProps<typeof SortableContext>, 'children'>
  }
}

export function ListPageScaffold<Row extends { id: string }, K extends string>({
  header,
  metrics,
  search,
  actions,
  filters,
  trailing,
  activeFilterCount = 0,
  fields,
  selectable = true,
  bulkActions,
  bulkError,
  headerProps,
  sort,
  headerColumns,
  colStyles,
  padClassName,
  totals,
  items,
  loading = false,
  error,
  empty,
  skeleton,
  renderRow,
  dnd,
  initialPageSize = 25,
  revealRowId,
}: ListPageScaffoldProps<Row, K>) {
  // ── Client-side pagination ──────────────────────────────────────────────────
  const [pageSize, setPageSize] = useState(initialPageSize)
  const [currentPage, setCurrentPage] = useState(1)
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize))

  // ── Reveal a row (e.g. one just created) ────────────────────────────────────
  // DERIVED, not stored. Setting the page from an effect would mean `setState` during an
  // effect — cascading renders, and the lint rule that forbids it is right: the page the user
  // should be looking at is a function of the reveal, not an event that happened to it.
  //
  // `dismissedReveal` is what lets the user page away again afterwards: once they touch the
  // pager, the override stops applying to that id.
  const [dismissedReveal, setDismissedReveal] = useState<string | null>(null)
  const revealIndex =
    revealRowId && revealRowId !== dismissedReveal
      ? items.findIndex((row) => row.id === revealRowId)
      : -1
  // A row that does not exist YET (the list is still refetching) leaves this at -1 and simply
  // has no effect — and starts working the moment it arrives, with no extra wiring.
  const revealPage = revealIndex >= 0 ? Math.floor(revealIndex / pageSize) + 1 : null

  const page = revealPage ?? Math.min(currentPage, pageCount)
  const paged = useMemo(
    () => items.slice((page - 1) * pageSize, page * pageSize),
    [items, page, pageSize],
  )

  // ── Selection over the visible page (only when selectable) ───────────────────
  const selection = useRowSelection(paged)
  const leadingSelectAll = selectable ? (
    <RowGutter
      dragDisabled
      checkbox={{
        checked: selection.allSelected,
        indeterminate: selection.someSelected,
        onChange: selection.toggleAll,
        ariaLabel: 'Select all',
      }}
    />
  ) : undefined

  const hasRows = !loading && !error && items.length > 0

  /** Wraps the body in dnd-kit context only when the page asked for reordering. */
  const wrapDnd = (body: ReactNode): ReactNode =>
    dnd ? (
      <DndContext {...dnd.dndContextProps}>
        <SortableContext {...dnd.sortableContextProps}>{body}</SortableContext>
      </DndContext>
    ) : (
      body
    )

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-background">
      {header}
      {metrics}

      <PageToolbar
        search={search}
        actions={actions}
        filters={filters}
        activeFilterCount={activeFilterCount}
        defaultFiltersOpen={activeFilterCount > 0}
        fields={fields}
        trailing={trailing}
      />

      {selectable && selection.count > 0 && (
        <BulkActionBar selectedCount={selection.count} error={bulkError} onClear={selection.clear}>
          {bulkActions?.(selection)}
        </BulkActionBar>
      )}

      <DataTableFrame
        header={{ ...headerProps, sort }}
        padClassName={padClassName}
        leading={leadingSelectAll}
        loading={loading}
        skeleton={skeleton}
        error={error}
        empty={empty}
        totals={
          hasRows && totals ? (
            <TableTotalsRow
              columns={headerColumns.map((c) => ({ key: c.key, align: c.align }))}
              colStyles={colStyles}
              leading={leadingSelectAll}
              label={totals.label}
              values={totals.values}
            />
          ) : undefined
        }
        footer={
          hasRows ? (
            <PaginationFooter
              pageSize={pageSize}
              setPageSize={(n) => {
                setPageSize(n)
                setCurrentPage(1)
                setDismissedReveal(revealRowId ?? null)
              }}
              currentPage={page}
              rangeStart={(page - 1) * pageSize + 1}
              rangeEnd={(page - 1) * pageSize + paged.length}
              total={items.length}
              pageCount={pageCount}
              hasPrevPage={page > 1}
              hasNextPage={page < pageCount}
              // Paging by hand releases the reveal override — from here the user is driving.
              onPrevPage={() => {
                setCurrentPage(Math.max(1, page - 1))
                setDismissedReveal(revealRowId ?? null)
              }}
              onNextPage={() => {
                setCurrentPage(Math.min(pageCount, page + 1))
                setDismissedReveal(revealRowId ?? null)
              }}
            />
          ) : undefined
        }
      >
        {wrapDnd(
          paged.map((row, at) => {
            const checkbox = selectable
              ? {
                  checked: selection.isSelected(row.id),
                  onChange: () => selection.toggle(row.id),
                  ariaLabel: 'Select row',
                }
              : undefined
            return renderRow(row, {
              selected: selectable && selection.isSelected(row.id),
              /**
               * 1-based position in the WHOLE list, page offset included — the `Rank` column's value.
               *
               * Computed here because only the scaffold knows the current page: every grid that shows
               * Rank was recomputing `(page - 1) * pageSize + index + 1` from its own state, and a
               * grid whose paging the scaffold owns could not compute it correctly at all.
               */
              rowNum: (page - 1) * pageSize + at + 1,
              revealed: revealIndex >= 0 && row.id === revealRowId,
              // `dragDisabled` here because this node has no sortable state — a
              // draggable row builds its own gutter from `gutterProps` instead.
              gutter: checkbox ? (
                <RowGutter dragDisabled stopPropagation checkbox={checkbox} />
              ) : null,
              gutterProps: { stopPropagation: true, checkbox },
            })
          }),
        )}
      </DataTableFrame>
    </div>
  )
}
