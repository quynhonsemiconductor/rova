import { useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { RankCell, TableRow } from '@/shared/ui/table'

import { BRAND } from '@/shared/config/brand'
import { listResource } from '@/shared/lib/query/resource'
import { LoadErrorState } from '@/shared/ui/load-error-state'
import { RowExpandToggle } from '@/shared/ui/row-expand-toggle'
import { NESTED_ROW_INDENT } from '@/shared/config/layout'
import { notify } from '@/shared/lib/toast'
import {
  useUpdateWorkItem,
  useSetWorkItemMilestones,
  useTasks,
  type WorkItem,
} from '@/features/work-items/api'
import { type IterationStatusItem } from '@/features/iterations/api'
import {
  type ScheduleState,
  getSimplifiedState,
  SIMPLIFIED_STATE_TO_SCHEDULE_STATE,
  SCHEDULE_STATE_VALUES,
  SCHEDULE_STATE_LABEL,
} from '@/entities/work-item/model/types'
import { StateStepper } from '@/entities/work-item/ui/state-stepper'
import { FeatureCell } from '@/entities/work-item/ui/feature-cell'
import { SCHEDULE_STATE_STEPS, SIMPLIFIED_STATE_STEPS } from '@/entities/work-item/ui/state-steps'
import { IdCell } from '@/entities/work-item/ui/id-cell'
import { TypeBadge } from '@/entities/work-item/ui/badges'
import { InlineEditableCell } from '@/shared/ui/inline-editable-cell'
import { SearchableSelect } from '@/shared/ui/searchable-select'
import { useTeamOwnerOptions } from '@/features/teams/api'
import { OwnerSelectCell, type OwnerSelectMember } from '@/shared/ui/owner-cell'
import { RowGutter } from '@/shared/ui/row-gutter'
import { MilestoneSelectCell, TasksProgress } from './status-cells'
import { useWorkItemFieldCommit } from '../model/use-work-item-field-commit'
import { NUMERIC_CELL_CLASS } from '@/shared/lib/utils'
import { entityDetailPath } from '@/shared/lib/entity-link'

// Single mono stack for numeric cells (digit alignment).
/**
 * Retained for `<input>` elements ONLY.
 *
 * Every numeric CELL now uses the shared `NUMERIC_CELL_CLASS` (`text-right font-mono
 * tabular-nums`) instead of a hand-rolled font stack, so this grid finally matches the
 * shared table cell. An inline-edit input is a separate element that does not inherit the
 * cell's class, and `inputStyle` takes a style object rather than a className, so the
 * literal stack is still needed there.
 */
const MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

// ── Status row ──────────────────────────────────────────────────────────────

export function StatusRow({
  item,
  rank,
  memberMap,
  projectId,
  fallbackTeamId,
  milestoneOptions,
  iterationOptions,
  selectedIterationId,
  canEdit,
  canOpenPortfolio,
  colStyles,
  dragEnabled,
  selected,
  onToggleSelect,
  onOpen,
}: {
  item: IterationStatusItem
  rank: number
  /**
   * NAME resolution for an owner already set — the workspace directory, keyed by user id.
   *
   * Wider than what may be offered on purpose (`GAP-P2-IS-004`): the project feed excludes anyone
   * without an active `project_members` row, including a Workspace Admin, so a Dev Owner who had
   * just been saved successfully resolved to nothing and the cell reprinted `No Entry` after a
   * reload. A name that fails to resolve is indistinguishable from an unset field, which is why this
   * feed and {@link memberOptions} are two props and not one.
   */
  memberMap: Map<string, OwnerSelectMember>
  projectId: string
  /**
   * The Team to scope the Owner / Dev Owner OFFER list to when the row carries none — the selected
   * iteration's own team. A shared sprint names no team (195 of 206 local iterations do not), so
   * this is null far more often than not, and then the offer list is the no-Team one by rule.
   */
  fallbackTeamId: string | null
  milestoneOptions: readonly { id: string; name: string; milestoneKey?: string | null }[]
  iterationOptions: readonly { id: string; name: string; iterationKey?: string | null }[]
  selectedIterationId: string
  canEdit: boolean
  /**
   * `portfolio:view` — whether this reader can open Portfolio detail at all. False makes the Feature
   * cell TEXT instead of a link: §3.2:85 hides Portfolio Items from an Editor, so the cell used to
   * navigate them straight into Access Denied. The KEY still shows, because a Story's Feature is data
   * on a grid the Editor owns; only the journey to a surface they cannot open is withheld.
   */
  canOpenPortfolio: boolean
  colStyles: Record<string, CSSProperties>
  dragEnabled: boolean
  selected: boolean
  onToggleSelect: () => void
  onOpen: () => void
}) {
  const { t } = useTranslation('iteration-status')
  const navigate = useNavigate()
  const update = useUpdateWorkItem(item.id)
  const setMilestones = useSetWorkItemMilestones(item.id)
  /**
   * The ROW names its own owner; `memberMap` is only the fallback.
   *
   * Resolving a name from a picker feed cannot work in general — `member-options` for a project
   * excludes Workspace Admins (AC-16) and the workspace directory narrows a non-admin to their own
   * projects' members and leads, so a Workspace Admin owner had no name source and the cell read
   * `No Entry` while the value sat in the database. The read model joins `assigneeName` /
   * `devOwnerName` now; the map stays as the fallback for rows served by an older response.
   */
  const member = item.assigneeId ? memberMap.get(item.assigneeId) : undefined
  const ownerName = item.assigneeName ?? member?.displayName ?? member?.email ?? null
  const devOwner = item.devOwnerId ? memberMap.get(item.devOwnerId) : undefined
  const devOwnerName = item.devOwnerName ?? devOwner?.displayName ?? devOwner?.email ?? null

  // Narrowed locals so closures below keep the non-null type.
  const featureId = item.featureId
  const featureKey = item.featureKey
  const featureTitle = item.featureTitle
  const milestones = item.milestones

  const [tasksExpanded, setTasksExpanded] = useState(false)
  // A resource: `data ?? []` made a failed task read render `row.noTasks` ("No tasks.") under an
  // expanded Story — a claim that the Story has no breakdown, which is also the claim the row's own
  // To Do rollup rests on. The expand affordance is the one place a reader looks to check that.
  const tasksQuery = useTasks(tasksExpanded ? item.id : undefined)
  const taskFeed = listResource(tasksQuery)
  const childTasks = taskFeed.rows
  const isLoadingTasks = taskFeed.isLoading

  /**
   * What the pickers OFFER, which is narrower than what `memberMap` NAMES (`GAP-P2-IS-004`).
   *
   * `memberMap` carries the workspace directory so a persisted Owner or Dev Owner always resolves to
   * a name; offering that whole set here would put every workspace user in an Owner dropdown, which
   * `WID-FR-016` forbids. So the offers come from the project feed and the names from the map.
   */
  /**
   * The OFFER list, scoped to THIS ROW'S Team — `WID-FR-017` / `WIC-FR-006A`.
   *
   * The page used to fetch `useProjectMemberOptions(projectId)` once, with no team, and hand the same
   * array to every row. That feed is the NO-TEAM branch of the assignment rule, which offers Project
   * Admins (plus Workspace Admins) and deliberately no Editors — so on a project whose members are
   * Editors on the selected Team, both the Owner and the Dev Owner dropdown showed nothing but
   * `No Entry` and no active Team member could be assigned inline (Production, 2026-08-21). The
   * intermittency in that report is the same fact seen twice: the row's own Owner still RESOLVED to a
   * name out of `memberMap`, so the value came and went with which of the two lists was consulted.
   *
   * Per row, like the Tasks tab (`useTeamOwnerOptions(projectId, task.teamId ?? parentTeamId)`).
   * Rows sharing a team share one query key, so this is one request per distinct team on screen.
   */
  const { data: membersList = [] } = useTeamOwnerOptions(projectId, item.teamId ?? fallbackTeamId)

  const {
    setNodeRef,
    setActivatorNodeRef,
    listeners,
    attributes,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: item.id,
    disabled: !dragEnabled || !canEdit,
  })
  const rowStyle: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  const { save, saveNumber } = useWorkItemFieldCommit(update)
  const milestoneCommit = useWorkItemFieldCommit(setMilestones)

  const commitEstimate = (raw: string) =>
    // Plan Estimate is story points — an independent planning value; it does not
    // touch task To Do hours (the displayed To Do is a rollup of child tasks).
    saveNumber(raw, (n) => ({ storyPoints: n }), t('row.planEstimateUpdated'), 'Estimate')
  const commitTitle = (raw: string) => {
    const next = raw.trim()
    if (!next || next === item.title) return
    save({ title: next }, t('row.nameUpdated'))
  }
  const handleOwnerChange = (userId: string | null) =>
    save({ assigneeId: userId }, t('row.ownerUpdated'))
  const handleIterationChange = (iterationId: string | null) =>
    save({ iterationId }, iterationId ? t('row.iterationUpdated') : t('row.movedToBacklog'))
  const handleDevOwnerChange = (userId: string | null) =>
    save({ devOwnerId: userId }, t('row.devOwnerUpdated'))
  const handleMilestonesChange = (ids: string[]) =>
    milestoneCommit.save(ids, t('row.milestonesUpdated'))
  const commitBlockedReason = (raw: string) => {
    const next = raw.trim()
    if (next === (item.blockedReason ?? '')) return
    save({ blockedReason: next || null }, t('row.blockedReasonUpdated'))
  }
  const toggleBlocked = () =>
    save({ isBlocked: !item.isBlocked }, item.isBlocked ? t('row.unblocked') : t('row.blocked'))

  return (
    <>
      {/* The shared row: `pr-3 pl-1` matches this grid's own `padClassName`, and `fitContent` is what
          the inline `minWidth: 'max-content'` was doing. The three inline values TableRow now owns are
          gone — a 34px floor, 12px type and the hover — and with them this grid's two private
          divergences: `border-border-subtle` where every other grid uses `border-border-inner`, and a
          `duration-100` nobody else had.

          The `onMouseOver`/`onMouseOut` pair went too. They set `backgroundColor` imperatively, which
          BEAT the hover class and reset the row to `BRAND.surface` on exit — so a row that was selected
          or drag-highlighted lost its fill the first time a pointer crossed it. */}
      <TableRow ref={setNodeRef} className="bg-card pr-3 pl-1" fitContent style={rowStyle}>
        {/* Leading gutter (rank grip + selection checkbox) — shared component so
            the header, rows and nested child rows stay column-aligned. */}
        <RowGutter
          ref={setActivatorNodeRef}
          dragDisabled={!dragEnabled || !canEdit}
          dragListeners={dragEnabled && canEdit ? listeners : undefined}
          dragAttributes={dragEnabled && canEdit ? attributes : undefined}
          stopPropagation
          checkbox={{
            checked: selected,
            onChange: onToggleSelect,
            ariaLabel: `Select ${item.itemKey}`,
          }}
        />

        {/* Rank number */}
        <RankCell rowNum={rank} style={colStyles.rank} />

        {/* ID — expand/collapse toggle lives here (Rally parity), to the left of
            the item type icon + key. */}
        <div style={colStyles.id} className="flex items-center gap-1.5 px-2">
          {/* `taskTotal` is already on the wire per row, so the chevron only appears where tasks exist
              — no fetch needed to decide, and no row that discloses an empty list. */}
          <RowExpandToggle
            expanded={tasksExpanded}
            onToggle={() => setTasksExpanded(!tasksExpanded)}
            label={tasksExpanded ? 'Collapse tasks' : 'Expand tasks'}
            disclosable={item.taskTotal > 0}
          />
          <IdCell type={item.type} itemKey={item.itemKey} onOpen={onOpen} />
        </div>

        {/*
         * Name — click to edit inline (Rally parity); use the ID link to open.
         *
         * NO `overflow-hidden` here, deliberately, and it is the difference between a row that fits
         * its content and one that clips it. `TableRow` sets a `min-h` FLOOR and `items-center`, so
         * it grows to its tallest child — but a cell that clips its own content reports the clipped
         * height, so the row never learns it needs more room. A two-line title was cut off
         * mid-word and the inline-edit hover box, drawn around the real (taller) content, escaped
         * the column and painted over Feature.
         *
         * `min-w-0` is what makes `break-words` work in a flex child; the width ceiling comes from
         * `colStyles.name`. The Backlog's Name cell is the control case — same row chrome, no
         * `overflow-hidden`, and its rows have always grown correctly.
         *
         * The Owner / Dev Owner cells below KEEP `overflow-hidden`: they render a single-line
         * `OwnerSelectCell` trigger, so clipping is the intended behaviour there.
         */}
        <div
          style={colStyles.name}
          className="flex min-w-0 items-center px-0"
          onClick={(e) => e.stopPropagation()}
        >
          <InlineEditableCell
            value={item.title}
            canEdit={canEdit}
            fullCell
            onCommit={commitTitle}
            ariaLabel="Name"
            title={item.title}
            className="break-words whitespace-normal text-foreground"
            style={{ fontSize: 12 }}
            inputStyle={{ fontSize: 12 }}
          />
        </div>

        {/* Feature */}
        <div style={colStyles.feature} className="flex items-center overflow-hidden px-2">
          {featureKey ? (
            <FeatureCell
              featureKey={featureKey}
              featureTitle={featureTitle}
              // A Feature is a portfolio item, so it opens portfolio detail. Sending
              // its key to `/item/:itemKey` used to work when Feature was a
              // work-item type; that lookup can no longer resolve it.
              onOpen={
                canOpenPortfolio && featureId
                  ? () => void navigate({ to: '/portfolio/$itemId', params: { itemId: featureId } })
                  : undefined
              }
              href={featureId ? entityDetailPath.portfolioItem(featureId) : undefined}
            />
          ) : (
            <span className="text-foreground-subtle" style={{ fontSize: 12 }}>
              --
            </span>
          )}
        </div>

        {/* Iteration — inline reassign (move item to another iteration or backlog) */}
        <div
          style={colStyles.iteration}
          className="flex items-center overflow-hidden px-0"
          onClick={(e) => e.stopPropagation()}
        >
          <SearchableSelect
            value={item.iterationId ?? ''}
            readOnly={!canEdit}
            ariaLabel="Iteration"
            placeholder={t('row.backlog')}
            options={[
              { value: '', label: t('row.backlog') },
              ...iterationOptions.map((it) => ({
                value: it.id,
                label: it.iterationKey ? `${it.iterationKey}: ${it.name}` : it.name,
                searchText: `${it.iterationKey ?? ''} ${it.name}`,
                icon: <TypeBadge type="iteration" size={16} />,
              })),
            ]}
            onChange={(v) => handleIterationChange(v || null)}
          />
        </div>

        {/* Schedule State — Rally-style segmented stepper */}
        <div
          style={colStyles.state}
          className="flex items-center px-2 select-none"
          onClick={(e) => e.stopPropagation()}
        >
          <ScheduleStateStepper
            value={item.scheduleState as ScheduleState}
            canEdit={canEdit}
            onChange={(next) => update.mutate({ scheduleState: next })}
            blocked={item.isBlocked}
          />
        </div>

        {/* Flow State — mirrors Schedule State (bidirectional); enum dropdown */}
        <div
          style={colStyles.flowState}
          className="flex items-center overflow-hidden px-0"
          onClick={(e) => e.stopPropagation()}
        >
          <SearchableSelect
            value={item.scheduleState as string}
            readOnly={!canEdit}
            ariaLabel="Flow State"
            options={SCHEDULE_STATE_VALUES.map((v) => ({
              value: v,
              label: SCHEDULE_STATE_LABEL[v],
            }))}
            onChange={(v) => update.mutate({ flowState: v as ScheduleState })}
          />
        </div>

        {/* Block - Click to Toggle */}
        <div style={colStyles.block} className="flex justify-center px-2">
          <button
            onClick={canEdit ? toggleBlocked : undefined}
            style={{
              background: 'none',
              border: 'none',
              cursor: canEdit ? 'pointer' : 'default',
              padding: 0,
            }}
          >
            {item.isBlocked ? (
              <span
                className="border border-destructive-border bg-destructive-bg text-destructive"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 22,
                  height: 20,
                  borderRadius: 2,
                  fontSize: 11,
                  fontWeight: 700,
                }}
                title="Blocked - Click to Unblock"
              >
                B
              </span>
            ) : (
              <span
                className="border border-dashed border-border-strong text-foreground-subtle"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 22,
                  height: 20,
                  borderRadius: 2,
                  fontSize: 11,
                  fontWeight: 500,
                }}
                title="Unblocked - Click to Block"
              >
                &middot;
              </span>
            )}
          </button>
        </div>

        {/* Blocked Reason — inline-editable only while the item is blocked
            (an unblocked item has no reason to capture). */}
        <div style={colStyles.blockedReason} className="flex items-center px-0">
          {/* Editable whenever there is something to edit — blocked, or carrying a reason from
              before unblocking cleared them. The second case is now only reachable for rows
              written before that rule existed, and leaving it read-only was the bug: the value
              could be read and never removed. */}
          {canEdit && (item.isBlocked || item.blockedReason) ? (
            <InlineEditableCell
              value={item.blockedReason ?? ''}
              canEdit={canEdit}
              fullCell
              onCommit={commitBlockedReason}
              ariaLabel="Blocked reason"
              title={item.blockedReason ?? 'Add a blocked reason'}
              className="w-full text-muted-foreground"
              style={{ fontSize: 12 }}
              displayValue={
                item.blockedReason ? (
                  <span className="block break-words whitespace-normal text-muted-foreground">
                    {item.blockedReason}
                  </span>
                ) : (
                  <span className="block break-words whitespace-normal text-foreground-subtle italic">
                    Add reason…
                  </span>
                )
              }
              inputClassName="border border-primary"
              inputStyle={{ width: '100%', fontSize: 11, borderRadius: 2, outline: 'none' }}
            />
          ) : item.blockedReason ? (
            <span
              className="truncate px-2 text-muted-foreground"
              title={item.blockedReason}
              style={{ fontSize: 12 }}
            >
              {item.blockedReason}
            </span>
          ) : (
            <span className="px-2 text-foreground-subtle" style={{ fontSize: 12 }}>
              --
            </span>
          )}
        </div>

        {/* Plan Estimate */}
        <div style={{ ...colStyles.planEstimate, textAlign: 'right' }} className="px-0">
          <InlineEditableCell
            value={String(item.planEstimate ?? '')}
            canEdit={canEdit}
            fullCell
            onCommit={commitEstimate}
            displayValue={item.planEstimate ?? '--'}
            className={`text-muted-foreground ${NUMERIC_CELL_CLASS}`}
            style={{ fontSize: 12 }}
            inputClassName="border border-primary"
            inputStyle={{
              width: '100%',
              textAlign: 'right',
              fontSize: 11,
              fontFamily: MONO_FONT,
              borderRadius: 2,
              outline: 'none',
            }}
            ariaLabel="Plan estimate"
          />
        </div>

        {/* Task Estimate (Rollup - readonly) */}
        <div
          style={{ ...colStyles.taskEstimate, fontSize: 12 }}
          className={`px-2 text-muted-foreground ${NUMERIC_CELL_CLASS}`}
        >
          {item.taskEstimate ?? '--'}
        </div>

        {/* To Do — read-only rollup of child task To Do on a Story/Defect row.
            Editing it wrote todoHours on the parent while the cell shows the
            rollup, so the edit was silently overwritten on refetch. Edit To Do
            per-task on the expanded ChildTaskRow instead. */}
        <div style={{ ...colStyles.toDo, textAlign: 'right' }} className="px-0">
          <span className={`text-muted-foreground ${NUMERIC_CELL_CLASS}`} style={{ fontSize: 12 }}>
            {item.toDo ?? '--'}
          </span>
        </div>

        {/* Tasks % complete (rollup) */}
        <div style={colStyles.tasksPct} className="flex items-center px-2">
          <TasksProgress total={item.taskTotal} done={item.taskDone} />
        </div>

        {/* Actual — read-only roll-up of child task actual hours (parity with
            Task Est / To Do). Edited per-task on the expanded task rows. */}
        <div
          style={{ ...colStyles.actual, fontSize: 12 }}
          className={`px-2 text-muted-foreground ${NUMERIC_CELL_CLASS}`}
        >
          {item.actual ?? '--'}
        </div>

        {/* Owner */}
        <div
          style={colStyles.owner}
          className="flex items-center overflow-hidden px-0"
          onClick={(e) => e.stopPropagation()}
        >
          <OwnerSelectCell
            ownerName={ownerName}
            assigneeId={item.assigneeId}
            members={membersList}
            canEdit={canEdit}
            onChange={handleOwnerChange}
          />
        </div>

        {/* Per-row Defects / Defect Status columns are intentionally absent: the
            SRS anti-requirement P2-IS-FR-019 forbids a per-row Defects column, and
            real Rally surfaces only the iteration-level defect count. That count
            still lives in the MetricsStrip above the grid (item.defectCount). */}

        {/* Milestones — inline multi-select (add/remove) */}
        <div
          style={colStyles.milestones}
          className="flex items-center overflow-hidden px-0"
          onClick={(e) => e.stopPropagation()}
        >
          <MilestoneSelectCell
            selected={milestones}
            options={milestoneOptions}
            canEdit={canEdit}
            saving={setMilestones.isPending}
            onCommit={handleMilestonesChange}
          />
        </div>

        {/* Dev Owner — editable assignee (distinct from Owner) */}
        <div
          style={colStyles.devOwner}
          className="flex items-center overflow-hidden px-0"
          onClick={(e) => e.stopPropagation()}
        >
          <OwnerSelectCell
            ownerName={devOwnerName}
            assigneeId={item.devOwnerId}
            members={membersList}
            canEdit={canEdit}
            onChange={handleDevOwnerChange}
            ariaLabel="Dev owner"
          />
        </div>

        {/* selectedIterationId kept for future refetch semantics */}
        <span hidden>{selectedIterationId}</span>
      </TableRow>

      {/* Child Tasks List — the 2px hierarchy rail is an inset shadow (not a
          border) so it never shifts the child columns out of alignment with
          the parent row / header. */}
      {tasksExpanded && (
        <div
          className="bg-surface-hover"
          style={{
            boxShadow: `inset 2px 0 0 ${BRAND.primaryLighter}`,
          }}
        >
          {isLoadingTasks && (
            <div
              className="text-foreground-subtle"
              style={{
                padding: '6px 44px',
                fontSize: 11,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <Loader2 size={12} className="animate-spin" /> {t('row.loadingTasks')}
            </div>
          )}
          {taskFeed.phase === 'error' && (
            <LoadErrorState error={taskFeed.error} size="sm" className="py-3" />
          )}
          {taskFeed.phase === 'empty' && (
            <div
              className="text-foreground-subtle"
              style={{
                padding: '6px 44px',
                fontSize: 11,
                fontStyle: 'italic',
              }}
            >
              {t('row.noTasks')}
            </div>
          )}
          {taskFeed.phase === 'ready' &&
            childTasks.map((task) => {
              const taskMember = task.assigneeId ? memberMap.get(task.assigneeId) : undefined
              const taskOwner =
                task.assigneeName ?? taskMember?.displayName ?? taskMember?.email ?? 'Unassigned'
              return (
                <ChildTaskRow
                  key={task.id}
                  task={task}
                  taskOwner={taskOwner}
                  membersList={membersList}
                  memberMap={memberMap}
                  canEdit={canEdit}
                  colStyles={colStyles}
                  onOpen={() =>
                    navigate({ to: '/item/$itemKey', params: { itemKey: task.itemKey } })
                  }
                />
              )
            })}
        </div>
      )}
    </>
  )
}

