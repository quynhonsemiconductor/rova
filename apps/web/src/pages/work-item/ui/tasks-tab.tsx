import { useCallback, useMemo, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { Plus, ListChecks } from 'lucide-react'
import { useSortable } from '@dnd-kit/sortable'

import { toast } from 'sonner'
import { useRecordProject } from '@/shared/lib/deep-link-project'
import { STORAGE_KEYS } from '@/shared/config/storage-keys'
import {
  useTasks,
  useTaskTotals,
  useUpdateWorkItem,
  useCreateTask,
  useRankAnyWorkItem,
  type WorkItem,
} from '@/features/work-items/api'
import { BulkDeleteCopy } from '@/features/work-items/ui/bulk-delete-copy'
import { useProjectMemberOptions, useProjectTeams, useTeamOwnerOptions } from '@/features/teams/api'
import { useProjectPermissions } from '@/features/access/api'
import {
  ScheduleState,
  SCHEDULE_STATE_LABEL,
  getSimplifiedState,
  SIMPLIFIED_STATE_TO_SCHEDULE_STATE,
} from '@/entities/work-item/model/types'
import { IdCell } from '@/entities/work-item/ui/id-cell'
import { StateStepper } from '@/entities/work-item/ui/state-stepper'
import { SIMPLIFIED_STATE_STEPS } from '@/entities/work-item/ui/state-steps'
import { OwnerSelectCell } from '@/shared/ui/owner-cell'
import { Button } from '@/shared/ui/button'
import { EmptyState } from '@/shared/ui/empty-state'
import { LoadErrorState } from '@/shared/ui/load-error-state'
import { listResource } from '@/shared/lib/query/resource'
import { InlineEditableCell } from '@/shared/ui/inline-editable-cell'
import { DateField } from '@/shared/ui/date-field'
import { RowGutter } from '@/shared/ui/row-gutter'
import { EMPTY_VALUE } from '@/shared/lib/utils'
import { PageToolbar } from '@/shared/ui/page-toolbar'
import { ProjectCell } from '@/shared/ui/project-cell'
import { TeamCell } from '@/shared/ui/team-cell'
import { DetailSectionHeading } from '@/shared/ui/detail/detail-field'
import { ColumnFieldsMenu } from '@/shared/ui/column-fields-menu'
import { InlineSelect } from '@/shared/ui/native-select'
import { TableTotalsRow } from '@/shared/ui/table-totals-row'
import {
  useDataTable,
  SelectableTable,
  useRowRerank,
  useDragRowStyle,
  type ColumnSpec,
  rankColumn,
} from '@/shared/ui/table'
import { useRowSelection } from '@/shared/lib/hooks/use-row-selection'
import { AddTaskModal } from '@/features/work-items/ui/add-task-modal'

// TASK-FR-003: columns Rank, ID, Name, State, Owner, Project, Teams, To Do, Actuals, Estimate.
// Phase 7 CO-02 adds the two system-managed lifecycle dates, read-only.
type TaskColKey =
  | 'rank'
  | 'id'
  | 'name'
  | 'state'
  | 'owner'
  | 'project'
  | 'teams'
  | 'startDate'
  | 'actualEndDate'
  | 'todo'
  | 'actuals'
  | 'estimate'

// Single per-column source of truth for the Tasks tab, driven by the shared
// useDataTable engine (identical to Projects / Team Status / Quality) so the grid
// gets resize + reorder + show/hide and a fluid name column for free — replacing
// the old fixed 1216px hand-rolled layout that overflowed the detail column.
const TASK_COLUMNS: ColumnSpec<WorkItem, unknown, TaskColKey>[] = [
  rankColumn(),
  { key: 'id', label: 'ID', defaultWidth: 108, minWidth: 90, locked: true, sortCol: 'id' },
  { key: 'name', label: 'Name', defaultWidth: 240, minWidth: 150, locked: true, sortCol: 'name' },
  { key: 'state', label: 'State', defaultWidth: 132, minWidth: 110, sortCol: 'state' },
  { key: 'owner', label: 'Owner', defaultWidth: 150, minWidth: 120, sortCol: 'owner' },
  { key: 'project', label: 'Project', defaultWidth: 110 },
  { key: 'teams', label: 'Teams', defaultWidth: 120, sortCol: 'teams' },
  { key: 'startDate', label: 'Start Date', defaultWidth: 108 },
  { key: 'actualEndDate', label: 'Actual End Date', defaultWidth: 128 },
  { key: 'todo', label: 'To Do', defaultWidth: 72, align: 'right', sortCol: 'todo' },
  { key: 'actuals', label: 'Actuals', defaultWidth: 72, align: 'right', sortCol: 'actuals' },
  { key: 'estimate', label: 'Estimate', defaultWidth: 80, align: 'right', sortCol: 'estimate' },
]

export function TasksTab({
  workItemId,
  projectId,
  parentTeamId,
  readOnly,
}: {
  workItemId: string
  projectId: string
  /**
   * The PARENT Story/Defect's Team — the Owner rule's fallback, not a display value.
   *
   * `TASK-FR-017` scopes a Task's Owner options to its "inherited parent Team", and a Task's own
   * `teamId` only DEFAULTS to that (SRS P1-04) and is nullable, so a Task with no team of its own
   * under a Story that has one must still offer that Story's roster. Reading `task.teamId` alone made
   * those rows offer `Unassigned` and nothing else.
   */
  parentTeamId: string | null
  readOnly: boolean
}) {
  const { t } = useTranslation('work-items')
  /**
   * The task list is a RESOURCE. `data ?? []` made a 403 or a 500 render `tasks.emptyTitle` —
   * "no tasks" for a Story that may have ten, with an `Add task` button beside it, so the reader's
   * next action is to re-create work that already exists. `DataTableFrame` has had an `error` slot
   * all along; this tab simply never filled it.
   */
  const tasksQuery = useTasks(workItemId)
  const taskFeed = listResource(tasksQuery)
  const tasks = taskFeed.rows
  const { data: totals } = useTaskTotals(workItemId)
  // Row selection (shared pattern with Backlog / Iteration Status): the header
  // checkbox selects every task, each row toggles itself.
  const selection = useRowSelection(tasks)
  // Tasks inherit their parent's project; team/owner names are resolved for display.
  const { data: teams = [] } = useProjectTeams(projectId)
  // `work_item:delete` is what `DELETE /work-items/:id` requires, and it is NOT `work_item:edit`:
  // offering Delete to a caller who holds only the edit code sends them through a destructive confirm
  // to a refusal.
  const { can } = useProjectPermissions(projectId)
  // The ASSIGNEE feed, not the administrative roster (Admin-only, §3.1:71): every Task row resolves
  // its owner NAME from this list, and §3.2:81 gives an Editor the Task. A 403 defaulted to `[]` made
  // each row read `--` with an empty owner picker.
  //
  // NAMES only. What each row may OFFER is its own Team's active members — see `TaskRow`.
  const membersQuery = useProjectMemberOptions(projectId)
  const memberFeed = listResource(membersQuery)
  const members = memberFeed.rows
  // The RECORD's project (P6-E2E-003), not the app shell's selection. This tab already receives the
  // item's `projectId` and every other column reads the task row; the Project column alone read
  // `useAppContext()`, so a deep-linked or hover-preloaded item printed whichever project the reader
  // last selected — the BA's "Project read AUDIT26 while the relationships read TEST".
  const recordProject = useRecordProject(projectId)
  // Kept as a pair, not flattened to one string: `ProjectCell` renders the key as a `KeyChip`
  // beside the name, the way the Portfolio grid's Project column does.
  const projectKey = recordProject?.projectKey ?? null
  const projectName = recordProject?.projectName ?? null
  const [showAdd, setShowAdd] = useState(false)
  // Search + a State filter in the shared toolbar, as the Portfolio Children tab has them.
  const [search, setSearch] = useState('')
  const [stateFilter, setStateFilter] = useState<string>('all')
  const navigate = useNavigate()

  // ── Bulk actions: Delete + Copy (shared BulkDeleteCopy). `copySelected` is
  //    defined below, after `sortedTasks` it reads. ──
  const createTask = useCreateTask(workItemId)

  // Shared table engine (identical to Projects / Team Status): resize + reorder +
  // show/hide, with the name column flexing to fill and all others width-pinned.
  const table = useDataTable<WorkItem, unknown, TaskColKey>(TASK_COLUMNS, {
    storageKey: STORAGE_KEYS.WORK_ITEM_TASKS_COLUMNS,
    leadingWidth: 48,
  })
  // Column sizing comes straight from the shared engine — see `useDataTable().colStyles`. The
  // `{ flex: 1, minWidth }` base this used to pass was discarded by `styleFor` in every case.
  const colStyles = table.colStyles

  /** The team row itself, so `TeamCell` can render its square avatar as every other grid does. */
  const teamOf = (id?: string | null) => (id ? teams.find((team) => team.id === id) : undefined)

  // Client-side column sort — mirrors the shared header UX used by every other
  // grid (Backlog / Team Status / Projects). `null` = the default rank order.
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

  const visibleTasks = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return tasks.filter(
      (task) =>
        (needle === '' ||
          task.itemKey.toLowerCase().includes(needle) ||
          task.title.toLowerCase().includes(needle)) &&
        (stateFilter === 'all' || task.scheduleState === stateFilter),
    )
  }, [tasks, search, stateFilter])

  /** The states these tasks are actually in, so the filter never offers an empty result. */
  const taskStates = useMemo(
    () => [...new Set(tasks.map((task) => task.scheduleState))].sort(),
    [tasks],
  )

  const sortedTasks = useMemo(() => {
    if (!sortCol) return visibleTasks
    const factor = sortDir === 'asc' ? 1 : -1
    const numeric = sortCol === 'todo' || sortCol === 'actuals' || sortCol === 'estimate'
    const value = (wi: WorkItem): string | number => {
      switch (sortCol) {
        case 'rank':
          return wi.rank ?? ''
        case 'id':
          return wi.itemKey
        case 'name':
          return wi.title.toLowerCase()
        case 'state':
          return wi.scheduleState
        case 'owner': {
          const m = members.find((mm) => mm.userId === wi.assigneeId)
          return (m?.displayName ?? m?.email ?? '').toLowerCase()
        }
        case 'teams': {
          const tm = teams.find((x) => x.id === wi.teamId)
          return (tm?.name ?? '').toLowerCase()
        }
        case 'todo':
          return Number(wi.todoHours ?? 0)
        case 'actuals':
          return Number(wi.actualHours ?? 0)
        case 'estimate':
          return Number(wi.estimateHours ?? 0)
        default:
          return ''
      }
    }
    return [...visibleTasks].sort((a, b) => {
      const av = value(a)
      const bv = value(b)
      if (numeric) return ((av as number) - (bv as number)) * factor
      return String(av).localeCompare(String(bv)) * factor
    })
  }, [visibleTasks, sortCol, sortDir, members, teams])

  // Drag-to-rerank (shared engine). Disabled while a non-rank column sort is
  // active (order detaches from rank) or in read-only mode. Persists via the
  // neighbour-based rank endpoint (works for tasks now that findByIds resolves
  // task rows).
  const rankMutation = useRankAnyWorkItem()
  const rerank = useRowRerank({
    items: sortedTasks,
    disabled: sortCol !== null || readOnly,
    onReorder: ({ id, beforeId, afterId }) =>
      rankMutation.mutate(
        {
          id,
          projectId,
          beforeId: beforeId ?? undefined,
          afterId: afterId ?? undefined,
        },
        { onError: (e) => toast.error(e.message) },
      ),
  })

  // Copy = duplicate the single selected task (defined here, after sortedTasks
  // it reads, so the memo above stays compiler-optimizable).
  async function copySelected() {
    const src = sortedTasks.find((task) => selection.selectedIds.has(task.id))
    if (!src) return
    try {
      await createTask.mutateAsync({
        title: `${src.title} (copy)`,
        ...(src.todoHours != null ? { todoHours: Number(src.todoHours) } : {}),
        ...(src.actualHours != null ? { actualHours: Number(src.actualHours) } : {}),
      })
      selection.clear()
      toast.success('Task copied')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Copy failed')
    }
  }

  function openTask(task: WorkItem) {
    void navigate({ to: '/item/$itemKey', params: { itemKey: task.itemKey } })
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-2">
      {/* The section heading, in the SAME `DetailSectionHeading` the Portfolio Children tab uses
          above its own toolbar. This tab previously had a larger bespoke `<h2>` + subtitle pair;
          moving to the shared toolbar dropped both, which left the grid with no title at all. */}
      <DetailSectionHeading>{t('tasks.heading')}</DetailSectionHeading>

      {/* The shared toolbar the Portfolio Children tab established: search, Add New, Filters and
          Show Fields. This tab had a bare heading and an Add button, so the two grids looked
          unrelated above the table even though they share every component inside it. */}
      <PageToolbar
        search={{
          value: search,
          onChange: setSearch,
          placeholder: t('tasks.search'),
          ariaLabel: t('tasks.search'),
          width: 220,
        }}
        actions={
          readOnly ? undefined : (
            <Button size="sm" onClick={() => setShowAdd(true)}>
              <Plus size={14} /> {t('tasks.add')}
            </Button>
          )
        }
        activeFilterCount={stateFilter !== 'all' ? 1 : 0}
        defaultFiltersOpen={stateFilter !== 'all'}
        filters={
          <label className="flex items-center gap-1.5 text-ui-sm font-semibold text-muted-foreground">
            {t('tasks.filterState')}
            <InlineSelect
              value={stateFilter}
              aria-label={t('tasks.filterState')}
              onChange={(e) => setStateFilter(e.target.value)}
              className="w-auto"
            >
              <option value="all">{t('tasks.allStates')}</option>
              {taskStates.map((state) => (
                <option key={state} value={state}>
                  {SCHEDULE_STATE_LABEL[state as ScheduleState] ?? state}
                </option>
              ))}
            </InlineSelect>
          </label>
        }
        fields={<ColumnFieldsMenu {...table.fieldsMenuProps} />}
      />

      {/* Shared SelectableTable owns selection + header select-all gutter +
          BulkActionBar (Set State) + chrome — identical shell as the other
          complex grids. */}
      <SelectableTable
        className="rounded border border-border-strong"
        rows={rerank.items}
        selection={selection}
        selectAllAriaLabel="Select all tasks"
        headerProps={{
          columns: table.headerColumns,
          colStyles,
          onResize: table.startResize,
          columnDrag: table.columnDrag,
        }}
        sort={{ col: sortCol, dir: sortDir, onSort: toggleSort }}
        dnd={{
          dndContextProps: rerank.dndContextProps,
          sortableContextProps: rerank.sortableContextProps,
        }}
        bulkActions={(sel) =>
          readOnly ? null : (
            <BulkDeleteCopy
              canDelete={can('work_item:delete')}
              selection={sel}
              projectId={projectId}
              onCopy={copySelected}
              copyPending={createTask.isPending}
            />
          )
        }
        totals={
          totals ? (
            <TableTotalsRow
              columns={TASK_COLUMNS}
              colStyles={colStyles}
              leading={<RowGutter dragDisabled />}
              label={t('tasks.totals')}
              values={{
                todo: `${totals.todoHours ?? 0}h`,
                actuals: `${totals.actualHours ?? 0}h`,
                estimate: `${totals.estimateHours ?? 0}h`,
              }}
            />
          ) : undefined
        }
        loading={taskFeed.isLoading}
        skeleton={{ rows: 4, cols: 10 }}
        // Error and empty are mutually exclusive because both read the one `phase` discriminant —
        // the frame renders `error` first, but that ordering is now belt-and-braces.
        error={
          taskFeed.phase === 'error' ? (
            <LoadErrorState error={taskFeed.error} size="sm" />
          ) : undefined
        }
        empty={
          taskFeed.phase === 'empty' ? (
            <EmptyState
              size="sm"
              icon={<ListChecks size={28} className="text-foreground-subtle" />}
              title={t('tasks.emptyTitle')}
              description={t('tasks.subtitle')}
              action={
                readOnly ? undefined : (
                  <Button size="sm" onClick={() => setShowAdd(true)}>
                    <Plus size={13} />
                    {t('tasks.add')}
                  </Button>
                )
              }
            />
          ) : undefined
        }
        renderRow={(task, { selected, onToggleSelect }) => (
          <TaskRow
            key={`${task.id}:${task.updatedAt}`}
            task={task}
            rowNum={rerank.items.indexOf(task) + 1}
            canEdit={!readOnly}
            dragDisabled={sortCol !== null || readOnly}
            selected={selected}
            onToggleSelect={onToggleSelect}
            colStyles={colStyles}
            projectId={projectId}
            projectKey={projectKey}
            projectName={projectName}
            teamOf={teamOf}
            members={members}
            parentTeamId={parentTeamId}
            onOpen={openTask}
          />
        )}
      />

      {showAdd && <AddTaskModal workItemId={workItemId} onClose={() => setShowAdd(false)} />}
    </div>
  )
}

