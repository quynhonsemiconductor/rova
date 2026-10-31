/**
 * Backlog Page — P1-BACKLOG-LIST
 *
 * Shows Story + Defect work items for the active project with:
 *  - search (title / itemKey)
 *  - type filter (Story / Defect)
 *  - schedule state filter
 *  - server-side pagination
 *  - resizable columns (persisted in localStorage)
 *  - "Create Work Item" modal
 */
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { PageToolbar } from '@/shared/ui/page-toolbar'
import { ListPageHeader } from '@/shared/ui/list-page/list-page-header'
import { Button } from '@/shared/ui/button'
import { RowGutter } from '@/shared/ui/row-gutter'
import { SearchableSelect } from '@/shared/ui/searchable-select'
import { PaginationFooter } from '@/shared/ui/pagination-footer'
import { InlineEditableCell } from '@/shared/ui/inline-editable-cell'
import { OwnerSelectCell, type OwnerSelectMember } from '@/shared/ui/owner-cell'
import { BulkDeleteCopy } from '@/features/work-items/ui/bulk-delete-copy'
import { RankEdgeActions } from '@/features/work-items/ui/rank-edge-actions'
import { BulkScheduleActions } from '@/features/work-items/ui/bulk-schedule-bar'
import { useRowSelection } from '@/shared/lib/hooks/use-row-selection'
import { useAppContext } from '@/shared/lib/stores/app-context.store'
import { useProjectPermissions } from '@/features/access/api'
import {
  useBacklog,
  useUpdateWorkItem,
  useRankAnyWorkItem,
  useCreateWorkItem,
  type WorkItem,
  type UpdateWorkItemInput,
} from '@/features/work-items/api'
import { useReleases } from '@/features/releases/api'
import { EMPTY_VALUE } from '@/shared/lib/utils'
import { PERMISSION } from '@/shared/config/permissions'
import { useProjectMemberOptions } from '@/features/teams/api'
import { useAssignableIterations, useIterationOptions } from '@/features/iterations/api'
import { StateStepper } from '@/entities/work-item/ui/state-stepper'
import { IdCell } from '@/entities/work-item/ui/id-cell'
import { defaultRecordHref } from '@/entities/work-item/model/record-href'
import { RecordOpener } from '@/shared/ui/record-link'
import { TypeBadge } from '@/entities/work-item/ui/badges'
import { SCHEDULE_STATE_STEPS } from '@/entities/work-item/ui/state-steps'
import {
  SCHEDULE_STATE_LABEL,
  SCHEDULE_STATE_VALUES,
  PRIORITY_VALUES,
  PRIORITY_LABEL,
  type ScheduleState,
} from '@/entities/work-item/model/types'
import { BRAND } from '@/shared/config/brand'
import { STORAGE_KEYS } from '@/shared/config/storage-keys'
import { CreateWorkItemModal } from '@/features/work-items/ui/create-work-item-modal'
import type { ColumnDef } from '@/shared/lib/hooks/use-column-layout'
import { BACKLOG_COLUMNS, BACKLOG_HEADER_COLUMNS, type ColumnKey } from './model/columns'
import {
  useBacklogFilterFields,
  toBacklogQuery,
  type BacklogFilterKey,
} from './model/filter-fields'
import {
  useManageFilters,
  type ManageFiltersState,
} from '@/features/work-items/model/manage-filters'
import { ManageFiltersBar } from '@/features/work-items/ui/manage-filters-bar'
import { ColumnFieldsMenu } from '@/shared/ui/column-fields-menu'
import { useDataTable, useRerankSensors, SelectableTable, RankCell } from '@/shared/ui/table'
import { useSummarySelection } from '@/features/work-items/summary-selection'
import { WorkItemSummaryPanel } from './ui/work-item-summary-panel'