// ── Child task row ──────────────────────────────────────────────────────────

function ChildTaskRow({
  task,
  taskOwner,
  membersList,
  memberMap,
  canEdit,
  colStyles,
  onOpen,
}: {
  task: WorkItem
  taskOwner: string
  /** The assignee feed as a list — the shared picker shape, which permits null. What may be OFFERED. */
  membersList: OwnerSelectMember[]
  /** The directory, for NAMING an owner already set — see the parent's own prop (`GAP-P2-IS-004`). */
  memberMap: Map<string, OwnerSelectMember>
  canEdit: boolean
  colStyles: Record<string, CSSProperties>
  onOpen: () => void
}) {
  const { t } = useTranslation('iteration-status')
  const updateTask = useUpdateWorkItem(task.id)

  const { save, saveNumber } = useWorkItemFieldCommit(updateTask)

  const commitTaskTitle = (raw: string) => {
    const next = raw.trim()
    if (!next || next === task.title) return
    save({ title: next }, t('row.nameUpdated'))
  }
  // Task Estimate is an independent planned value (real Rally). Editing it does
  // NOT reset To Do — To Do only defaults to Estimate at create (backend) and
  // auto-zeroes on completion. Estimate is now inline-editable here.
  const commitTaskEstimate = (raw: string) =>
    saveNumber(raw, (n) => ({ estimateHours: n }), t('row.taskEstimateUpdated'), 'Estimate')
  const commitTaskTodo = (raw: string) =>
    saveNumber(raw, (n) => ({ todoHours: n }), t('row.todoHoursUpdated'), 'Todo hours')
  const commitTaskActual = (raw: string) =>
    saveNumber(raw, (n) => ({ actualHours: n }), t('row.actualHoursUpdated'), 'Actual hours')
  const handleOwnerChange = (userId: string | null) =>
    save({ assigneeId: userId }, t('row.ownerUpdated'))
  const handleDevOwnerChange = (userId: string | null) =>
    save({ devOwnerId: userId }, t('row.devOwnerUpdated'))

  const devOwnerMember = task.devOwnerId ? memberMap.get(task.devOwnerId) : undefined
  const taskDevOwnerName =
    task.devOwnerName ?? devOwnerMember?.displayName ?? devOwnerMember?.email ?? null

  return (
    <div
      className="flex items-center border-b border-dashed border-border-subtle text-muted-foreground"
      style={{
        minHeight: 30,
        paddingLeft: 4,
        paddingRight: 12,
        fontSize: 11,
        minWidth: 'max-content',
      }}
      onMouseOver={(e) => {
        e.currentTarget.style.backgroundColor = BRAND.primaryLighter
      }}
      onMouseOut={(e) => {
        e.currentTarget.style.backgroundColor = 'transparent'
      }}
    >
      {/* Leading gutter mirrors the parent row exactly (grip · checkbox · rank)
          via the shared component, so every child cell lines up under the same
          column. */}
      <RowGutter dragDisabled />
      <div style={colStyles.rank} className="px-2" />
      {/* ID nested under the parent via the shared indent token. */}
      <div style={colStyles.id} className={`pr-2 ${NESTED_ROW_INDENT}`}>
        <IdCell type={task.type} itemKey={task.itemKey} onOpen={onOpen} />
      </div>
      <div
        style={colStyles.name}
        className="flex min-w-0 items-center px-0"
        onClick={(e) => e.stopPropagation()}
      >
        <InlineEditableCell
          value={task.title}
          canEdit={canEdit}
          fullCell
          onCommit={commitTaskTitle}
          ariaLabel="Name"
          title={task.title}
          className="break-words whitespace-normal text-foreground"
          style={{ fontSize: 12 }}
          inputStyle={{ fontSize: 12 }}
        />
      </div>
      <div style={colStyles.feature} className="px-2" />
      <div style={colStyles.iteration} className="px-2" />
      <div
        style={colStyles.state}
        className="flex items-center px-2"
        onClick={(e) => e.stopPropagation()}
      >
        <SimplifiedStateControl
          scheduleState={task.scheduleState as ScheduleState}
          canEdit={canEdit}
          onChange={(next) => {
            updateTask.mutate(
              { scheduleState: next },
              {
                onSuccess: () => notify.success(t('row.taskStateUpdated')),
                onError: (err) => notify.error(err.message),
              },
            )
          }}
        />
      </div>
      <div style={colStyles.flowState} className="px-2" />
      <div style={colStyles.block} className="px-2" />
      <div style={colStyles.blockedReason} className="px-2" />
      <div style={colStyles.planEstimate} className="px-2" />
      <div style={{ ...colStyles.taskEstimate, textAlign: 'right' }} className="px-0 text-right">
        <InlineEditableCell
          value={String(task.estimateHours ?? '')}
          canEdit={canEdit}
          fullCell
          onCommit={commitTaskEstimate}
          displayValue={task.estimateHours ?? '--'}
          className={NUMERIC_CELL_CLASS}
          style={{ fontSize: 11 }}
          inputClassName="border border-primary"
          inputStyle={{
            width: '100%',
            textAlign: 'right',
            fontSize: 11,
            fontFamily: MONO_FONT,
            borderRadius: 2,
            outline: 'none',
          }}
          ariaLabel="Task estimate"
        />
      </div>
      <div style={{ ...colStyles.toDo, textAlign: 'right' }} className="px-0 text-right">
        <InlineEditableCell
          value={String(task.todoHours ?? '')}
          canEdit={canEdit}
          fullCell
          onCommit={commitTaskTodo}
          displayValue={task.todoHours ?? '--'}
          className={NUMERIC_CELL_CLASS}
          style={{ fontSize: 11 }}
          inputClassName="border border-primary"
          inputStyle={{
            width: '100%',
            textAlign: 'right',
            fontSize: 11,
            fontFamily: MONO_FONT,
            borderRadius: 2,
            outline: 'none',
          }}
          ariaLabel="Todo hours"
        />
      </div>
      <div style={colStyles.tasksPct} className="px-2" />
      <div style={{ ...colStyles.actual, textAlign: 'right' }} className="px-0 text-right">
        <InlineEditableCell
          value={String(task.actualHours ?? '')}
          canEdit={canEdit}
          fullCell
          onCommit={commitTaskActual}
          displayValue={task.actualHours ?? '--'}
          className={NUMERIC_CELL_CLASS}
          style={{ fontSize: 11 }}
          inputClassName="border border-primary"
          inputStyle={{
            width: '100%',
            textAlign: 'right',
            fontSize: 11,
            fontFamily: MONO_FONT,
            borderRadius: 2,
            outline: 'none',
          }}
          ariaLabel="Actual hours"
        />
      </div>
      <div
        style={colStyles.owner}
        className="flex items-center overflow-hidden px-0"
        onClick={(e) => e.stopPropagation()}
      >
        <OwnerSelectCell
          ownerName={task.assigneeId ? taskOwner : null}
          assigneeId={task.assigneeId}
          members={membersList}
          canEdit={canEdit}
          onChange={handleOwnerChange}
        />
      </div>
      <div style={colStyles.milestones} className="px-2" />
      <div
        style={colStyles.devOwner}
        className="flex items-center overflow-hidden px-0"
        onClick={(e) => e.stopPropagation()}
      >
        <OwnerSelectCell
          ownerName={taskDevOwnerName}
          assigneeId={task.devOwnerId}
          members={membersList}
          canEdit={canEdit}
          onChange={handleDevOwnerChange}
          ariaLabel="Dev owner"
        />
      </div>
    </div>
  )
}

