/**
 * Track › Team Status — P3.1
 *
 * Dense grouped table of task-level rows per iteration, grouped by
 * owner/member. Features inline editing for Capacity, Task Name, and Task State.
 * Iteration selector reuses the same pattern as Iteration Status.
 */
/* eslint-disable react-hooks/set-state-in-effect */
import { useState, useCallback, useEffect } from 'react'
import { toast } from 'sonner'
import { useNavigate } from '@tanstack/react-router'
import { ChevronDown, ChevronRight, Inbox } from 'lucide-react'
import { EmptyState } from '@/shared/ui/empty-state'
import { LoadErrorState } from '@/shared/ui/load-error-state'
import { listResource } from '@/shared/lib/query/resource'
import { WorkItemRefCell } from '@/entities/work-item/ui/work-item-ref-cell'
import { IdCell } from '@/entities/work-item/ui/id-cell'
import { TypeBadge } from '@/entities/work-item/ui/badges'
import { useAppContext } from '@/shared/lib/stores/app-context.store'
import { useProjectPermissions } from '@/features/access/api'
import { PERMISSION } from '@/shared/config/permissions'
import { useIterationOptions } from '@/features/iterations/api'
import {
  useTeamStatus,
  useUpdateCapacity,
  useUpdateTeamTask,
  type TeamStatusMemberGroup,
  type TeamStatusTaskRow,
  type TeamTaskState,
} from '@/features/team-status/api'
import { Avatar } from '@/shared/ui/avatar'
import { InlineSelect } from '@/shared/ui/native-select'
import { ListPageHeader } from '@/shared/ui/list-page/list-page-header'
import { PageToolbar } from '@/shared/ui/page-toolbar'
import { IterationPicker } from '@/shared/ui/timebox-picker'
import { DataTableFrame, useDataTable, type ColumnSpec, rankColumn } from '@/shared/ui/table'
import { PaginationFooter } from '@/shared/ui/pagination-footer'
import { NESTED_ROW_INDENT } from '@/shared/config/layout'
import { STORAGE_KEYS } from '@/shared/config/storage-keys'
import {
  WorkItemType,
  SIMPLIFIED_STATE_CONFIG,
  SIMPLIFIED_STATE_LABEL,
  SIMPLIFIED_STATE_ORDER,
} from '@/entities/work-item/model/types'
import { StateStepper } from '@/entities/work-item/ui/state-stepper'
import type { StateStep } from '@/entities/work-item/ui/state-steps'
import { EMPTY_VALUE } from '@/shared/lib/utils'
import { OwnerCell } from '@/shared/ui/owner-cell'
import { InlineEditableCell } from '@/shared/ui/inline-editable-cell'
import { TableTotalsRow } from '@/shared/ui/table-totals-row'
import { memberProgressPercent } from '@/features/team-status/progress'

const TEAM_TASK_STATES: TeamTaskState[] = ['Defined', 'In-Progress', 'Completed']

/**
 * Segmented-stepper steps for the Task State cell, in `TeamTaskState` terms.
 *
 * Derived from `SIMPLIFIED_STATE_ORDER` rather than re-listing the three states, so
 * this control and the simplified stepper on Iteration Status / the Tasks tab can
 * never disagree about order or colour. The bridge is exact and not a coincidence
 * worth relying on silently: `SIMPLIFIED_STATE_LABEL`'s values ARE the three
 * `TeamTaskState` strings, which is what lets the shared presentation data drive a
 * control whose wire type is the Team Status one. `SIMPLIFIED_STATE_STEPS` itself
 * cannot be reused — it emits a canonical `ScheduleState`, and this surface's PATCH
 * takes `Defined | In-Progress | Completed` (P3-TS-FR-022).
 *
 * `letter` is deliberately EMPTY. The stepper prints it inside the active box, and
 * SRS §5:87 / `P3-TS-FR-045` forbid the value collapsing to `D` / `P` / `C` — the
 * full label is rendered beside the track instead (see the cell).
 */
