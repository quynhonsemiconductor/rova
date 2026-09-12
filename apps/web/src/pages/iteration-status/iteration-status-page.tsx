/**
 * Track › Iteration Status — Azure DevOps-style layout
 *
 * Tracking view over the work items assigned to one selected iteration:
 * a single page header (title + iteration selector prev/next + dropdown + view
 * toggle), a metric strip (from the backend read-model), and an editable
 * work-item list. Sourced from /v1/iterations/:id/status.
 */
/* eslint-disable react-hooks/set-state-in-effect */
import { useMemo, useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { SelectableTable, useDataTable, useRerankSensors } from '@/shared/ui/table'
import { IterationBoard } from '@/widgets/iteration-board/iteration-board'
import { toast } from 'sonner'
import { useNavigate } from '@tanstack/react-router'
import { closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { STORAGE_KEYS } from '@/shared/config/storage-keys'
import { SkeletonList } from '@/shared/ui/skeleton'
import { BRAND } from '@/shared/config/brand'
import { PaginationFooter } from '@/shared/ui/pagination-footer'
import { BulkDeleteCopy } from '@/features/work-items/ui/bulk-delete-copy'
import { useRowSelection } from '@/shared/lib/hooks/use-row-selection'
import { useAppContext } from '@/shared/lib/stores/app-context.store'
import { useProjectPermissions } from '@/features/access/api'
import { PERMISSION } from '@/shared/config/permissions'
import {
  useIterationOptions,
  useIterationStatus,
  useAssignableIterations,
  useCreateIterationItem,
  type IterationStatusItem,
} from '@/features/iterations/api'
import { useUpdateAnyWorkItem, useRankAnyWorkItem } from '@/features/work-items/api'
import { useProjectMemberOptions } from '@/features/teams/api'
import { useWorkspaceMemberOptions } from '@/features/workspaces/api'
import { useMilestoneOptions } from '@/features/milestones/api'
import { defaultIterationId } from '@/features/iterations/default-iteration'
import { StatusRow } from './ui/status-row'
import { AddItemModal } from './ui/add-item-modal'
import { IterationHeader, MetricsStrip, Toolbar, TableFooterTotals } from './ui/iteration-chrome'
import { computeTotalDays, iterationStatusTotals, sortStatusRows } from './model/iteration-helpers'
import { stepIndexInTime } from '@/shared/lib/step-in-time'
import { type ColKey, ITERATION_STATUS_COLUMNS, HEADER_META } from './model/columns'
import { useIterationFilterFields, toIterationStatusQuery } from './model/filter-fields'
import { useManageFilters } from '@/features/work-items/model/manage-filters'

// Stable empty-array reference — `status?.items ?? []` would otherwise mint a
// new array every render while status is loading, which defeats the
// `syncedItems !== sortedItems` reference-equality check below and causes an
// infinite render loop ("Too many re-renders").
const EMPTY_ITEMS: IterationStatusItem[] = []

// ── Main page ──────────────────────────────────────────────────────────────

export function IterationStatusPage() {
  const { t } = useTranslation('iteration-status')
  const navigate = useNavigate()
  const { project, workspace } = useAppContext()
  const projectId = project?.projectId
  const { can } = useProjectPermissions(projectId)
  const canEdit = can('work_item:edit')
  const canCreate = can('work_item:create')

  // The REFERENCE feed, not `useIterations`: this page's own picker must offer every timebox
  // including accepted ones, and `GET /iterations` is `timebox:view` — §3.2 marks `Plan > Timeboxes`
  // Hidden for an Editor while granting them THIS screen, so reading the record here 403'd the
  // surface the split exists to keep open.
  const { data: iterations = [], isLoading: iterationsLoading } = useIterationOptions(projectId)
  // The assignee feed, NOT the administrative roster: that one is Admin-only (§3.1:71), and
  // defaulting its 403 to `[]` made every owned item read `Unassigned` for an Editor.
  const { data: members = [] } = useProjectMemberOptions(projectId)
  const { data: milestoneOptions = [] } = useMilestoneOptions(projectId)
  /**
   * The DIRECTORY, for naming an owner that is already set (`GAP-P2-IS-004`).
   *
   * The project feed above is the OFFER list and excludes anyone with no active `project_members`
   * row — a Workspace Admin among them. Resolving names from it alone made a Dev Owner that had
   * saved successfully read `No Entry` again after a reload: the value was in the database and on the
   * feed, and only its NAME was missing, which on screen is indistinguishable from an unset field.
   * `member-options` returns inactive members too, for exactly this reason.
   */
  const { data: directory = [] } = useWorkspaceMemberOptions(workspace?.workspaceId)

  const memberMap = useMemo(
    // Project rows LAST so they win on a duplicate: same person, same fields, but that feed is the
    // one whose shape the pickers are typed against.
    () => new Map([...directory, ...members].map((m) => [m.userId, m])),
    [directory, members],
  )

  const [chosenId, setChosenId] = useState<string | null>(null)
  const [selectorOpen, setSelectorOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [sortCol, setSortCol] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [pageSize, setPageSize] = useState<number>(25)
  const [page, setPage] = useState<number>(1)

  // List (grid) vs Board (Kanban) view — the BA-spec toggle for Iteration
  // Status. Persisted so the choice survives navigation/reload. The Board view
  // reuses the shared IterationBoard widget over the SAME read-model.
  const [viewMode, setViewMode] = useState<'list' | 'board'>(() =>
    localStorage.getItem(STORAGE_KEYS.ITERATION_STATUS_VIEW_MODE) === 'board' ? 'board' : 'list',
  )
  const setViewModePersisted = useCallback((mode: 'list' | 'board') => {
    setViewMode(mode)
    localStorage.setItem(STORAGE_KEYS.ITERATION_STATUS_VIEW_MODE, mode)
  }, [])

  // Shared table engine (identical to projects/releases): resize + reorder + show/hide.
  const table = useDataTable<unknown, unknown, ColKey>(ITERATION_STATUS_COLUMNS, {
    storageKey: STORAGE_KEYS.ITERATION_STATUS_COLUMNS,
  })
  const { startResize, order, hidden, toggleVisible, reorder } = table

  useEffect(() => {
    if (projectId) {
      const persisted = localStorage.getItem(`${STORAGE_KEYS.LAST_ACCESSED_ITERATION}:${projectId}`)
      setChosenId(persisted)
    } else {
      setChosenId(null)
    }
  }, [projectId])

  // `defaultIterationId`, NOT `iterations[0]`: the feed is ordered for the reader (newest first), and
  // a default read off row order opens a sprint that has not started — no rows, which reads as an
  // empty sprint rather than the wrong one. See that function for the rule.
  const selectedId =
    chosenId && iterations.some((i) => i.id === chosenId)
      ? chosenId
      : defaultIterationId(iterations)

  const setSelectedId = useCallback(
    (id: string | null) => {
      setChosenId(id)
      if (projectId) {
        if (id) {
          localStorage.setItem(`${STORAGE_KEYS.LAST_ACCESSED_ITERATION}:${projectId}`, id)
        } else {
          localStorage.removeItem(`${STORAGE_KEYS.LAST_ACCESSED_ITERATION}:${projectId}`)
        }
      }
    },
    [projectId],
  )

  // ── Manage Filters (P2-IS-FR-022) ─────────────────────────────────────────
  // The shared chooser from `features/work-items`, the same one Backlog uses —
  // P2-IS §5 makes this screen inherit the Backlog list patterns rather than
  // grow its own. Every field is a SERVER predicate: Schedule State, Owner and
  // Blocked used to narrow the already-fetched rows, which answers "which of the
  // rows we loaded match?" rather than "which rows match?".
  const filterFields = useIterationFilterFields({ members })
  const filters = useManageFilters(filterFields)
  const appliedFilters = useMemo(() => toIterationStatusQuery(filters.applied), [filters.applied])

  const {
    data: status,
    isLoading,
    isError,
  } = useIterationStatus(selectedId ?? undefined, {
    ...appliedFilters,
    // Quick search is independent of Manage Filters (P2-IS-FR-020: "Quick search
    // `Filter items...` remains outside Manage Filters"; P2-BL-TS-015).
    q: search.trim() || undefined,
  })

  const selectedIndex = useMemo(
    () => iterations.findIndex((i) => i.id === selectedId),
    [iterations, selectedId],
  )
  const selected = iterations[selectedIndex]

  // Iteration picker feed for inline REASSIGNMENT — the ELIGIBILITY feed, scoped to the current
  // iteration's team so every option is genuinely assignable (the backend enforces the same
  // team-scope rule via assertIterationAssignable). Every STATE is offered, including a closed
  // sprint: P6-VEL-004: the same assignment has to be reachable from all three surfaces.
  const { data: iterationOptions = [] } = useAssignableIterations(projectId, selected?.teamId)

  const items = status?.items ?? EMPTY_ITEMS

  /**
   * Step to the EARLIER or LATER iteration — chronology, not row order.
   *
   * The feed is ordered newest-first for the reader (see `defaultIterationId`), so `index - 1` is
   * the LATER sprint and `index + 1` the earlier one. The toolbar used to pass `-1` for its left
   * chevron and `+1` for its right, which made both arrows point the opposite way from the
   * direction their icons communicate: from KB Sprint 1 the left chevron advanced to KB Sprint 2.
   * Reported from Production on 2026-08-21.
   *
   * `stepIndexInTime` (`shared/lib/step-in-time.ts`) is the fix, not the arithmetic: a caller now
   * names the DIRECTION IN TIME it wants, so a later change to the feed's order cannot silently
   * reverse the arrows again — the same rule `TimeboxPicker`'s chevrons follow. Both
   * `hasEarlier`/`hasLater` derive from the same call, so a disabled state cannot disagree with the
   * step it guards.
   */
  const stepIteration = useCallback(
    (direction: 'earlier' | 'later') => {
      const next = stepIndexInTime(iterations, selectedIndex, direction)
      if (next !== null) setSelectedId(iterations[next].id)
    },
    [selectedIndex, iterations, setSelectedId],
  )
  // Derived from the SAME call the step uses, so a disabled arrow and the step it guards cannot
  // disagree about which end of the list they are at.
  const hasEarlier = stepIndexInTime(iterations, selectedIndex, 'earlier') !== null
  const hasLater = stepIndexInTime(iterations, selectedIndex, 'later') !== null
  // The selected iteration's own team, read OUTSIDE the row map: `selected` is shadowed in there by
  // each row's own selection flag.
  const selectedIterationTeamId = selected?.teamId ?? null

  const toggleSort = useCallback(
    (col: string) => {
      // NOTE: never nest a state setter inside another setter's updater —
      // StrictMode double-invokes updaters, which would fire the toggle twice
      // and cancel it out (symptom: "sort only works on the first click").
      if (sortCol === col) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
      } else {
        setSortCol(col)
        setSortDir('asc')
      }
    },
    [sortCol],
  )

  // No client-side filter pass: `items` IS the filtered set, because every
  // Manage Filters field and the quick search are server predicates.
  const sortedItems = useMemo(
    () => sortStatusRows(items, sortCol, sortDir),
    [items, sortCol, sortDir],
  )

  // ── Client-side pagination ──────────────────────────────────────────────
  // An iteration is a bounded dataset (the fetch loads the full sprint), so we
  // paginate the already-loaded/sorted/filtered rows in the client. This keeps
  // multi-column sort and rank drag working across the whole set while still
  // giving an offset-style footer (Page N of M, total count).
  const pageCount = Math.max(1, Math.ceil(sortedItems.length / pageSize))
  // Snap back to the first page whenever the underlying view identity changes
  // (project/iteration, search, filters, sort, or page size).
  const pageResetKey = `${selectedId ?? ''}|${search}|${JSON.stringify(filters.applied)}|${sortCol ?? ''}|${sortDir}|${pageSize}`
  const [syncedPageKey, setSyncedPageKey] = useState(pageResetKey)
  if (syncedPageKey !== pageResetKey) {
    setSyncedPageKey(pageResetKey)
    setPage(1)
  }
  const currentPage = Math.min(page, pageCount)
  const pagedItems = useMemo(
    () => sortedItems.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [sortedItems, currentPage, pageSize],
  )
  const goPrevPage = useCallback(() => setPage((p) => Math.max(1, p - 1)), [])
  const goNextPage = useCallback(() => setPage((p) => p + 1), [])

  // ── Rank drag-and-drop (only meaningful in default rank order) ──────────
  const rankMutation = useRankAnyWorkItem()
  // Pointer AND keyboard, from the one shared definition. This was a hand-rolled pointer-only set,
  // which is why rank reorder here could not be done without a mouse.
  const dndSensors = useRerankSensors()
  const [localItems, setLocalItems] = useState<IterationStatusItem[]>(pagedItems)
  const [syncedItems, setSyncedItems] = useState(pagedItems)
  if (syncedItems !== pagedItems) {
    setSyncedItems(pagedItems)
    setLocalItems(pagedItems)
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id || sortCol) return
    const oldIndex = localItems.findIndex((it) => it.id === active.id)
    const newIndex = localItems.findIndex((it) => it.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    const reordered = arrayMove(localItems, oldIndex, newIndex)
    setLocalItems(reordered)
    const beforeId = newIndex > 0 ? reordered[newIndex - 1].id : null
    const afterId = newIndex < reordered.length - 1 ? reordered[newIndex + 1].id : null
    if (!projectId) return
    rankMutation.mutate(
      {
        id: active.id as string,
        projectId,
        beforeId: beforeId ?? undefined,
        afterId: afterId ?? undefined,
      },
      { onError: (err) => toast.error(err.message) },
    )
  }

  // ── Bulk selection ──────────────────────────────────────────────
  const selection = useRowSelection(localItems)
  const bulkUpdate = useUpdateAnyWorkItem()
  const copyItem = useCreateIterationItem(selectedId ?? '')

  // Copy = duplicate the single selected Story/Defect into the current iteration
  // (Rally "Copy"; disabled when more than one row is selected). Delete is
  // handled by the shared BulkDeleteCopy in the bulk bar.
  async function copySelected() {
    if (!selectedId || selection.count !== 1) return
    const src = items.find((i) => selection.selectedIds.has(i.id))
    if (!src || (src.type !== 'story' && src.type !== 'defect')) return
    try {
      await copyItem.mutateAsync({
        type: src.type,
        title: `${src.title} (copy)`,
        ...(src.planEstimate != null ? { planEstimate: src.planEstimate } : {}),
      })
      selection.clear()
      toast.success('Item copied')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Copy failed')
    }
  }

  // ── Totals ─────────────────────────────────────────────────────────────
  // `P2-IS-FR-016B/016C`. The formula lives in `iterationStatusTotals` (see its docblock for why
  // Task Est is `To Do + Actual` rather than the column's own sum) so it can be asserted without
  // mounting the page.
  const totals = useMemo(() => iterationStatusTotals(items), [items])

  // ── Metrics ────────────────────────────────────────────────────────────
  const metrics = status?.metrics
  // NULL means "no velocity target set", which is not the same as 0% attainment — the
  // service stopped flattening it, so this must not flatten it back.
  const velocityPct = metrics?.plannedVelocityPercent ?? null
  const acceptedPct = metrics?.acceptedPercent ?? 0
  // Kept nullable: an iteration with NO end date has no days-left, and `?? 0` fed the
  // elapsed-bar arithmetic below where it reads as "the whole iteration has elapsed".
  const daysLeft = metrics?.daysLeft ?? null
  const tDays = computeTotalDays(selected)
  // An iteration is finished once it's been accepted or explicitly completed —
  // regardless of the raw end-date arithmetic (which reads 0/negative when past
  // due and otherwise misleadingly shows "0 days left" on a done sprint).
  // `state === 'accepted'` alone: `iterations.completed_at` is the ACCEPTANCE stamp and the service
  // writes it on accept and clears it on every other transition (`iterations.service.ts`), so the
  // two are maintained in lockstep and the reference feed deliberately does not carry it.
  const iterationDone = selected?.state === 'accepted'
  // Elapsed / total, capped at 100%; a finished iteration always shows full.
  const iterationProgressPct = iterationDone
    ? 100
    : tDays > 0 && daysLeft !== null
      ? Math.min(((tDays - Math.max(daysLeft, 0)) / tDays) * 100, 100)
      : 0
  // Single source of truth for the "Iteration End" widget value/label/colour so
  // Done and Overdue states never degrade to a misleading "0 days left".
  const iterationEnd: { value: string; label: string; color: string } = iterationDone
    ? { value: 'Done', label: 'Completed', color: BRAND.success }
    : metrics?.daysLeft == null
      ? { value: '--', label: 'no end date', color: BRAND.warning }
      : metrics.daysLeft < 0
        ? {
            value: String(Math.abs(metrics.daysLeft)),
            label: metrics.daysLeft === -1 ? 'day overdue' : 'days overdue',
            color: BRAND.danger,
          }
        : { value: String(metrics.daysLeft), label: `of ${tDays} days left`, color: BRAND.warning }

  // Column sizing comes straight from the shared engine — see `useDataTable().colStyles`.
  //
  // This used to name all nineteen columns by hand, so every column added to
  // ITERATION_STATUS_COLUMNS needed a matching line here or it rendered unsized. The bases were
  // discarded anyway: `styleFor`'s fixed-width branch overwrites `flex` outright.
  const colStyles = table.colStyles

  // ── Empty / guard states ──────────────────────────────────────────────
  if (!projectId) {
    return (
      <div
        className="flex flex-1 items-center justify-center text-foreground-subtle"
        style={{ fontSize: 13 }}
      >
        {t('selectProject')}
      </div>
    )
  }

  // Guard the empty state behind the iterations fetch — a first direct visit must
  // show Loading, never a false "no iterations" flash before the query settles.
  if (iterationsLoading) {
    return (
      <div
        className="flex flex-1 items-center justify-center text-foreground-subtle"
        style={{ fontSize: 13 }}
      >
        {t('common:loading')}
      </div>
    )
  }

  if (!iterations.length) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 text-foreground-subtle"
        style={{ fontSize: 13 }}
      >
        <span>{t('noIterations')}</span>
        {/* Offered only to a reader who can open Timeboxes — §3.2:82 hides that surface from an
            Editor, for whom this was the one next step on an empty screen and it landed on Access
            Denied. Same fix as Team Status' identical affordance. */}
        {can(PERMISSION.TIMEBOX_VIEW) && (
          <button
            onClick={() => navigate({ to: '/timeboxes' })}
            className="text-primary"
            style={{
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              background: 'none',
              border: 'none',
              textDecoration: 'none',
            }}
            onMouseOver={(e) => {
              ;(e.target as HTMLElement).style.textDecoration = 'underline'
            }}
            onMouseOut={(e) => {
              ;(e.target as HTMLElement).style.textDecoration = 'none'
            }}
          >
            {t('goToTimeboxes')}
          </button>
        )}
      </div>
    )
  }

  return (
    <div
      className="flex flex-1 flex-col overflow-hidden bg-card text-foreground"
      style={{ fontSize: 12 }}
    >
      {/* ── Single page header: title + iteration picker ────────────────── */}
      <IterationHeader
        iterations={iterations}
        selected={selected}
        selectedId={selectedId}
        setSelectedId={setSelectedId}
        stepIteration={stepIteration}
        hasEarlier={hasEarlier}
        hasLater={hasLater}
        selectorOpen={selectorOpen}
        setSelectorOpen={setSelectorOpen}
        viewMode={viewMode}
        setViewMode={setViewModePersisted}
      />

      <MetricsStrip
        metrics={metrics}
        velocityPct={velocityPct}
        acceptedPct={acceptedPct}
        iterationEnd={iterationEnd}
        iterationProgressPct={iterationProgressPct}
      />

      <Toolbar
        search={search}
        setSearch={setSearch}
        canCreate={canCreate}
        onAddNew={() => setShowAdd(true)}
        columns={ITERATION_STATUS_COLUMNS}
        order={order}
        hidden={hidden}
        toggleVisible={toggleVisible}
        reorder={reorder}
        filters={filters}
      />

      {/* ── 6. Table (List view) or Board view ───────────────────────────── */}
      {/* Bulk bar (Delete + Copy) is rendered by SelectableTable in List view. */}
      {viewMode === 'board' ? (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {isLoading ? (
            <SkeletonList rows={6} cols={6} />
          ) : isError ? (
            <div className="flex h-full items-center justify-center text-ui-lg text-destructive">
              {t('boardLoadError')}
            </div>
          ) : items.length === 0 ? (
            <div className="flex h-full items-center justify-center text-ui-lg text-foreground-subtle">
              {t('emptyItems')}
            </div>
          ) : (
            <IterationBoard
              items={items}
              memberMap={memberMap}
              canEdit={canEdit}
              onOpen={(itemKey) => navigate({ to: '/item/$itemKey', params: { itemKey } })}
              onMove={(id, target) =>
                bulkUpdate
                  .mutateAsync({ id, input: { scheduleState: target } })
                  .then(() => undefined)
              }
            />
          )}
        </div>
      ) : (
        <SelectableTable
          rows={localItems}
          selection={selection}
          headerProps={{
            columns: HEADER_META,
            colStyles,
            onResize: startResize,
            sort: { col: sortCol, dir: sortDir, onSort: toggleSort },
            columnDrag: table.columnDrag,
          }}
          padClassName="pr-3 pl-1"
          bodyBackground={BRAND.surface}
          bulkActions={
            canEdit
              ? (sel) => (
                  <BulkDeleteCopy
                    canDelete={can('work_item:delete')}
                    selection={sel}
                    projectId={projectId ?? ''}
                    onCopy={copySelected}
                    copyPending={copyItem.isPending}
                  />
                )
              : undefined
          }
          dnd={{
            dndContextProps: {
              sensors: dndSensors,
              collisionDetection: closestCenter,
              onDragEnd: handleDragEnd,
            },
            sortableContextProps: {
              items: localItems.map((it) => it.id),
              strategy: verticalListSortingStrategy,
            },
          }}
          totals={
            !isLoading && !isError && items.length > 0 ? (
              <TableFooterTotals colStyles={colStyles} totals={totals} />
            ) : undefined
          }
          loading={isLoading}
          skeleton={{ rows: 10, cols: 12 }}
          error={
            isError ? (
              <div
                className="flex items-center justify-center text-destructive"
                style={{ height: 160, fontSize: 12 }}
              >
                {t('loadError')}
              </div>
            ) : undefined
          }
          empty={
            items.length === 0 ? (
              <div
                className="flex items-center justify-center text-foreground-subtle"
                style={{ height: 160, fontSize: 12 }}
              >
                {t('emptyItems')}
              </div>
            ) : undefined
          }
          footer={
            !isLoading && !isError && sortedItems.length > 0 ? (
              <PaginationFooter
                pageSize={pageSize}
                setPageSize={setPageSize}
                currentPage={currentPage}
                rangeStart={(currentPage - 1) * pageSize + 1}
                rangeEnd={(currentPage - 1) * pageSize + pagedItems.length}
                total={sortedItems.length}
                pageCount={pageCount}
                hasPrevPage={currentPage > 1}
                hasNextPage={currentPage < pageCount}
                onPrevPage={goPrevPage}
                onNextPage={goNextPage}
              />
            ) : undefined
          }
          renderRow={(item, { selected, onToggleSelect }) => (
            <StatusRow
              key={item.id}
              item={item}
              rank={(currentPage - 1) * pageSize + localItems.indexOf(item) + 1}
              memberMap={memberMap}
              projectId={projectId ?? ''}
              fallbackTeamId={selectedIterationTeamId}
              milestoneOptions={milestoneOptions}
              iterationOptions={iterationOptions}
              selectedIterationId={selectedId!}
              canEdit={canEdit}
              // §3.2:85 hides Portfolio Items from an Editor, so the Feature cell must name the
              // Feature without offering a journey into Access Denied.
              canOpenPortfolio={can(PERMISSION.PORTFOLIO_VIEW)}
              colStyles={colStyles}
              dragEnabled={!sortCol}
              selected={selected}
              onToggleSelect={onToggleSelect}
              onOpen={() =>
                navigate({
                  to: '/item/$itemKey',
                  params: { itemKey: item.itemKey },
                })
              }
            />
          )}
        />
      )}

      {/* ── Add Item modal ───────────────────────────────────────────────── */}
      {showAdd && selected && (
        <AddItemModal
          iteration={selected}
          projectId={projectId}
          onClose={() => setShowAdd(false)}
          onCreated={() => setShowAdd(false)}
        />
      )}
    </div>
  )
}