// Inline-editable Tasks-tab row (DEV-014): Name / State / Owner / To Do / Actuals
// are edited in place with the shared cell primitives (InlineEditableCell /
// InlineCellSelect / OwnerSelectCell — identical to the Team Status task grid);
// Estimate is EDITABLE, like the other two hour fields — this comment used to say it was
// "read-only derived (To Do + Actuals)", which is the `Estimate = To Do + Actual` rule reversed on
// 2026-07-28. The three hours are independent (Portfolio SRS:141-147), the cell here has always been
// an editable number input, and two BA SRS files still carry the dead rule — so a reader trusting
// this comment would have "fixed" working code to match it. Each edit invalidates the
// ['work-items'] root, so the totals row and parent roll-up recompute immediately.
// The row key includes `updatedAt` so committed values re-sync after a refresh.
function TaskRow({
  task,
  rowNum,
  canEdit,
  dragDisabled,
  colStyles,
  projectId,
  projectKey,
  projectName,
  teamOf,
  members,
  parentTeamId,
  onOpen,
  selected,
  onToggleSelect,
}: {
  task: WorkItem
  rowNum: number
  canEdit: boolean
  dragDisabled: boolean
  colStyles: Record<TaskColKey, CSSProperties>
  projectId: string
  projectKey: string | null
  projectName: string | null
  teamOf: (id?: string | null) => { id: string; name: string; key?: string | null } | undefined
  members: { userId: string; displayName?: string | null; email?: string | null }[]
  parentTeamId: string | null
  onOpen: (task: WorkItem) => void
  selected: boolean
  onToggleSelect: () => void
}) {
  const { t } = useTranslation('work-items')
  const update = useUpdateWorkItem(task.id)
  const {
    setNodeRef,
    setActivatorNodeRef,
    listeners,
    attributes,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, disabled: dragDisabled })
  const dragStyle = useDragRowStyle({ transform, transition, isDragging })

  const commitTitle = (raw: string) => {
    const next = raw.trim()
    if (next && next !== task.title) void update.mutateAsync({ title: next })
  }
  const commitHours = (field: 'todoHours' | 'actualHours' | 'estimateHours', raw: string) => {
    const next = raw.trim() === '' ? null : Number(raw)
    if (next != null && (Number.isNaN(next) || next < 0)) return
    const current = task[field] != null ? Number(task[field]) : null
    if (next !== current) void update.mutateAsync({ [field]: next })
  }

  /**
   * Owner OPTIONS come from THIS row's Team, not from the project (GAP-P1-WID-007: "Selected Team
   * offers Unassigned plus its ACTIVE MEMBERS; No Team offers only Unassigned").
   *
   * Per ROW rather than once for the tab, because a Task's team only DEFAULTS to its parent's and is
   * genuinely settable (SRS P1-04) — narrowing the whole grid by the parent's team would offer the
   * wrong roster to any task that carries its own, and a wrong narrowing withholds a legitimate owner.
   * React Query dedupes by key, so N rows sharing one team is still ONE request, and a row with no
   * team never fetches at all.
   *
   * `ownerName` below is resolved from the project-wide feed FIRST and from these options second, so
   * an owner who has since left the team is still NAMED rather than reprinted as `Unassigned`
   * (`ownerSelectOptions` takes the current label as its third argument for exactly this) — and an
   * owner the project-wide feed does not carry, which a Workspace Admin on the team roster now is,
   * is named from the team roster that DOES carry them.
   */
  const ownerOptionsQuery = useTeamOwnerOptions(projectId, task.teamId ?? parentTeamId)
  const ownerOptions = listResource(ownerOptionsQuery).rows

  const owner =
    members.find((m) => m.userId === task.assigneeId) ??
    ownerOptions.find((m) => m.userId === task.assigneeId)
  // The row's own `assigneeName` wins: both feeds above exclude Workspace Admins (AC-16), so a task
  // they own read `No Entry` while the id was saved.
  const ownerName = task.assigneeName ?? (owner ? (owner.displayName ?? owner.email ?? null) : null)

  const numInput =
    'w-16 rounded border border-input bg-card px-1 py-0.5 text-right font-mono text-ui-md focus:outline-none'

  return (
    <div
      ref={setNodeRef}
      className="group flex min-h-[36px] min-w-max items-center border-b border-border-inner bg-card px-3 text-ui-md text-foreground transition-colors hover:bg-primary-lighter"
      style={dragStyle}
    >
      <RowGutter
        ref={setActivatorNodeRef}
        dragListeners={dragDisabled ? undefined : listeners}
        dragAttributes={dragDisabled ? undefined : attributes}
        dragDisabled={dragDisabled}
        stopPropagation
        checkbox={{
          checked: selected,
          onChange: onToggleSelect,
          ariaLabel: `Select task ${task.itemKey}`,
        }}
      />
      {/* Rank — sequential position in the current order (not the raw LexoRank). */}
      <div
        className="shrink-0 px-2 text-right font-mono text-ui-sm text-muted-foreground tabular-nums"
        style={colStyles.rank}
      >
        {rowNum}
      </div>
      {/* ID */}
      <div className="flex shrink-0 items-center overflow-hidden px-2" style={colStyles.id}>
        <IdCell type={task.type} itemKey={task.itemKey} onOpen={() => onOpen(task)} />
      </div>
      {/* Name — inline editable */}
      <div className="min-w-[150px] flex-1 px-2" style={colStyles.name}>
        <InlineEditableCell
          value={task.title}
          canEdit={canEdit}
          onCommit={commitTitle}
          className="block text-ui-md font-medium break-words whitespace-normal text-foreground"
          style={{ cursor: 'text' }}
          inputClassName="w-full rounded border border-accent-border-strong px-1 py-0.5 text-ui-md text-foreground focus:outline-none"
          title={task.title}
          ariaLabel={`Task ${task.itemKey} name`}
        />
      </div>
      {/* State — simplified Task State stepper (shared control; BR-TASK-01) */}
      <div className="flex shrink-0 items-center px-2" style={colStyles.state}>
        <StateStepper
          steps={SIMPLIFIED_STATE_STEPS}
          value={
            SIMPLIFIED_STATE_TO_SCHEDULE_STATE[
              getSimplifiedState(task.scheduleState as ScheduleState)
            ]
          }
          canEdit={canEdit}
          onChange={(next) => update.mutateAsync({ scheduleState: next })}
          ariaLabel={`Task ${task.itemKey} state`}
        />
      </div>
      {/* Owner */}
      <div className="flex shrink-0 items-center overflow-hidden px-2" style={colStyles.owner}>
        <OwnerSelectCell
          ownerName={ownerName}
          assigneeId={task.assigneeId}
          members={ownerOptions}
          canEdit={canEdit}
          onChange={(userId) => update.mutateAsync({ assigneeId: userId })}
          ariaLabel={`Task ${task.itemKey} owner`}
        />
      </div>
      {/* Project — the shared cell, so a Task's project carries the same `KeyChip` the Portfolio
          and Backlog grids put on theirs. A Task inherits its project from its parent, so this is
          display-only. */}
      <div className="flex min-w-0 shrink-0 items-center px-2" style={colStyles.project}>
        <ProjectCell projectKey={projectKey} projectName={projectName} />
      </div>
      {/* Teams — the shared cell, with the square `TeamAvatar` every other team surface renders. */}
      <div className="flex min-w-0 shrink-0 items-center px-2" style={colStyles.teams}>
        {(() => {
          const tm = teamOf(task.teamId)
          return tm ? (
            <TeamCell teamKey={tm.key} name={tm.name} />
          ) : (
            <span className="text-muted-foreground">{EMPTY_VALUE}</span>
          )
        })()}
      </div>
      {/* Start Date / Actual End Date — system-managed (CO-02), the SAME persisted values Task Detail
          shows (AC5), so the shared read-only `DateField` and the same `Not set` placeholder. No
          `ariaLabel`: the read-only `DateField` renders a plain span that never applies one (ARIA
          prohibits naming a generic element), so a label here was dead text that could not even be
          translated into effect (PR 653 review, round 3). The column header names the cell, as it
          does for every other cell in the row. */}
      <div className="flex shrink-0 items-center px-2" style={colStyles.startDate}>
        <DateField value={task.startDate} readOnly placeholder={t('sidebar.notSet')} />
      </div>
      <div className="flex shrink-0 items-center px-2" style={colStyles.actualEndDate}>
        <DateField value={task.actualEndDate} readOnly placeholder={t('sidebar.notSet')} />
      </div>
      {/* To Do — inline editable */}
      <div className="shrink-0 px-2 text-right" style={colStyles.todo}>
        <InlineEditableCell
          value={task.todoHours != null ? String(task.todoHours) : ''}
          canEdit={canEdit}
          onCommit={(v) => commitHours('todoHours', v)}
          displayValue={task.todoHours ?? '--'}
          className="font-mono text-muted-foreground tabular-nums hover:underline"
          inputClassName={numInput}
          ariaLabel={`Task ${task.itemKey} to do hours`}
        />
      </div>
      {/* Actuals — inline editable */}
      <div className="shrink-0 px-2 text-right" style={colStyles.actuals}>
        <InlineEditableCell
          value={task.actualHours != null ? String(task.actualHours) : ''}
          canEdit={canEdit}
          onCommit={(v) => commitHours('actualHours', v)}
          displayValue={task.actualHours ?? '--'}
          className="font-mono text-muted-foreground tabular-nums hover:underline"
          inputClassName={numInput}
          ariaLabel={`Task ${task.itemKey} actual hours`}
        />
      </div>
      {/* Estimate — independent planned value, inline editable (real Rally) */}
      <div className="shrink-0 px-2 text-right" style={colStyles.estimate}>
        <InlineEditableCell
          value={task.estimateHours != null ? String(task.estimateHours) : ''}
          canEdit={canEdit}
          onCommit={(v) => commitHours('estimateHours', v)}
          displayValue={task.estimateHours ?? '--'}
          className="font-mono text-muted-foreground tabular-nums hover:underline"
          inputClassName={numInput}
          ariaLabel={`Task ${task.itemKey} estimate hours`}
        />
      </div>
    </div>
  )
}

// ── Revision History tab ──────────────────────────────────────────────────────