const TEAM_TASK_STATE_STEPS: StateStep<TeamTaskState>[] = SIMPLIFIED_STATE_ORDER.map((s) => ({
  value: SIMPLIFIED_STATE_LABEL[s] as TeamTaskState,
  label: SIMPLIFIED_STATE_LABEL[s],
  letter: '',
  activeBg: SIMPLIFIED_STATE_CONFIG[s].activeBg,
}))

type ColKey =
  | 'rank'
  | 'id'
  | 'name'
  | 'workProduct'
  | 'release'
  | 'state'
  | 'capacity'
  | 'estimate'
  | 'todo'
  | 'actuals'
  | 'owner'

const TEAM_STATUS_COLUMNS: ColumnSpec<TeamStatusTaskRow, unknown, ColKey>[] = [
  { ...rankColumn(), sortCol: undefined },
  { key: 'id', label: 'ID', defaultWidth: 132, minWidth: 120, locked: true },
  { key: 'name', label: 'Task Name', defaultWidth: 240, minWidth: 150, locked: true },
  { key: 'workProduct', label: 'Work Product', defaultWidth: 140 },
  { key: 'release', label: 'Release', defaultWidth: 96 },
  // 150, not 112: the cell is now the 48px segmented track plus a 6px gap plus the
  // full state label, and "In-Progress" needs ~78px at 12px — at 112 the label that
  // `P3-TS-FR-045` requires was the part that truncated.
  { key: 'state', label: 'State', defaultWidth: 150, minWidth: 132 },
  {
    key: 'capacity',
    label: 'Capacity',
    defaultWidth: 104,
    minWidth: 90,
    align: 'right',
    sortCol: 'capacity',
  },
  {
    key: 'estimate',
    label: 'Estimate',
    defaultWidth: 104,
    minWidth: 90,
    align: 'right',
    sortCol: 'estimate',
  },
  { key: 'todo', label: 'To Do', defaultWidth: 88, minWidth: 74, align: 'right', sortCol: 'todo' },
  {
    key: 'actuals',
    label: 'Actuals',
    defaultWidth: 96,
    minWidth: 80,
    align: 'right',
    sortCol: 'actuals',
  },
  { key: 'owner', label: 'Owner', defaultWidth: 96 },
]

/**
 * Member progress bar — Rally Team Status style: a percentage label above a
 * green fill bar. The percentage is task completion (actual / estimate hours,
 * capped at 100) per Team_Status SRS §10, shown for each member group row.
 */
function ProgressBar({ percent }: { percent: number }) {
  const clamped = Math.min(Math.max(percent, 0), 100)
  return (
    <div className="flex w-full flex-col gap-[3px]">
      <span className="text-ui-xs leading-none font-semibold text-success tabular-nums">
        {percent}%
      </span>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-border-subtle">
        <div className="h-full rounded-full bg-success" style={{ width: `${clamped}%` }} />
      </div>
    </div>
  )
}