// ── Segmented state stepper (Rally parity) ──────────────────────────────────
// Both wrappers delegate to the shared StateStepper so every grid row —
// story/defect and task — uses one visual language (see state-stepper.tsx).

// Story-level schedule-state stepper (7 states).
function ScheduleStateStepper({
  value,
  canEdit,
  onChange,
  blocked,
}: {
  value: ScheduleState
  canEdit: boolean
  onChange: (next: ScheduleState) => void
  blocked?: boolean
}) {
  return (
    <StateStepper
      steps={SCHEDULE_STATE_STEPS}
      value={value}
      canEdit={canEdit}
      onChange={onChange}
      blocked={blocked}
      ariaLabel="Schedule state"
    />
  )
}

// Task-level simplified-state stepper (Define / In-Progress / Complete).
function SimplifiedStateControl({
  scheduleState,
  canEdit,
  onChange,
}: {
  scheduleState: ScheduleState
  canEdit: boolean
  onChange: (next: ScheduleState) => void
}) {
  const current = SIMPLIFIED_STATE_TO_SCHEDULE_STATE[getSimplifiedState(scheduleState)]
  return (
    <StateStepper
      steps={SIMPLIFIED_STATE_STEPS}
      value={current}
      canEdit={canEdit}
      onChange={onChange}
      ariaLabel="Task state"
    />
  )
}
