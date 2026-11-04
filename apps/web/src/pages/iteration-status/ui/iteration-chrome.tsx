import { type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Plus,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Bug,
  ListChecks,
  BarChart3,
  List,
  LayoutGrid,
} from 'lucide-react'

import { BRAND } from '@/shared/config/brand'
import { useClickOutside } from '@/shared/lib/hooks/use-click-outside'
import { type IterationReference } from '@/features/iterations/api'
import { type ColumnDef } from '@/shared/lib/hooks/use-column-layout'
import { ColumnFieldsMenu } from '@/shared/ui/column-fields-menu'
import { PageToolbar } from '@/shared/ui/page-toolbar'
import { Button } from '@/shared/ui/button'
import { MetricCard } from '@/shared/ui/metric-card'
import { RowGutter } from '@/shared/ui/row-gutter'
import { TableTotalsRow } from '@/shared/ui/table-totals-row'
import { fmtRange } from '../model/iteration-helpers'
import { type ColKey, HEADER_META } from '../model/columns'
import { type IterationFilterKey } from '../model/filter-fields'
import { type ManageFiltersState } from '@/features/work-items/model/manage-filters'
import { ManageFiltersBar } from '@/features/work-items/ui/manage-filters-bar'
import { formatWholePercent } from '@/shared/lib/utils'