export function TeamStatusPage() {
  const navigate = useNavigate()
  const { project, team } = useAppContext()
  const projectId = project?.projectId
  const teamId = team?.teamId
  const { can } = useProjectPermissions(projectId)
  const canEdit = can('team_status:edit')

  // ── Shared table engine (identical to projects/releases): resize + reorder + show/hide ──
  // Must be declared before any early returns to satisfy Rules of Hooks.
  const table = useDataTable<TeamStatusTaskRow, unknown, ColKey>(TEAM_STATUS_COLUMNS, {
    storageKey: STORAGE_KEYS.TEAM_STATUS_COLUMNS,
  })

  // Column sizing comes straight from the shared engine — see `useDataTable().colStyles`.
  //
  // This used to rebuild the map with `{ flex: 1, minWidth: 150 }` on Name, under a comment
  // saying that column grew to fill. It never did: `styleFor`'s fixed-width branch overwrites
  // `flex` outright, and `name` is not declared `grow`, so the base was discarded. Mark the
  // column `grow: true` in TEAM_STATUS_COLUMNS if that behaviour is actually wanted.
  const colStyles = table.colStyles

  // Team Status measures ONE team: offer its own team-scoped iterations plus the
  // shared (team_id IS NULL) ones — not every team's iterations in the project.
  // A resource, not `data ?? []`: the `!iterations.length` guard below prints "No iterations in
  // this project/team yet." **plus a "Go to Timeboxes →" call to action**, so a failed
  // `/v1/iterations` sent the reader off to create a sprint that already exists. Same defect,
  // same sentence shape, as Release Tracking's §5.1 branch.
  // The REFERENCE feed: §5 gives an Editor `Team Status | View`, and `GET /iterations` is
  // `timebox:view` — so reading the record here 403'd a surface the matrix grants.
  const iterationsQuery = useIterationOptions(projectId)
  const iterationFeed = listResource(iterationsQuery)
  const allIterations = iterationFeed.rows
  const iterations = teamId
    ? allIterations.filter((i) => i.teamId === teamId || i.teamId == null)
    : allIterations
  const [chosenId, setChosenId] = useState<string | null>(null)
  const [stateFilter, setStateFilter] = useState<TeamTaskState | 'all'>('all')
  // Column sort — orders the member groups by an aggregate (Capacity / Estimate
  // / To Do / Actuals). Same click-to-sort header wiring as Iteration Status.
  const [sortCol, setSortCol] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const toggleSort = useCallback(
    (col: string) => {
      if (sortCol === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
      else {
        setSortCol(col)
        setSortDir('asc')
      }
    },
    [sortCol],
  )

  useEffect(() => {
    if (projectId) {
      const persisted = localStorage.getItem(`${STORAGE_KEYS.LAST_ACCESSED_ITERATION}:${projectId}`)
      setChosenId(persisted)
    } else {
      setChosenId(null)
    }
  }, [projectId])

  const selectedId =
    chosenId && iterations.some((i) => i.id === chosenId) ? chosenId : (iterations[0]?.id ?? null)

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
    // `setChosenId` is listed because the React Compiler infers it as a dependency and refuses to
    // preserve the memo otherwise (`Compilation Skipped: Existing memoization could not be
    // preserved`). A `useState` setter is referentially stable, so naming it costs nothing and the
    // manual deps now match the inferred ones.
    [projectId, setChosenId],
  )

  const {
    data: status,
    isLoading,
    isError,
  } = useTeamStatus(projectId ?? undefined, teamId ?? undefined, selectedId ?? undefined)

  // ── Client-side pagination over member groups (Rally parity, 10/page) ──
  // The team-status response is a bounded per-iteration dataset, so we paginate
  // the loaded/filtered member groups client-side. Totals remain across the
  // whole roster (computed server-side), independent of the visible page.
  const [pageSize, setPageSize] = useState(10)
  const [page, setPage] = useState(1)
  // Snap back to the first page whenever the view identity changes.
  const pageResetKey = `${selectedId ?? ''}|${pageSize}`
  const [syncedPageKey, setSyncedPageKey] = useState(pageResetKey)
  if (syncedPageKey !== pageResetKey) {
    setSyncedPageKey(pageResetKey)
    setPage(1)
  }
  const goPrevPage = useCallback(() => setPage((p) => Math.max(1, p - 1)), [])
  const goNextPage = useCallback(() => setPage((p) => p + 1), [])

  // ── Empty / guard states ─────────────────────────────────────────────

  if (!projectId) {
    return (
      <div className="flex flex-1 items-center justify-center text-ui-lg text-foreground-subtle">
        Select a project to view Team Status.
      </div>
    )
  }

  // Error before absence, and before the picker's own empty state: the copy below is a claim about
  // the project plus an instruction, and neither survives a request that did not land.
  if (iterationFeed.phase === 'error') {
    return <LoadErrorState error={iterationFeed.error} />
  }

  if (!iterations.length && !iterationFeed.isLoading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-ui-lg text-foreground-subtle">
        <span>No iterations in this project/team yet.</span>
        {/* The call to action is offered ONLY to a reader who can open the destination. §3.2:82 marks
            `Plan > Timeboxes` Hidden for an Editor, so for them this was the single next step on an
            otherwise empty screen and it landed on Access Denied — a dead end presented as the way
            out. With no route to offer, the sentence above stands on its own. */}
        {can(PERMISSION.TIMEBOX_VIEW) && (
          <button
            onClick={() => navigate({ to: '/timeboxes' })}
            className="cursor-pointer text-ui-md font-semibold text-primary-light hover:underline"
          >
            Go to Timeboxes →
          </button>
        )}
      </div>
    )
  }

  const totals = status?.totals
  const allGroups = status?.groups ?? []
  const hasFilter = stateFilter !== 'all'
  const groups = hasFilter
    ? allGroups
        .map((g) => {
          // Recompute the group aggregates from the FILTERED tasks so the header
          // ("N Tasks") and hours match the visible rows, not the full-group
          // server values. The Totals row is NOT recomputed here: P3-TS-FR-007B
          // says "Filters affect displayed rows, but the Totals row always covers
          // the full selected Iteration scope, never only the current page", so it
          // keeps the server's numbers.
          const tasks = g.tasks.filter((t) => t.state === stateFilter)
          const sumH = (key: 'estimateHours' | 'todoHours' | 'actualHours') =>
            tasks.reduce((s, t) => s + (Number(t[key]) || 0), 0)
          const estimateHours = sumH('estimateHours')
          const actualHours = sumH('actualHours')
          return {
            ...g,
            tasks,
            taskCount: tasks.length,
            estimateHours,
            todoHours: sumH('todoHours'),
            actualHours,
            // The SAME §10 formula the server applies to the unfiltered group — see
            // `memberProgressPercent`. This used to be a task-COUNT ratio, so the
            // bar changed definition the moment a filter was applied.
            progressPercent: memberProgressPercent(estimateHours, actualHours),
          }
        })
        .filter((g) => g.tasks.length > 0)
    : allGroups

  // Order the member groups by the active aggregate sort (Capacity / Estimate /
  // To Do / Actuals), then paginate. Plain const (runs after early returns).
  const sortAggregate = (g: (typeof groups)[number]): number =>
    sortCol === 'capacity'
      ? g.capacityHours
      : sortCol === 'estimate'
        ? g.estimateHours
        : sortCol === 'todo'
          ? g.todoHours
          : sortCol === 'actuals'
            ? g.actualHours
            : 0
  const sortedGroups = sortCol
    ? [...groups].sort(
        (a, b) => (sortAggregate(a) - sortAggregate(b)) * (sortDir === 'desc' ? -1 : 1),
      )
    : groups

  // Paginate the visible member groups (see hook block above).
  const pageCount = Math.max(1, Math.ceil(sortedGroups.length / pageSize))
  const currentPage = Math.min(page, pageCount)
  const pagedGroups = sortedGroups.slice((currentPage - 1) * pageSize, currentPage * pageSize)

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Title + iteration selector (no view toggle, no KPI strip) — matches the
          Iteration Status layout via the shared ListPageHeader + IterationPicker. */}
      <ListPageHeader
        title="Team Status"
        accessory={
          <IterationPicker
            iterations={iterations}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        }
      />
      {/* Shared toolbar — State filter only. No local search box (BA C4: real
          Rally Team Status uses Show Filters, not a dedicated search) and no
          Show Fields chooser (also BA C4). Pagination + the sortable header stay. */}
      <PageToolbar
        activeFilterCount={stateFilter !== 'all' ? 1 : 0}
        defaultFiltersOpen={stateFilter !== 'all'}
        filters={
          <label className="flex items-center gap-1.5 text-ui-sm font-semibold text-muted-foreground">
            State
            <InlineSelect
              value={stateFilter}
              aria-label="Filter by task state"
              onChange={(e) => setStateFilter(e.target.value as TeamTaskState | 'all')}
              className="w-auto"
            >
              <option value="all">All States</option>
              {TEAM_TASK_STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </InlineSelect>
          </label>
        }
      />

      {/* Table — shared DataTableFrame owns the scroll region, header, totals,
          loading/error/empty states and footer so every grid's chrome is
          identical. Team Status is a read-only report kind: sortable header +
          totals, no selection/drag gutter (just a w-6 spacer that its member
          rows also render). */}
      <DataTableFrame
        header={{
          ...table.headerProps,
          colStyles,
          sort: { col: sortCol, dir: sortDir, onSort: toggleSort },
        }}
        leading={<div className="w-6 shrink-0" />}
        totals={
          totals ? (
            <TableTotalsRow
              columns={TEAM_STATUS_COLUMNS}
              colStyles={colStyles}
              leading={<div className="w-6 shrink-0" />}
              label="Totals"
              values={{
                capacity: `${totals.capacityHours}h`,
                estimate: `${totals.estimateHours}h`,
                todo: `${totals.todoHours}h`,
                actuals: `${totals.actualHours}h`,
              }}
            />
          ) : undefined
        }
        loading={isLoading}
        skeleton={{ rows: 10, cols: 10 }}
        error={
          isError ? (
            <div className="flex h-40 items-center justify-center text-ui-md text-destructive">
              Failed to load team status. Please try again.
            </div>
          ) : undefined
        }
        empty={
          groups.length === 0 ? (
            <EmptyState
              icon={<Inbox size={36} className="text-foreground-faint" />}
              title="No tasks found for this iteration"
            />
          ) : undefined
        }
        footer={
          status ? (
            <PaginationFooter
              pageSize={pageSize}
              setPageSize={setPageSize}
              currentPage={currentPage}
              rangeStart={groups.length === 0 ? 0 : (currentPage - 1) * pageSize + 1}
              rangeEnd={(currentPage - 1) * pageSize + pagedGroups.length}
              total={groups.length}
              pageCount={pageCount}
              hasPrevPage={currentPage > 1}
              hasNextPage={currentPage < pageCount}
              onPrevPage={goPrevPage}
              onNextPage={goNextPage}
            />
          ) : undefined
        }
      >
        {/* Member groups (P3-TS-FR-014) */}
        {pagedGroups.map((group) => (
          <MemberGroup
            key={group.owner.id}
            group={group}
            projectId={projectId!}
            teamId={teamId}
            iterationId={selectedId!}
            canEdit={canEdit}
            colStyles={colStyles}
            onOpenItem={(itemKey) => {
              if (itemKey) navigate({ to: '/item/$itemKey', params: { itemKey } })
            }}
            onOpenRelease={(releaseId) => {
              if (releaseId) navigate({ to: '/releases/$releaseId', params: { releaseId } })
            }}
          />
        ))}
      </DataTableFrame>
    </div>
  )
}

