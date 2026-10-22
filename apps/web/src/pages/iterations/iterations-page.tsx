/**
 * Timeboxes › Iterations — P2.2 Iteration Management
 *
 * Lists iterations for the active project/team with search, state filter, sort
 * and pagination; a quick-create modal; and a full-page detail (Theme/Notes +
 * right panel). State maps DB planning/committed/accepted ↔ UI Planning/Committed/Accepted.
 *
 * Grid uses the shared `useDataTable` engine + `DataTableFrame` (resize / reorder /
 * show-hide + identical chrome), replacing the former hand-rolled flex-grid and
 * bespoke pagination (FRONTEND_COMPONENT_AUDIT §5.2).
 */
import { useCallback, useMemo, useState, type CSSProperties } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { AlertTriangle, Inbox, Plus, Trash2 } from 'lucide-react'
import { TimeboxTypeSwitcher } from '@/pages/timeboxes/timebox-type-switcher'
import { ConfirmDialog } from '@/shared/ui/confirm-dialog'
import { type RowSelection } from '@/shared/lib/hooks/use-row-selection'
import { EmptyState } from '@/shared/ui/empty-state'
import { InlineSelect } from '@/shared/ui/native-select'
import { Button } from '@/shared/ui/button'
import { ColumnFieldsMenu } from '@/shared/ui/column-fields-menu'
import { useDataTable } from '@/shared/ui/table'
import { ListPageScaffold } from '@/shared/ui/list-page/list-page-scaffold'
import { ListPageHeader } from '@/shared/ui/list-page/list-page-header'
import { MetricStrip } from '@/shared/ui/metric-strip'
import { MetricCard } from '@/shared/ui/metric-card'
import { STORAGE_KEYS } from '@/shared/config/storage-keys'
import { useAppContext } from '@/shared/lib/stores/app-context.store'
import { useProjectPermissions } from '@/features/access/api'
import { CreateIterationModal } from './ui/iteration-parts'
import { IterationRow } from './ui/iteration-row'
import { type ColKey, ITERATIONS_COLUMNS } from './model/columns'
import {
  useIterations,
  useDeleteIteration,
  type Iteration,
  type IterationState,
} from '@/features/iterations/api'
import { entityDetailPath } from '@/shared/lib/entity-link'

// ── Page ────────────────────────────────────────────────────────────────────