export function BacklogPage() {
  const { t } = useTranslation('backlog')
  const navigate = useNavigate()
  const { project, team } = useAppContext()
  const projectId = project?.projectId

  const { can } = useProjectPermissions(projectId)
  const canEdit = can('work_item:edit')
  // `release:view` — the code the server checks before letting a write move `releaseId`.
  const canAssignRelease = can(PERMISSION.RELEASE_VIEW)

  // ── Filters ──────────────────────────────────────────────────────────────────
  // Quick search is the page's OWN state and its own `q` parameter — P2-BL-TS-015
  // requires it to keep working independently of the Manage Filters set, so it is
  // never a Manage Filters field and never waits for Apply.
  const [search, setSearch] = useState('')
  const [pageSize, setPageSize] = useState<number>(25)
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [cursorHistory, setCursorHistory] = useState<string[]>([])
  const currentPage = cursorHistory.length + 1

  // ── Sort ───────────────────────────────────────────────────────────────────
  // Server-side column sort. `null` = default rank order (drag-and-drop enabled).
  const [sortCol, setSortCol] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const toggleSort = useCallback(
    (col: string) => {
      if (sortCol === col) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
      } else {
        setSortCol(col)
        setSortDir('asc')
      }
    },
    [sortCol],
  )

  // Reference lists for the P2.1 filters, inline selects and id→name lookups.
  // The assignee feed, NOT the administrative roster: that one is Admin-only (§3.1:71), and
  // defaulting its 403 to `[]` made every owned item read `Unassigned` for an Editor.
  const { data: members = [] } = useProjectMemberOptions(projectId)
  const { data: releases = [] } = useReleases(projectId)
  // ELIGIBILITY. Populates the inline-edit <option> list, the filter dropdown and Bulk Assign
  // Iteration: every one of those WRITES, so the population must be the one the server accepts —
  // which INCLUDES a closed (accepted) sprint since P6-VEL-004. The BA's repro is here: US-2 could be
  // moved out of the finished Carryover Sprint and Velocity dropped 8 → 3, and then this dropdown
  // offered only `--` and the empty sprint, so the original assignment could not be restored.
  const { data: iterationOptions = [] } = useAssignableIterations(projectId, team?.teamId)
  // REFERENCE — every state. Resolves an already-set iterationId to its name. Reusing
  // `iterationOptions` here silently rendered a dash for any item whose iteration had since become
  // Accepted, even though the relation was genuinely set (see RELATION_DATA_TRACEABILITY.md) — the
  // two feeds are separate endpoints for exactly this reason. It used to read `GET /iterations`, the
  // timebox RECORD, which is `timebox:view` and so 403'd every project Editor on this grid.
  const { data: allIterations = [] } = useIterationOptions(projectId, team?.teamId)

  // Bulk Assign Release/Iteration choices — same composite "KEY: name" labels as
  // the inline row pickers, so the bulk bar and per-row selects stay consistent.
  // The eligibility feed backs both, so the bulk bar offers exactly what a single row does.
  const releaseChoices = useMemo(
    () =>
      releases.map((r) => ({
        id: r.id,
        name: r.releaseKey ? `${r.releaseKey}: ${r.name}` : r.name,
      })),
    [releases],
  )
  const iterationChoices = useMemo(
    () =>
      iterationOptions.map((it) => ({
        id: it.id,
        name: it.iterationKey ? `${it.iterationKey}: ${it.name}` : it.name,
      })),
    [iterationOptions],
  )

  // ── Manage Filters (P2-BL-FR-005 / -020, AC-7) ────────────────────────────────
  // The chooser and its controls live in `features/work-items` and are shared with
  // Iteration Status. Every field key IS a server query parameter, so `applied`
  // spreads straight into the list query — nothing is filtered client-side, which
  // is what makes a match on page 7 findable.
  const filterFields = useBacklogFilterFields({ members, releases })
  const filters = useManageFilters(filterFields)
  const applied = toBacklogQuery(filters.applied)

  // "none yet" vs "no match" are different facts; one branch used to always blame filters.
  const emptyKey = search || filters.activeCount > 0 ? 'empty.noMatch' : 'empty.none'

  // Reset pagination on filter/project change (synchronously, before useBacklog reads cursor)
  const prevTeamRef = useRef(team?.teamId)
  if (prevTeamRef.current !== team?.teamId) {
    prevTeamRef.current = team?.teamId
    setCursor(undefined)
    setCursorHistory([])
  }
  useEffect(() => {
    setCursor(undefined)
    setCursorHistory([])
  }, [search, applied, pageSize, projectId, sortCol, sortDir])

  const { data, isLoading, isError, error } = useBacklog(projectId, {
    ...applied,
    teamId: team?.teamId || undefined,
    q: search || undefined,
    sort: sortCol ? `${sortCol}:${sortDir}` : undefined,
    limit: pageSize,
    cursor,
  })

  const items = useMemo(() => data?.data ?? [], [data])
  const pageInfo = data?.pageInfo

  // ── Drag-and-drop (rank reorder within current page) ──────────────────────────
  // Local copy for optimistic reordering. Re-sync (during render, not in an
  // effect) whenever the server data reference changes.
  const [localItems, setLocalItems] = useState<WorkItem[]>(items)
  const [syncedItems, setSyncedItems] = useState(items)
  if (syncedItems !== items) {
    setSyncedItems(items)
    setLocalItems(items)
  }

  const rankMutation = useRankAnyWorkItem()
  // Pointer AND keyboard, one shared definition — this was a hand-rolled pointer-only set.
  const dndSensors = useRerankSensors()

  function handleDragEnd(event: DragEndEvent) {
    // Rank reorder is only meaningful in the default rank order; a column sort
    // detaches the visual order from rank, so drag is disabled while sorting.
    if (sortCol) return
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = localItems.findIndex((it) => it.id === active.id)
    const newIndex = localItems.findIndex((it) => it.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    const reordered = arrayMove(localItems, oldIndex, newIndex)
    setLocalItems(reordered)
    const beforeId = newIndex > 0 ? reordered[newIndex - 1].id : null
    const afterId = newIndex < reordered.length - 1 ? reordered[newIndex + 1].id : null
    rankMutation.mutate({
      id: active.id as string,
      projectId: localItems[oldIndex].projectId,
      beforeId: beforeId ?? undefined,
      afterId: afterId ?? undefined,
    })
  }

  // ── Selection ─────────────────────────────────────────────────────────────────
  const selection = useRowSelection(items)
  const createItem = useCreateWorkItem()
  async function copySelected() {
    const src = localItems.find((i) => selection.selectedIds.has(i.id))
    if (!src || !projectId) return
    try {
      await createItem.mutateAsync({
        projectId,
        type: src.type as 'story' | 'defect',
        title: `${src.title} (copy)`,
        priority: (src.priority ?? 'none') as 'none' | 'low' | 'normal' | 'high' | 'urgent',
        ...(src.teamId ? { teamId: src.teamId } : {}),
        ...(src.storyPoints != null ? { storyPoints: Number(src.storyPoints) } : {}),
      })
      selection.clear()
      toast.success('Item copied')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Copy failed')
    }
  }

  // ── Shared table engine (identical to projects/releases): resize + reorder + show/hide ──
  const table = useDataTable<WorkItem, unknown, ColumnKey>(BACKLOG_COLUMNS, {
    storageKey: STORAGE_KEYS.BACKLOG_COLUMN_WIDTHS,
  })
  const { startResize, order, hidden, toggleVisible, reorder, colStyles } = table

  // ── Navigation ────────────────────────────────────────────────────────────────
  function openItem(item: WorkItem) {
    void navigate({ to: '/item/$itemKey', params: { itemKey: item.itemKey } })
  }

  // ── Summary panel (WID-FR-003 / AC 7) ─────────────────────────────────────────
  // The item a collapse left selected. Only the KEY is held — see the store's docblock — so the
  // panel resolves the row itself and this page needs no extra query.
  const summaryItemKey = useSummarySelection((s) => s.itemKey)
  const clearSummary = useSummarySelection((s) => s.clear)

  function goNextPage() {
    if (!pageInfo?.hasNextPage || !pageInfo.nextCursor) return
    setCursorHistory((h) => [...h, cursor ?? ''])
    setCursor(pageInfo.nextCursor)
  }

  function goPrevPage() {
    if (cursorHistory.length === 0) return
    const prev = [...cursorHistory]
    const prevCursor = prev.pop()
    setCursorHistory(prev)
    setCursor(prevCursor || undefined)
  }

  // ── Create modal ─────────────────────────────────────────────────────────────
  const [showCreate, setShowCreate] = useState(false)
  const canCreate = can('work_item:create')

  // ── Render ────────────────────────────────────────────────────────────────────
  if (!projectId) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-ui-xl text-foreground-subtle">{t('selectProject')}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Title → toolbar. Backlog shows NO KPI/metric strip (P2-BL-FR-019 / AC#10). */}
      <ListPageHeader title={t('title')} />
      <BacklogToolbar
        search={search}
        setSearch={setSearch}
        filters={filters}
        canCreate={canCreate}
        onCreate={() => setShowCreate(true)}
        columns={BACKLOG_COLUMNS}
        order={order}
        hidden={hidden}
        toggleVisible={toggleVisible}
        reorder={reorder}
      />

      {/* Table — shared SelectableTable shell (selection gutter + BulkActionBar
          with Assign Release/Iteration + DnD wrap), consistent with Quality /
          Iteration Status / Tasks. The summary panel sits beside it (WID-FR-003). */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-1 flex-col overflow-hidden">
          <SelectableTable
            rows={localItems}
            selection={selection}
            headerProps={{
              columns: BACKLOG_HEADER_COLUMNS,
              colStyles,
              onResize: startResize,
              sort: { col: sortCol, dir: sortDir, onSort: toggleSort },
              columnDrag: table.columnDrag,
            }}
            padClassName="gap-2 px-3"
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
            bulkActions={(sel) =>
              canEdit ? (
                <>
                  {/* Rank Highest / Rank Lowest reach the true edges of the LIST, which drag cannot:
                    reorder is page-local and the backlog pages at 25. Hidden while sorted, for the
                    same reason drag is. */}
                  <RankEdgeActions
                    selection={sel}
                    projectId={projectId}
                    sorted={!!sortCol}
                    // The SAME applied filter set the grid is showing — Rank
                    // Highest/Lowest must reach the edges of THIS list, not of an
                    // unfiltered one.
                    filters={{
                      ...applied,
                      teamId: team?.teamId || undefined,
                      q: search || undefined,
                    }}
                  />
                  <BulkScheduleActions
                    projectId={projectId}
                    selectedIds={sel.selectedIds}
                    clearSelection={sel.clear}
                    releases={releaseChoices}
                    iterations={iterationChoices}
                    canEdit={canEdit}
                    canAssignRelease={canAssignRelease}
                  />
                  <BulkDeleteCopy
                    selection={sel}
                    canDelete={can('work_item:delete')}
                    projectId={projectId!}
                    onCopy={copySelected}
                    copyPending={createItem.isPending}
                  />
                </>
              ) : null
            }
            loading={isLoading}
            skeleton={{ rows: 10, cols: 7 }}
            error={
              isError ? (
                <div className="flex h-32 items-center justify-center">
                  <p className="text-ui-xl text-destructive">
                    {error instanceof Error ? error.message : t('loadError')}
                  </p>
                </div>
              ) : undefined
            }
            empty={
              items.length === 0 ? (
                <div className="flex h-32 flex-col items-center justify-center gap-2">
                  <p className="text-ui-xl text-foreground-subtle">{t(emptyKey)}</p>
                  <button
                    onClick={() => setShowCreate(true)}
                    disabled={!canCreate}
                    className="text-ui-md font-medium text-primary-light disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {t('createFirst')}
                  </button>
                </div>
              ) : undefined
            }
            footer={
              <PaginationFooter
                pageSize={pageSize}
                setPageSize={setPageSize}
                currentPage={currentPage}
                rangeStart={(currentPage - 1) * pageSize + 1}
                rangeEnd={(currentPage - 1) * pageSize + items.length}
                total={pageInfo?.total}
                hasPrevPage={currentPage > 1}
                hasNextPage={!!pageInfo?.hasNextPage}
                onPrevPage={goPrevPage}
                onNextPage={goNextPage}
              />
            }
            renderRow={(item, { selected, onToggleSelect }) => (
              <BacklogRow
                key={item.id}
                item={item}
                rowNum={(currentPage - 1) * pageSize + localItems.indexOf(item) + 1}
                selected={selected}
                active={item.itemKey === summaryItemKey}
                onToggleSelect={onToggleSelect}
                canAssignRelease={canAssignRelease}
                onOpen={() => openItem(item)}
                colStyles={colStyles}
                canEdit={canEdit}
                members={members}
                releases={releases}
                iterations={iterationOptions}
                allIterations={allIterations}
              />
            )}
          />
        </div>

        {/* Summary panel — the collapsed state of Work Item Detail (WID-FR-003). Present only
            while an item is selected; a collapse is what selects one. */}
        {summaryItemKey && (
          <WorkItemSummaryPanel
            itemKey={summaryItemKey}
            projectId={projectId}
            onClose={clearSummary}
            onExpand={() =>
              void navigate({ to: '/item/$itemKey', params: { itemKey: summaryItemKey } })
            }
          />
        )}
      </div>

      {/* Create modal */}
      {showCreate && (
        <CreateWorkItemModal
          projectId={projectId}
          onClose={() => setShowCreate(false)}
          onCreated={(item) => {
            setShowCreate(false)
            toast.success(
              t('created', {
                type: item.type === 'defect' ? t('typeDefect') : t('typeStory'),
                title: item.title,
              }),
            )
          }}
          onCreatedWithDetails={(item) => {
            setShowCreate(false)
            void navigate({ to: '/item/$itemKey', params: { itemKey: item.itemKey } })
          }}
        />
      )}
    </div>
  )
}