// ── Member Group ────────────────────────────────────────────────────────────

function MemberGroup({
  group,
  projectId,
  teamId,
  iterationId,
  canEdit,
  colStyles,
  onOpenItem,
  onOpenRelease,
}: {
  group: TeamStatusMemberGroup
  projectId: string
  teamId: string | undefined
  iterationId: string
  canEdit: boolean
  colStyles: Record<string, React.CSSProperties>
  onOpenItem: (itemKey: string) => void
  onOpenRelease: (releaseId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const updateCapacity = useUpdateCapacity(projectId, teamId, iterationId)
  /**
   * The `Unassigned` group has no member to plan capacity for, so its Capacity cell is a READ.
   *
   * `owner.id` is the literal string `'unassigned'` on that group, and `UpdateCapacitySchema` requires
   * `userId` to be a uuid — so the cell was always a guaranteed 400 with a "Validation failed" toast
   * and no explanation. GAP-P3-TS-008 also fixes the group's population (an off-roster owner's task now
   * lands here rather than in a named group of its own), which makes the cell reachable far more often
   * than before: it must not be an inline edit that cannot succeed. The AC's own wording is the rule —
   * "Null-owner Tasks appear under Unassigned WITH 0h CAPACITY".
   */
  const isUnassignedGroup = group.owner.id === 'unassigned'

  function commitCapacity(raw: string) {
    const val = Number(raw)
    if (isNaN(val) || val < 0) {
      toast.error('Capacity must be a number >= 0')
      return
    }
    updateCapacity.mutate(
      { userId: group.owner.id, capacityHours: val },
      {
        onSuccess: () => toast.success(`Capacity updated for ${group.owner.displayName}`),
        onError: (e) => toast.error(e.message),
      },
    )
  }

  // The member label spans the fixed ID + Task Name columns. Match their exact
  // combined width (not flex-1) so the Capacity/Estimate/To Do/Actuals values
  // line up with the header and totals row instead of being pushed to the far
  // right by a growing flex column.
  const idNameWidth = (Number(colStyles.id?.width) || 0) + (Number(colStyles.name?.width) || 0)

  return (
    <div>
      {/* Group header row (P3-TS-FR-015) */}
      <div
        className="flex h-9 cursor-pointer items-center border-b border-border-inner bg-surface-hover px-3 hover:bg-surface-hover"
        style={{ minWidth: 'max-content' }}
        onClick={() => setExpanded((e) => !e)}
      >
        {/* Leading gutter (aligns with task-row drag/checkbox area) */}
        <div className="w-6 shrink-0" />
        <div className="shrink-0" style={colStyles.rank} /> {/* Rank column spacer */}
        {/* Member label — caret + avatar + name clustered at the ID column,
            matching Rally. Spans the ID + Task Name columns at their fixed
            combined width so downstream columns stay aligned with the header
            and totals row. Caret only renders for expandable members
            (P3-TS-FR-016). */}
        <div
          className="flex min-w-0 items-center gap-2 pl-2"
          style={{
            order: colStyles.id.order,
            width: idNameWidth,
            minWidth: idNameWidth,
            maxWidth: idNameWidth,
            flexShrink: 0,
            flexGrow: 0,
          }}
        >
          <span className="flex w-3 shrink-0 items-center justify-center">
            {group.taskCount > 0 &&
              (expanded ? (
                <ChevronDown size={12} className="text-muted-foreground" />
              ) : (
                <ChevronRight size={12} className="text-muted-foreground" />
              ))}
          </span>
          <Avatar name={group.owner.displayName} size={20} />
          <span className="truncate text-ui-sm font-semibold text-foreground">
            {group.owner.displayName}
          </span>
          <span className="shrink-0 text-ui-xs text-foreground-subtle">
            ({group.taskCount} Tasks)
          </span>
        </div>
        <div className="shrink-0" style={colStyles.workProduct} />
        <div className="shrink-0" style={colStyles.release} />
        {/* State column shows the member task-completion progress bar. */}
        <div className="flex shrink-0 flex-col justify-center px-2" style={colStyles.state}>
          <ProgressBar percent={group.progressPercent} />
        </div>
        {/* Capacity (editable on group row — P3-TS-FR-017) */}
        <div
          className="shrink-0 px-0 text-right"
          style={colStyles.capacity}
          onClick={(e) => e.stopPropagation()}
        >
          <InlineEditableCell
            fullCell
            value={String(group.capacityHours)}
            canEdit={canEdit && !isUnassignedGroup}
            onCommit={commitCapacity}
            className="font-mono text-ui-sm text-muted-foreground tabular-nums"
            inputClassName="text-right font-mono text-ui-sm text-foreground"
            ariaLabel="Capacity"
          />
        </div>
        <div
          className="shrink-0 px-2 text-right font-mono text-ui-sm text-muted-foreground tabular-nums"
          style={colStyles.estimate}
        >
          {group.estimateHours}
        </div>
        <div
          className="shrink-0 px-2 text-right font-mono text-ui-sm text-muted-foreground tabular-nums"
          style={colStyles.todo}
        >
          {group.todoHours}
        </div>
        <div
          className="shrink-0 px-2 text-right font-mono text-ui-sm text-muted-foreground tabular-nums"
          style={colStyles.actuals}
        >
          {group.actualHours}
        </div>
        <div className="shrink-0" style={colStyles.owner} />
      </div>

      {/* Task rows */}
      {expanded &&
        group.tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            canEdit={canEdit}
            colStyles={colStyles}
            onOpenItem={onOpenItem}
            onOpenRelease={onOpenRelease}
          />
        ))}
    </div>
  )
}