export function IterationsPage() {
  const { t } = useTranslation('iterations')
  const navigate = useNavigate()
  const { project } = useAppContext()
  const projectId = project?.projectId
  const { can } = useProjectPermissions(projectId)
  const canManage = can('iteration:create') || can('iteration:edit') || can('iteration:delete')

  const { data: iterations = [], isLoading, isError } = useIterations(projectId)
  const deleteIteration = useDeleteIteration()
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)

  async function handleBulkDelete(selection: RowSelection) {
    const ids = iterations.filter((it) => selection.selectedIds.has(it.id)).map((it) => it.id)
    try {
      await Promise.all(ids.map((id) => deleteIteration.mutateAsync(id)))
      toast.success(t('delete.deleted'))
      selection.clear()
      setConfirmBulkDelete(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('delete.deleteFailed'))
    }
  }

  // ── Shared table engine (resize / reorder / show-hide) ──
  const table = useDataTable<Iteration, unknown, ColKey>(ITERATIONS_COLUMNS, {
    storageKey: STORAGE_KEYS.ITERATIONS_COLUMNS,
  })
  const colStyleFor = useCallback(
    (key: ColKey, base?: CSSProperties) => table.styleFor(key, base),
    [table],
  )

  const [search, setSearch] = useState('')
  const [stateFilter, setStateFilter] = useState<'all' | IterationState>('all')
  const [sort, setSort] = useState<{ key: ColKey; dir: 'asc' | 'desc' }>({
    key: 'startDate',
    dir: 'asc',
  })
  const [showCreate, setShowCreate] = useState(false)

  /** The record route. Page-local state here gave the detail no URL — see the detail page's docblock. */
  const openIteration = useCallback(
    (id: string) => void navigate({ href: entityDetailPath.iteration(id) }),
    [navigate],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const rows = iterations.filter((it) => {
      const matchesQ =
        !q ||
        [it.name, it.theme ?? '', it.iterationKey ?? ''].some((v) => v.toLowerCase().includes(q))
      const matchesState = stateFilter === 'all' || it.state === stateFilter
      return matchesQ && matchesState
    })
    // `id` isn't a real Iteration field — sort by the display key instead.
    const sortField = (sort.key === 'id' ? 'iterationKey' : sort.key) as keyof Iteration
    return [...rows].sort((a, b) => {
      const av = a[sortField] ?? ''
      const bv = b[sortField] ?? ''
      const r =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv))
      return sort.dir === 'asc' ? r : -r
    })
  }, [iterations, search, stateFilter, sort])

  const metrics = useMemo(
    () => ({
      total: iterations.length,
      planning: iterations.filter((it) => it.state === 'planning').length,
      committed: iterations.filter((it) => it.state === 'committed').length,
      accepted: iterations.filter((it) => it.state === 'accepted').length,
    }),
    [iterations],
  )

  const toggleSort = useCallback((key: ColKey) => {
    setSort((p) =>
      p.key === key ? { key, dir: p.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    )
  }, [])

  if (!projectId) {
    return (
      <div className="flex flex-1 items-center justify-center text-ui-lg text-foreground-subtle">
        {t('selectProject')}
      </div>
    )
  }

  return (
    <>
      <ListPageScaffold<Iteration, ColKey>
        bulkActions={
          canManage
            ? (selection) => (
                <>
                  <button
                    type="button"
                    onClick={() => setConfirmBulkDelete(true)}
                    disabled={deleteIteration.isPending}
                    className="flex items-center gap-1 rounded px-2 py-1 text-ui-sm font-medium text-destructive transition-colors hover:bg-card disabled:opacity-50"
                  >
                    <Trash2 size={12} />
                    {t('common:delete')}
                  </button>
                  <ConfirmDialog
                    open={confirmBulkDelete}
                    title={t('delete.title')}
                    message={t('delete.bulkMessage', { count: selection.count })}
                    confirmLabel={t('delete.confirm')}
                    destructive
                    pending={deleteIteration.isPending}
                    onConfirm={() => void handleBulkDelete(selection)}
                    onCancel={() => setConfirmBulkDelete(false)}
                  />
                </>
              )
            : undefined
        }
        header={
          <ListPageHeader
            title={t('title')}
            accessory={<TimeboxTypeSwitcher current="iterations" />}
          />
        }
        metrics={
          <MetricStrip>
            <MetricCard label={t('metrics.total')} value={metrics.total} minWidth={90} />
            <MetricCard label={t('metrics.planning')} value={metrics.planning} minWidth={90} />
            <MetricCard label={t('metrics.committed')} value={metrics.committed} minWidth={90} />
            <MetricCard label={t('metrics.accepted')} value={metrics.accepted} minWidth={90} />
          </MetricStrip>
        }
        search={{
          value: search,
          onChange: setSearch,
          placeholder: 'Search iterations…',
          ariaLabel: 'Search iterations',
          width: 190,
        }}
        actions={
          canManage ? (
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus size={12} /> {t('common:addNew')}
            </Button>
          ) : undefined
        }
        fields={<ColumnFieldsMenu {...table.fieldsMenuProps} />}
        activeFilterCount={stateFilter !== 'all' ? 1 : 0}
        filters={
          <label className="flex items-center gap-1.5 text-ui-sm font-semibold text-muted-foreground">
            {t('filterState')}
            <InlineSelect
              value={stateFilter}
              aria-label="Filter iterations by state"
              onChange={(e) => setStateFilter(e.target.value as 'all' | IterationState)}
              className="w-auto"
            >
              <option value="all">All</option>
              <option value="planning">Planning</option>
              <option value="committed">Committed</option>
              <option value="accepted">Accepted</option>
            </InlineSelect>
          </label>
        }
        headerProps={table.headerProps}
        headerColumns={table.headerColumns}
        colStyles={table.colStyles}
        sort={{ col: sort.key, dir: sort.dir, onSort: (k) => toggleSort(k as ColKey) }}
        items={filtered}
        loading={isLoading}
        skeleton={{ rows: 8, cols: 6 }}
        error={
          isError ? (
            <EmptyState
              icon={<AlertTriangle size={28} className="text-destructive" />}
              title={t('loadError')}
            />
          ) : undefined
        }
        empty={
          filtered.length === 0 ? (
            <EmptyState
              icon={<Inbox size={32} className="text-foreground-subtle" />}
              title={t('empty')}
            />
          ) : undefined
        }
        renderRow={(it, { gutter }) => (
          <IterationRow
            key={it.id}
            iteration={it}
            canManage={canManage}
            colStyleFor={colStyleFor}
            gutter={gutter}
            onOpen={() => openIteration(it.id)}
          />
        )}
      />

      {showCreate && projectId && (
        <CreateIterationModal
          projectId={projectId}
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false)
            openIteration(id)
          }}
        />
      )}
    </>
  )
}