// ── Toolbar (title, search, filters, create button) ─────────────────────────

interface BacklogToolbarProps {
  search: string
  setSearch: (v: string) => void
  /** The shared Manage Filters model (P2-BL-FR-005 / -020). */
  filters: ManageFiltersState<BacklogFilterKey>
  canCreate: boolean
  onCreate: () => void
  columns: ColumnDef<ColumnKey>[]
  order: ColumnKey[]
  hidden: Set<ColumnKey>
  toggleVisible: (key: ColumnKey) => void
  reorder: (dragKey: ColumnKey, overKey: ColumnKey) => void
}

function BacklogToolbar({
  search,
  setSearch,
  filters,
  canCreate,
  onCreate,
  columns,
  order,
  hidden,
  toggleVisible,
  reorder,
}: BacklogToolbarProps) {
  const { t } = useTranslation('backlog')

  return (
    <PageToolbar
      // Quick search sits in the toolbar row, OUTSIDE the filter banner and
      // outside Manage Filters (P2-BL-FR-003, P2-BL-TS-015). It queries on its
      // own and never waits for Apply.
      search={{
        value: search,
        onChange: setSearch,
        placeholder: 'Search…',
        ariaLabel: 'Search backlog',
        width: 160,
      }}
      actions={
        <Button
          size="sm"
          onClick={onCreate}
          disabled={!canCreate}
          title={!canCreate ? 'You do not have permission to create work items' : undefined}
        >
          <Plus size={12} />
          {t('common:addNew')}
        </Button>
      }
      activeFilterCount={filters.activeCount}
      defaultFiltersOpen={filters.activeCount > 0}
      // Manage Filters is the FIRST node in the banner — P2-BL-FR-020 puts it on
      // the left — and it renders the chosen columns' own controls after itself.
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

// ── Backlog row with inline editing (P2-BL-07) ──────────────────────────────────

interface BacklogRowProps {
  item: WorkItem
  rowNum: number
  selected: boolean
  /** This row is the one shown in the summary panel (WID-AC-07's "selected item"). */
  active: boolean
  onToggleSelect: () => void
  onOpen: () => void
  colStyles: Record<ColumnKey, React.CSSProperties>
  canEdit: boolean
  /**
   * `release:view` — the code `WorkItemsService.assertMayAssignRelease` checks, so this cell and the
   * server agree on one code. False makes the cell READ-ONLY text rather than absent: `P3…:71` hides
   * the ACTION `Assign to Release` from an Editor, and the release a story sits in is still data on a
   * grid they own.
   */
  canAssignRelease: boolean
  /** The assignee feed (`useProjectMemberOptions`) — the shared picker shape, which permits null. */
  members: OwnerSelectMember[]
  releases: Array<{ id: string; name: string; releaseKey?: string | null }>
  iterations: Array<{ id: string; name: string; iterationKey?: string | null }>
  allIterations: Array<{ id: string; name: string; iterationKey?: string | null }>
}

// inline table selects use <InlineSelect> component directly

/**
 * The release a row sits in, as text. `EMPTY_VALUE` (`--`) for none, per its own docblock — never an
 * em-dash, and never a blank cell, which would read as "not loaded".
 */
function releaseLabel(
  releaseId: string | null | undefined,
  releases: Array<{ id: string; name: string; releaseKey?: string | null }>,
): string {
  if (!releaseId) return EMPTY_VALUE
  const match = releases.find((r) => r.id === releaseId)
  if (!match) return EMPTY_VALUE
  return match.releaseKey ? `${match.releaseKey}: ${match.name}` : match.name
}

function BacklogRow({
  item,
  rowNum,
  selected,
  active,
  onToggleSelect,
  onOpen,
  colStyles,
  canEdit,
  canAssignRelease,
  members,
  releases,
  iterations,
  allIterations,
}: BacklogRowProps) {
  const {
    setNodeRef,
    setActivatorNodeRef,
    listeners,
    attributes,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id })
  const update = useUpdateWorkItem(item.id)

  // Fire a PATCH only when the value actually changed; errors surface via the
  // mutation cache (the list re-reads the source of truth on invalidate).
  function patch(body: Parameters<typeof update.mutate>[0]) {
    update.mutate(body)
  }

  function commitTitle(next: string) {
    const trimmed = next.trim()
    if (trimmed && trimmed !== item.title) patch({ title: trimmed })
  }

  // The ROW names its own owner (`assigneeName`, joined server-side); the feed is the fallback. A
  // picker feed excludes Workspace Admins by design (AC-16), so a WA-owned row used to read blank here
  // for every role — see `ownerNameJoins` in the work-item repository.
  const ownerName =
    item.assigneeName ??
    (() => {
      const m = members.find((m) => m.userId === item.assigneeId)
      return m?.displayName ?? m?.email
    })()

  const stop = (e: React.MouseEvent) => e.stopPropagation()

  return (
    <div
      ref={setNodeRef}
      className="group flex min-h-[35px] items-center gap-2 border-b border-border-inner px-3 transition-colors duration-100 hover:bg-primary-lighter"
      style={{
        minWidth: 'max-content',
        backgroundColor: isDragging
          ? BRAND.primaryLighter
          : active
            ? BRAND.primaryLighter
            : selected
              ? BRAND.surfaceSubtle
              : undefined,
        opacity: isDragging ? 0.6 : 1,
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 1 : undefined,
        position: isDragging ? 'relative' : undefined,
      }}
    >
      {/* Leading gutter (rank grip + selection checkbox) — shared component so
          the header, rows and any nested rows stay column-aligned. */}
      <RowGutter
        ref={setActivatorNodeRef}
        dragListeners={listeners}
        dragAttributes={attributes}
        stopPropagation
        checkbox={{
          checked: selected,
          onChange: onToggleSelect,
          ariaLabel: `Select ${item.itemKey}`,
        }}
      />

      {/* Rank — a real column now, so it resizes/reorders/hides with the rest. */}
      <RankCell rowNum={rowNum} style={colStyles.rank} />

      {/* ID — type glyph + key link (shared cell; Name opens a new tab on Ctrl/middle-click too) */}
      <div className="shrink-0 overflow-hidden px-2" style={colStyles.id} onClick={stop}>
        <IdCell type={item.type} itemKey={item.itemKey} onOpen={onOpen} />
      </div>

      {/* Title — inline edit */}
      {/* `flex items-center`, like every sibling cell: the title WRAPS, so without it the cell grows
          taller than the row and the inline-edit hover outline is drawn around that overflowing box
          — which paints over the neighbouring column instead of inside this one. */}
      <div
        className="flex min-w-0 shrink-0 items-center px-0"
        style={colStyles.name}
        onClick={stop}
      >
        {canEdit ? (
          <InlineEditableCell
            value={item.title}
            canEdit
            fullCell
            onCommit={commitTitle}
            newTabHref={defaultRecordHref(item.type, item.itemKey)}
            className="break-words whitespace-normal text-foreground"
            style={{ cursor: 'text', fontSize: 12 }}
            inputStyle={{ fontSize: 12 }}
            ariaLabel="Title"
            title={item.title}
          />
        ) : (
          // Read-only: the Name opens the record, so it is a real link — Ctrl/middle-click open a
          // new tab natively (US-120 AC1) and a plain click keeps the in-app open.
          <RecordOpener
            href={defaultRecordHref(item.type, item.itemKey)}
            onOpen={onOpen}
            title={item.title}
            className="block break-words whitespace-normal text-foreground"
          >
            <span style={{ fontSize: 12 }}>{item.title}</span>
          </RecordOpener>
        )}
      </div>

      {/* Schedule State — Rally-style segmented stepper (shared control) */}
      <div className="shrink-0 overflow-hidden px-2" style={colStyles.scheduleState} onClick={stop}>
        <StateStepper
          steps={SCHEDULE_STATE_STEPS}
          value={item.scheduleState as ScheduleState}
          canEdit={canEdit}
          onChange={(next) =>
            patch({ scheduleState: next as UpdateWorkItemInput['scheduleState'] })
          }
          ariaLabel="Schedule state"
        />
      </div>

      {/* Flow State — shared SearchableSelect (enum dropdown) */}
      <div
        className="flex shrink-0 items-center overflow-hidden px-0"
        style={colStyles.flowState}
        onClick={stop}
      >
        <SearchableSelect
          value={item.flowState ?? item.scheduleState ?? ''}
          readOnly={!canEdit}
          ariaLabel="Flow state"
          options={SCHEDULE_STATE_VALUES.map((s) => ({ value: s, label: SCHEDULE_STATE_LABEL[s] }))}
          onChange={(v) => patch({ flowState: v as UpdateWorkItemInput['flowState'] })}
        />
      </div>

      {/* Priority — defects only */}
      <div
        className="flex shrink-0 items-center overflow-hidden px-0"
        style={colStyles.priority}
        onClick={stop}
      >
        {item.type === 'defect' ? (
          <SearchableSelect
            value={item.priority ?? ''}
            readOnly={!canEdit}
            ariaLabel="Priority"
            options={PRIORITY_VALUES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
            onChange={(v) => patch({ priority: v as UpdateWorkItemInput['priority'] })}
          />
        ) : (
          <span className="font-mono text-ui-xs text-foreground-disabled">--</span>
        )}
      </div>

      {/* Plan Estimate — shared InlineEditableCell */}
      <div className="shrink-0 px-0 text-center" style={colStyles.estimate} onClick={stop}>
        <InlineEditableCell
          value={item.storyPoints != null ? String(item.storyPoints) : ''}
          canEdit={canEdit}
          fullCell
          ariaLabel="Plan estimate"
          onCommit={(raw) => {
            const next = raw === '' ? null : Number(raw)
            // Plan Estimate = story points only. (Previously also wrote todoHours,
            // conflating story points with task To-Do hours — no SRS FR calls for
            // that, and it corrupted task-hour roll-ups.)
            if (next !== (item.storyPoints ?? null)) patch({ storyPoints: next })
          }}
          displayValue={item.storyPoints ?? '--'}
          // `tabular-nums` so digits keep a constant width down the column. Alignment stays
          // CENTERED here deliberately — that is this grid's existing layout, and the shared
          // contract's right-alignment is not worth a visible shift on an unrelated page.
          className="block text-center font-mono text-muted-foreground tabular-nums"
          style={{ fontSize: 12 }}
          inputClassName="w-full rounded border border-primary bg-transparent px-0.5 text-center font-mono text-inherit text-foreground focus:outline-none"
        />
      </div>

      {/* Owner — inline select */}
      <div
        className="flex shrink-0 items-center overflow-hidden px-0"
        style={colStyles.owner}
        onClick={stop}
      >
        <OwnerSelectCell
          ownerName={ownerName}
          assigneeId={item.assigneeId}
          members={members}
          canEdit={canEdit}
          onChange={(id) => patch({ assigneeId: id })}
        />
      </div>

      {/* Dev Owner — the SECOND responsibility, inline like Owner (`P2-BL-FR-012A`) */}
      <div
        className="flex shrink-0 items-center overflow-hidden px-0"
        style={colStyles.devOwner}
        onClick={stop}
      >
        <OwnerSelectCell
          /* Same candidate feed as Owner — the BA states one source for both (`WID-FR-016`) — and the
             same name-from-the-row rule, so a Dev Owner the picker cannot offer is still named. They
             persist INDEPENDENTLY: this patch never touches `assigneeId`. */
          ownerName={item.devOwnerName ?? undefined}
          assigneeId={item.devOwnerId}
          members={members}
          canEdit={canEdit}
          onChange={(id) => patch({ devOwnerId: id })}
          ariaLabel={`Dev owner for ${item.itemKey}`}
        />
      </div>

      {/* Release — shared SearchableSelect */}
      <div
        className="flex shrink-0 items-center overflow-hidden px-0"
        style={colStyles.release}
        onClick={stop}
      >
        {canAssignRelease ? (
          <SearchableSelect
            value={item.releaseId ?? ''}
            readOnly={!canEdit}
            ariaLabel="Release"
            placeholder="--"
            options={[
              { value: '', label: '--' },
              ...releases.map((r) => ({
                value: r.id,
                label: r.releaseKey ? `${r.releaseKey}: ${r.name}` : r.name,
                searchText: `${r.releaseKey ?? ''} ${r.name}`,
                icon: <TypeBadge type="release" size={16} />,
              })),
            ]}
            onChange={(v) => patch({ releaseId: v || null })}
          />
        ) : (
          /* Read-only: the ACTION is withheld (`P3…:71`), the VALUE is this column's data. A live
             select here was refused only on save, and the refusal discarded the rest of the row's
             pending edits with it. */
          <span className="truncate px-2 text-ui-sm text-foreground">
            {releaseLabel(item.releaseId, releases)}
          </span>
        )}
      </div>

      {/* Iteration — shared SearchableSelect */}
      <div
        className="flex shrink-0 items-center overflow-hidden px-0"
        style={colStyles.iteration}
        onClick={stop}
      >
        <SearchableSelect
          value={item.iterationId ?? ''}
          readOnly={!canEdit}
          ariaLabel="Iteration"
          placeholder="--"
          options={[
            { value: '', label: '--' },
            // Keep the current (possibly Accepted) iteration selectable even when
            // it's absent from the assignable `iterations` list.
            ...(item.iterationId && !iterations.some((it) => it.id === item.iterationId)
              ? [
                  (() => {
                    const cur = allIterations.find((it) => it.id === item.iterationId)
                    return {
                      value: item.iterationId,
                      label: cur?.iterationKey
                        ? `${cur.iterationKey}: ${cur.name}`
                        : (cur?.name ?? '--'),
                      icon: <TypeBadge type="iteration" size={16} />,
                    }
                  })(),
                ]
              : []),
            ...iterations.map((it) => ({
              value: it.id,
              label: it.iterationKey ? `${it.iterationKey}: ${it.name}` : it.name,
              searchText: `${it.iterationKey ?? ''} ${it.name}`,
              icon: <TypeBadge type="iteration" size={16} />,
            })),
          ]}
          onChange={(v) => patch({ iterationId: v || null })}
        />
      </div>

      {/*
       * NO trailing row-actions cell. Removed on the product owner's ruling, 2026-08-24, and this
       * note exists because putting it back is a one-line temptation that reopens two defects.
       *
       * WHAT IT LOOKED LIKE. A `⋮` menu holding Delete, in a cell marked `ml-auto`. Two things went
       * wrong with that, and only the first is obvious:
       *
       *  1. `ml-auto` inside a row whose `minWidth` is `max-content` pins the cell to the far right
       *     of the ROW, which is wider than the viewport on any grid that scrolls horizontally. The
       *     menu therefore detached from the row on scroll — it rendered mid-row, and its popover
       *     opened at the left edge of the screen, nowhere near the record it acted on.
       *  2. The HEADER has no matching trailing column (`BACKLOG_HEADER_COLUMNS` is the column list,
       *     and an affordance is deliberately not in it). So the header and the rows resolved to
       *     different total widths and every column drifted out of alignment with its own heading.
       *
       * `P2-BL-FR-022` / §124 ("Delete Defect | Row or detail action with confirmation") is what the
       * cell was added FOR, and removing it reverses that: Delete is now reachable from the bulk bar
       * (select the row first) and from the record's own detail page, not from the row itself. That
       * is a DECLARED REVERSAL of a BA finding the BA had raised twice — see
       * `docs/PR-487-BA-CONFLICTS.md`. If it comes back, it needs a real trailing COLUMN that the
       * header renders too, not an `ml-auto` cell the header knows nothing about.
       */}
    </div>
  )
}