// ── Task Row ─────────────────────────────────────────────────────────────────

function TaskRow({
  task,
  canEdit,
  colStyles,
  onOpenItem,
  onOpenRelease,
}: {
  task: TeamStatusTaskRow
  canEdit: boolean
  colStyles: Record<string, React.CSSProperties>
  onOpenItem: (itemKey: string) => void
  onOpenRelease: (releaseId: string) => void
}) {
  const updateTask = useUpdateTeamTask()

  function commitTitle(raw: string) {
    const trimmed = raw.trim()
    if (!trimmed) {
      toast.error('Task name must not be empty')
      return
    }
    if (trimmed === task.title) return
    updateTask.mutate(
      { taskId: task.id, title: trimmed },
      {
        onSuccess: () => toast.success('Task name updated'),
        onError: (e) => toast.error(e.message),
      },
    )
  }

  function handleStateChange(state: TeamTaskState) {
    updateTask.mutate(
      { taskId: task.id, state },
      {
        onSuccess: () => toast.success(`Task state updated to ${state}`),
        onError: (e) => toast.error(e.message),
      },
    )
  }

  return (
    <div
      className="flex min-h-[35px] items-center border-b border-border-inner bg-card px-3 text-ui-sm transition-colors duration-100 hover:bg-primary-lighter"
      style={{ minWidth: 'max-content' }}
    >
      <div className="w-6 shrink-0" /> {/* Spacer for expand arrow */}
      {/* Rank column — empty on task rows; tasks nest under the member (Rally-style). */}
      <div className="shrink-0" style={colStyles.rank} />
      {/* ID (P3-TS-FR-023) — nested under the member via the shared indent token. */}
      <div
        className={`flex shrink-0 items-center overflow-hidden pr-2 ${NESTED_ROW_INDENT}`}
        style={colStyles.id}
      >
        <IdCell
          type={WorkItemType.Task}
          itemKey={task.taskKey}
          onOpen={() => onOpenItem(task.taskKey)}
        />
      </div>
      {/* Task Name (P3-TS-FR-019 — inline editable) */}
      <div
        className="min-w-[180px] flex-1 px-0"
        style={colStyles.name}
        onClick={(e) => e.stopPropagation()}
      >
        <InlineEditableCell
          fullCell
          value={task.title}
          canEdit={canEdit}
          onCommit={commitTitle}
          displayValue={task.displayName || task.title}
          className="block break-words whitespace-normal text-foreground"
          inputClassName="text-ui-sm text-foreground"
          title={task.displayName || task.title}
          ariaLabel="Task name"
        />
      </div>
      {/* Work Product (P3-TS-FR-024) */}
      <div
        className="flex shrink-0 items-center overflow-hidden px-2"
        style={colStyles.workProduct}
      >
        {task.workProduct.key ? (
          <WorkItemRefCell
            type={(task.workProduct.type || 'story').toLowerCase() as WorkItemType}
            itemKey={task.workProduct.key}
            title={task.workProduct.title}
            onOpen={() => onOpenItem(task.workProduct.key)}
          />
        ) : (
          <span className="text-ui-xs text-foreground-faint">{EMPTY_VALUE}</span>
        )}
      </div>
      {/* Release (P3-TS-FR-025) — clickable reference to the release detail,
          same treatment as the Work Product cell (TypeBadge glyph + link). */}
      <div className="flex shrink-0 items-center overflow-hidden px-2" style={colStyles.release}>
        {task.release ? (
          <button
            type="button"
            title={task.release.name}
            onClick={(e) => {
              e.stopPropagation()
              onOpenRelease(task.release!.id)
            }}
            className="inline-flex max-w-full cursor-pointer items-center gap-1.5 border-none bg-transparent p-0"
            onMouseOver={(e) => {
              e.currentTarget.style.textDecoration = 'underline'
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.textDecoration = 'none'
            }}
          >
            <TypeBadge type="release" size={16} />
            <span className="text-ui-sm break-words whitespace-normal text-primary-light">
              {task.release.name}
            </span>
          </button>
        ) : (
          <span className="text-ui-xs text-foreground-faint">{EMPTY_VALUE}</span>
        )}
      </div>
      {/* State (P3-TS-FR-021 — inline editable): the SHARED segmented stepper plus the
          full label, never one or the other.

          This used to be an `InlineSelect`, chosen when `GAP-P3-TS-007` was read as
          requiring a dropdown. The rule it was actually protecting is narrower — SRS
          §5:87 and `P3-TS-FR-045` forbid the value collapsing to `D` / `P` / `C`, and
          the SRS field table has since been widened from "Dropdown with…" to "Inline
          dropdown/control with full labels". So the constraint is on the LABEL, not on
          the control type, and the stepper satisfies it as long as the label is
          present: the track carries no letter (`TEAM_TASK_STATE_STEPS.letter` is empty
          by construction) and the word sits beside it.

          Reusing `StateStepper` is the point — Iteration Status and the Tasks tab
          already render task state this way, and three grids hand-rolling one control
          is how they drift. The label is what makes this surface's rendering different
          from theirs, and it is required here. */}
      <div
        className="flex shrink-0 items-center gap-1.5 px-2"
        style={colStyles.state}
        onClick={(e) => e.stopPropagation()}
      >
        <StateStepper<TeamTaskState>
          steps={TEAM_TASK_STATE_STEPS}
          value={task.state}
          canEdit={canEdit}
          onChange={handleStateChange}
          ariaLabel="Task state"
        />
        <span className="truncate text-ui-xs text-foreground">{task.state}</span>
      </div>
      {/* Capacity (empty on task row — P3-TS-FR-024) */}
      <div className="shrink-0 px-2" style={colStyles.capacity} />
      {/* Estimate / ToDo / Actuals — READ-ONLY here (P3-TS-FR-026: "shown as
          numeric hour values"; §11 gives this surface Capacity, Task Name and Task
          State and nothing else; §9.3's patch accepts `title` and/or `state`). They
          are inline editable on the Task Dashboard — Work Item Detail › Tasks tab,
          P3-TS-FR-038 — which writes through the work-item route. */}
      <div className="shrink-0 px-2 text-right" style={colStyles.estimate}>
        <HoursCell value={task.estimateHours} />
      </div>
      <div className="shrink-0 px-2 text-right" style={colStyles.todo}>
        <HoursCell value={task.todoHours} />
      </div>
      <div className="shrink-0 px-2 text-right" style={colStyles.actuals}>
        <HoursCell value={task.actualHours} />
      </div>
      {/* Owner — READ-ONLY (P3-TS-FR-027: the column "displays the task owner
          name"). Reassignment happens on the Task Dashboard: the rows here are
          GROUPED by owner, so editing it from inside a member's own group moves the
          row out of the group it is drawn in. */}
      <div className="shrink-0 px-2" style={colStyles.owner}>
        <OwnerCell name={task.owner.id ? task.owner.displayName : null} />
      </div>
    </div>
  )
}

/** One absent-safe hours cell — `EMPTY_VALUE`, never `0`, when there is no number. */
function HoursCell({ value }: { value: number | null }) {
  return (
    <span className="font-mono text-ui-sm text-muted-foreground tabular-nums">
      {value ?? EMPTY_VALUE}
    </span>
  )
}