export function IterationHeader({
  iterations,
  selected,
  selectedId,
  setSelectedId,
  stepIteration,
  hasEarlier,
  hasLater,
  selectorOpen,
  setSelectorOpen,
  viewMode,
  setViewMode,
}: {
  // The REFERENCE projection, not the timebox record: the picker needs a name and a window, and
  // this screen is one §3.2 grants an Editor — who may not read `goal`, `theme`, `notes` or
  // `plannedVelocity`.
  iterations: IterationReference[]
  selected: IterationReference | undefined
  selectedId: string | null
  setSelectedId: (id: string) => void
  /**
   * Step by CHRONOLOGY, never by row index. The feed is newest-first, so the left chevron asks for
   * `earlier` and the right for `later` — passing `-1`/`+1` from here is what made both arrows move
   * the opposite way from their icons (Production, 2026-08-21).
   */
  stepIteration: (direction: 'earlier' | 'later') => void
  /** Whether an earlier / later iteration exists. Derived beside `stepIteration`, from one mapping,
   *  so a disabled arrow and the step it guards cannot disagree. */
  hasEarlier: boolean
  hasLater: boolean
  selectorOpen: boolean
  setSelectorOpen: React.Dispatch<React.SetStateAction<boolean>>
  viewMode: 'list' | 'board'
  setViewMode: (mode: 'list' | 'board') => void
}) {
  const { t } = useTranslation('iteration-status')
  const selectorRef = useClickOutside<HTMLDivElement>(selectorOpen, () => setSelectorOpen(false))
  return (
    <div
      className="flex shrink-0 items-center gap-3 border-b border-border-subtle bg-card px-4"
      style={{
        height: 44,
      }}
    >
      <span
        className="text-foreground"
        style={{ fontSize: 16, fontWeight: 700, whiteSpace: 'nowrap' }}
      >
        {t('title')}
      </span>
      <div
        className="flex items-center border border-border-subtle"
        style={{
          borderRadius: 2,
          overflow: 'visible',
          height: 28,
        }}
      >
        <button
          aria-label="Previous iteration"
          disabled={!hasEarlier}
          onClick={() => stepIteration('earlier')}
          className="border-r border-border-subtle"
          style={{
            height: '100%',
            padding: '0 6px',
            display: 'flex',
            alignItems: 'center',
            cursor: hasEarlier ? 'pointer' : 'not-allowed',
            background: 'transparent',
            color: hasEarlier ? BRAND.textSecondary : BRAND.textMuted,
            opacity: hasEarlier ? 1 : 0.4,
          }}
          onMouseOver={(e) => {
            if (hasEarlier) e.currentTarget.style.backgroundColor = BRAND.surfaceHover
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent'
          }}
        >
          <ChevronLeft size={14} />
        </button>
        <div ref={selectorRef} className="relative" style={{ height: '100%' }}>
          <button
            onClick={() => setSelectorOpen((o) => !o)}
            className="text-foreground"
            style={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '0 10px',
              cursor: 'pointer',
              background: 'transparent',
              border: 'none',
              minWidth: 300,
              textAlign: 'left',
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.backgroundColor = BRAND.surfaceHover
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent'
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
              {selected?.name}
            </span>
            <span className="text-muted-foreground" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
              {selected && fmtRange(selected)}
            </span>
            <ChevronDown
              size={12}
              className="text-foreground-subtle"
              style={{ marginLeft: 'auto' }}
            />
          </button>
          {selectorOpen && (
            <div
              className="absolute top-full left-0 z-50 border border-border-subtle bg-card"
              style={{
                marginTop: 4,
                width: 380,
                borderRadius: 2,
                boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                maxHeight: 300,
                overflowY: 'auto',
                padding: '4px 0',
              }}
            >
              {iterations.map((it) => (
                <button
                  key={it.id}
                  onClick={() => {
                    setSelectedId(it.id)
                    setSelectorOpen(false)
                  }}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '6px 12px',
                    cursor: 'pointer',
                    border: 'none',
                    background: selectedId === it.id ? BRAND.primaryLighter : 'transparent',
                    color: selectedId === it.id ? BRAND.primary : BRAND.textPrimary,
                    fontSize: 12,
                    textAlign: 'left',
                  }}
                  onMouseOver={(e) => {
                    if (selectedId !== it.id)
                      e.currentTarget.style.backgroundColor = BRAND.surfaceHover
                  }}
                  onMouseOut={(e) => {
                    if (selectedId !== it.id) e.currentTarget.style.backgroundColor = 'transparent'
                  }}
                >
                  <span style={{ fontWeight: 600, flex: 1 }}>{it.name}</span>
                  <span className="text-foreground-subtle" style={{ fontSize: 11 }}>
                    {fmtRange(it)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          aria-label="Next iteration"
          disabled={!hasLater}
          onClick={() => stepIteration('later')}
          className="border-l border-border-subtle"
          style={{
            height: '100%',
            padding: '0 6px',
            display: 'flex',
            alignItems: 'center',
            cursor: hasLater ? 'pointer' : 'not-allowed',
            background: 'transparent',
            color: hasLater ? BRAND.textSecondary : BRAND.textMuted,
            opacity: hasLater ? 1 : 0.4,
          }}
          onMouseOver={(e) => {
            if (hasLater) e.currentTarget.style.backgroundColor = BRAND.surfaceHover
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent'
          }}
        >
          <ChevronRight size={14} />
        </button>
      </div>
      <div className="flex-1" />
      {/* ── List / Board view toggle (BA spec) ──────────────────────────── */}
      <div
        className="flex items-center border border-border-subtle"
        style={{
          borderRadius: 2,
          height: 28,
          overflow: 'hidden',
        }}
      >
        {(
          [
            { mode: 'list', Icon: List, label: t('view.list') },
            { mode: 'board', Icon: LayoutGrid, label: t('view.board') },
          ] as const
        ).map(({ mode, Icon, label }, i) => {
          const active = viewMode === mode
          return (
            <button
              key={mode}
              type="button"
              onClick={() => setViewMode(mode)}
              aria-pressed={active}
              title={`${label} view`}
              className="flex items-center gap-1.5"
              style={{
                height: '100%',
                padding: '0 10px',
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                border: 'none',
                borderLeft: i === 0 ? 'none' : `1px solid ${BRAND.borderSubtle}`,
                backgroundColor: active ? BRAND.primary : 'transparent',
                color: active ? BRAND.primaryForeground : BRAND.textSecondary,
              }}
            >
              <Icon size={13} />
              {label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Metrics strip ────────────────────────────────────────────────────────────

/** Planned points exceed the velocity target (BA 2026-11-04). Null = no target, never red. */
function isOverCommitted(velocityPct: number | null): boolean {
  return velocityPct != null && velocityPct > 100
}

export function MetricsStrip({
  metrics,
  velocityPct,
  acceptedPct,
  iterationEnd,
  iterationProgressPct,
}: {
  metrics: import('@/features/iterations/api').IterationStatus['metrics'] | undefined
  /** Null when the iteration has no velocity target — renders as an em-dash. */
  velocityPct: number | null
  acceptedPct: number
  iterationEnd: { value: string; label: string; color: string }
  iterationProgressPct: number
}) {
  const { t } = useTranslation('iteration-status')
  return (
    <div
      className="flex shrink-0 items-stretch border-b border-border-subtle bg-card px-4"
      style={{
        height: 72,
        gap: 24,
      }}
    >
      {/* Left side: KPI cards from the iteration read-model */}
      <div className="flex items-stretch" style={{ gap: 32, flex: 1 }}>
        {/* No target set renders "—" with an empty bar, not "0%" over "16 of 0 Points".
            Attainment against a target that does not exist is unanswerable. */}
        <MetricCard
          label={t('metrics.plannedVelocity')}
          value={formatWholePercent(velocityPct)}
          caption={
            metrics?.plannedVelocity == null
              ? t('metrics.noVelocityTarget')
              : // `totalPlanEstimate`, the same numerator the server computes the percentage from,
                // so the caption and the percentage above it cannot disagree. BA ruling 2026-11-04:
                // Planned Velocity is PLANNED points against the target — a Story counts once it is
                // in the iteration with an estimate, not once it is Accepted (that is the ACCEPTED
                // tile beside it).
                t('metrics.points', {
                  current: metrics.totalPlanEstimate ?? 0,
                  total: metrics.plannedVelocity,
                })
          }
          progressPct={velocityPct ?? 0}
          // Over 100% means more points are planned than the velocity target: over-committed.
          // Red on the number AND the bar (which caps at full width), so the state does not
          // depend on reading the digits. Exactly 100% is a full sprint, not an over-full one.
          valueColor={isOverCommitted(velocityPct) ? BRAND.danger : undefined}
          minWidth={160}
        />
        <MetricCard
          label={t('metrics.iterationEnd')}
          value={iterationEnd.value}
          valueColor={iterationEnd.color}
          caption={iterationEnd.label}
          progressPct={iterationProgressPct}
          progressColor={BRAND.textMuted}
          minWidth={140}
        />
        <MetricCard
          label={t('metrics.accepted')}
          value={`${acceptedPct}%`}
          valueColor={BRAND.success}
          caption={t('metrics.points', {
            current: metrics?.acceptedPoints ?? 0,
            total: metrics?.totalPlanEstimate ?? 0,
          })}
          progressPct={acceptedPct}
          progressColor={BRAND.success}
          minWidth={140}
        />
      </div>

      {/* Right side: Defects, Tasks, View Charts */}
      <div className="flex items-center" style={{ gap: 20 }}>
        <div className="flex items-center gap-2" style={{ minWidth: 90 }}>
          <Bug size={16} className="text-foreground-subtle" />
          <div className="flex flex-col">
            <span className="text-foreground" style={{ fontSize: 11, fontWeight: 600 }}>
              {t('metrics.defectsActive', { value: metrics?.defectCount ?? 0 })}
            </span>
            <span className="text-foreground-subtle" style={{ fontSize: 10 }}>
              {t('metrics.defects')}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2" style={{ minWidth: 90 }}>
          <ListChecks size={16} className="text-foreground-subtle" />
          <div className="flex flex-col">
            <span className="text-foreground" style={{ fontSize: 11, fontWeight: 600 }}>
              {t('metrics.tasksActive', { value: metrics?.activeTaskCount ?? 0 })}
            </span>
            <span className="text-foreground-subtle" style={{ fontSize: 10 }}>
              {t('metrics.tasks')}
            </span>
          </div>
        </div>
        <button
          className="flex items-center gap-1.5 text-primary"
          style={{
            fontSize: 11,
            fontWeight: 600,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '4px 8px',
            borderRadius: 2,
            whiteSpace: 'nowrap',
          }}
          onMouseOver={(e) => {
            e.currentTarget.style.backgroundColor = BRAND.primaryLighter
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent'
          }}
        >
          <BarChart3 size={14} />
          {t('metrics.viewCharts')}
        </button>
      </div>
    </div>
  )
}

// ── Toolbar (search + add + filter/fields placeholders) ────────────────────

export function Toolbar({
  search,
  setSearch,
  canCreate,
  onAddNew,
  columns,
  order,
  hidden,
  toggleVisible,
  reorder,
  filters,
}: {
  search: string
  setSearch: (v: string) => void
  canCreate: boolean
  onAddNew: () => void
  columns: ColumnDef<ColKey>[]
  order: ColKey[]
  hidden: Set<ColKey>
  toggleVisible: (key: ColKey) => void
  reorder: (dragKey: ColKey, overKey: ColKey) => void
  /** The shared Manage Filters model (P2-IS-FR-022). */
  filters: ManageFiltersState<IterationFilterKey>
}) {
  const { t } = useTranslation('iteration-status')
  return (
    <PageToolbar
      // `Filter items...` stays in the toolbar row, OUTSIDE Manage Filters —
      // P2-IS-FR-020 says so explicitly, and P2-BL-TS-015 asserts it.
      search={{
        value: search,
        onChange: setSearch,
        placeholder: 'Search Work Items',
        ariaLabel: 'Search work items',
        width: 220,
      }}
      actions={
        canCreate ? (
          <Button size="sm" onClick={onAddNew}>
            <Plus size={14} /> {t('toolbar.addNew')}
          </Button>
        ) : undefined
      }
      activeFilterCount={filters.activeCount}
      defaultFiltersOpen={filters.activeCount > 0}
      // Show/Hide filter banner is PageToolbar's own toggle (P2-IS-FR-021);
      // Manage Filters is the first node inside it (P2-BL-FR-020, inherited).
      filters={<ManageFiltersBar state={filters} />}
      fields={
        <ColumnFieldsMenu
          columns={columns}
          order={order}
          hidden={hidden}
          onToggle={toggleVisible}
          onReorder={reorder}
        />
      }
    />
  )
}

// ── Table header row ─────────────────────────────────────────────────────────

// ── Header column metadata ──────────────────────────────────────────────────
// Drives the (single-source) header render: label, optional sort key, and
// alignment. Order mirrors ITERATION_STATUS_COLUMNS; visual position is driven
// by CSS `order` via styleFor, so the DOM order stays canonical.

// ── Table footer totals ──────────────────────────────────────────────────────

export function TableFooterTotals({
  colStyles,
  totals,
}: {
  colStyles: Record<string, CSSProperties>
  totals: { planEst: number; taskEst: number; toDoSum: number; count: number }
}) {
  const { t } = useTranslation('iteration-status')
  return (
    <TableTotalsRow
      columns={HEADER_META}
      colStyles={colStyles}
      leading={<RowGutter dragDisabled />}
      label={t('totals.label')}
      values={{
        planEstimate: t('totals.points', { value: totals.planEst }),
        taskEstimate: t('totals.hours', { value: totals.taskEst }),
        toDo: t('totals.hours', { value: totals.toDoSum }),
      }}
    />
  )
}
