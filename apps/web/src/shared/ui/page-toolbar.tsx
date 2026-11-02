import { useState, type ReactNode } from 'react'

import { Filter, Upload } from 'lucide-react'

import { TOOLBAR_ROW_H } from '@/shared/config/layout'
import { SearchInput } from '@/shared/ui/search-input'
import { cn } from '@/shared/lib/utils'

export interface PageToolbarSearch {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  ariaLabel?: string
  width?: number
  /**
   * `right` pushes the box to the far end of the bar, leaving whatever is on the left in its own group.
   *
   * Rally lays a list's scope picker and its search out that way — selector left, search right, one row
   * — and Release Tracking is the surface that needs it: the bucket picker and the search box were on
   * two stacked rows, which read as two separate controls for one list.
   */
  align?: 'left' | 'right'
}

/**
 * Shared page toolbar — the single source of truth for the search / action /
 * filter / fields bar across every grid page (Backlog, Quality, Releases,
 * Milestones, Timeboxes, Iteration Status …).
 *
 * Mirrors Broadcom's Rally work-item toolbar: a search box, primary actions,
 * a collapsible "Show Filters" control with an active-count badge, an optional
 * "Show Fields" column menu, and an optional export button — laid out in one
 * consistent order so no page hand-rolls its own arrangement.
 *
 * Composition over configuration: pages pass their own filter controls and
 * actions as slots, so the toolbar stays generic while each page keeps its
 * domain-specific dropdowns.
 */
export function PageToolbar({
  title,
  titleAccessory,
  search,
  actions,
  filters,
  activeFilterCount = 0,
  defaultFiltersOpen = false,
  fields,
  onExport,
  trailing,
}: {
  /** Page title rendered bold on the far left (omit to hide). */
  title?: string
  /** Controls rendered right after the title (e.g. a context dropdown). */
  titleAccessory?: ReactNode
  /** Search field config; renders the shared `SearchInput` when provided. */
  search?: PageToolbarSearch
  /** Primary action(s), e.g. a "+ Add Item" button — rendered after search. */
  actions?: ReactNode
  /** Filter controls, revealed beneath a "Show Filters" toggle. */
  filters?: ReactNode
  /** Number of active filters, shown as a badge on the toggle. */
  activeFilterCount?: number
  /** Whether the filter panel starts expanded (pass `count > 0` to auto-open). */
  defaultFiltersOpen?: boolean
  /** "Show Fields" column menu slot — render only where columns are configurable. */
  fields?: ReactNode
  /** Enables the export button when provided. */
  onExport?: () => void
  /** Extra controls pushed to the far right (e.g. a bulk-selection summary). */
  trailing?: ReactNode
}) {
  const [filtersOpen, setFiltersOpen] = useState(defaultFiltersOpen)
  const hasFilters = filters != null

  return (
    <>
      {/* `minHeight` from the shared token, so a panel heading rendered BESIDE this row (Capacity
          Planning's team rail) can sit on the same line without either side guessing the other's
          height. The value is what this row already measured; pinning it stops a toolbar with no
          button from collapsing shorter than one with. */}
      <div
        className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle bg-card px-4 py-2"
        style={{ minHeight: TOOLBAR_ROW_H }}
      >
        {title != null && (
          <>
            <h2 className="mr-1 shrink-0 text-ui-lg font-semibold text-foreground">{title}</h2>
            <div className="h-4 w-px shrink-0 bg-border-strong" />
          </>
        )}

        {titleAccessory}

        {search?.align === 'right' && <div className="flex-1" />}
        {search && (
          <SearchInput
            value={search.value}
            onChange={search.onChange}
            placeholder={search.placeholder ?? 'Search…'}
            ariaLabel={search.ariaLabel}
            width={search.width ?? 180}
          />
        )}

        {actions}

        {hasFilters && (
          <FiltersToggle
            open={filtersOpen}
            count={activeFilterCount}
            onClick={() => setFiltersOpen((o) => !o)}
          />
        )}

        {fields}

        {onExport && <ExportButton onClick={onExport} />}

        {trailing != null && (
          <>
            <div className="flex-1" />
            {trailing}
          </>
        )}
      </div>

      {hasFilters && filtersOpen && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle bg-surface-hover px-4 py-2">
          {filters}
        </div>
      )}
    </>
  )
}

function FiltersToggle({
  open,
  count,
  onClick,
}: {
  open: boolean
  count: number
  onClick: () => void
}) {
  const active = open || count > 0
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      className={cn(
        'flex items-center gap-1.5 rounded border border-input px-2.5 py-1 text-ui-sm font-medium transition-colors',
        open && 'bg-primary-lighter',
        active ? 'text-primary' : 'text-muted-foreground',
      )}
    >
      <Filter size={12} />
      <span>Filters</span>
      {count > 0 && (
        <span
          className="inline-flex min-w-[16px] items-center justify-center rounded-full bg-primary px-1 text-ui-xs font-semibold text-white tabular-nums"
          style={{ height: 16 }}
        >
          {count}
        </span>
      )}
    </button>
  )
}

function ExportButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Export"
      title="Export to CSV"
      className="flex items-center rounded border border-input p-1.5 text-muted-foreground transition-colors hover:opacity-80"
    >
      <Upload size={13} />
    </button>
  )
}
