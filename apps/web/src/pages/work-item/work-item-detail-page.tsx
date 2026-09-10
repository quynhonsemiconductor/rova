/**
 * Work Item Detail Page — P1-WI-DETAIL / P1-TASK
 *
 * Route: /item/$itemKey
 * Story/Defect: Details | Tasks | Connections | Revision History
 * Task:         Details | Connections | Revision History
 * Sidebar differs by type (task shows time fields + Work Product link).
 *
 * NO `Defects` TAB, and it is not an oversight — it was built, then removed under
 * `GAP-P1-WID-001`. The BA's own audit (`06_Dev testing align/notes/P1-WID-01.md`) records the
 * approved structure as "Details, Tasks, Revision History", flags the shipped tab as "`Defects` is
 * additional to the approved mockup/SRS scope", and its BA-confirmed fix direction (2026-07-19) is
 * "hide/remove the additional `Defects` tab from this Phase 1 scope". Real Rally has no such tab
 * either. A child defect is reached from Quality or the Backlog; the link itself is not lost.
 *
 * This docblock claimed "3 tabs" throughout the tab's whole life, so the comment was never the
 * thing that drifted — the tab bar was.
 *
 * THREE OTHER ADDITIONS ARE STILL HERE ON PURPOSE. Do not remove any of them on the strength of
 * this comment; each has a different status, and only `Defects` had an instruction to Dev.
 *
 *  - `LinkedItemsBlock` and `CommentThread` (both on the Details tab) — the same note flags these
 *    as "beyond the current mockup/SRS", but assigns the action to BA/Mockup, not Dev: "evaluate
 *    extra Linked Items and Comments for Future Backlog". That evaluation has not happened —
 *    `04_Developement_tracking/Future_Backlog/` holds only Team Board, Release Planning and
 *    Iteration Status Board. Pending a BA decision, not a dev cleanup.
 *  - `Connections` (SCM pull requests + changesets) — NOT what the note means by "Linked Items";
 *    that is `LinkedItemsBlock` above. Connections appears in NO BA document: not approved, not
 *    rejected, not recorded as an extra. It postdates the audit and nobody has ruled on it.
 */
import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from '@tanstack/react-router'
import { useDetailBack } from '@/shared/lib/use-detail-back'
import {
  Bell,
  BellOff,
  FileText,
  FlaskConical,
  GitPullRequest,
  History,
  ListChecks,
  PanelRightOpen,
  Users,
  Trash2,
} from 'lucide-react'
import {
  useDeleteWorkItem,
  useTasks,
  useUpdateWorkItem,
  useWatchers,
  useToggleWatch,
  useWorkItemByKey,
  useWorkItemConnections,
  useWorkItemChangesets,
  type WorkItem,
  type UpdateWorkItemInput,
} from '@/features/work-items/api'
import { useTestCases } from '@/features/test-cases/api'
import { TestCasesTab } from './ui/test-cases-tab'
import { useCollapseToSummary } from '@/features/work-items/summary-selection'
import { useAuthStore } from '@/shared/lib/stores/auth.store'
import { useProjectPermissions } from '@/features/access/api'
import { ConfirmDialog } from '@/shared/ui/confirm-dialog'
import { notify } from '@/shared/lib/toast'
import { TypeBadge } from '@/entities/work-item/ui/badges'
import { DetailLayout } from '@/shared/ui/detail/detail-layout'
import { DetailHeaderButton } from '@/shared/ui/detail-header'
import { TasksTab } from './ui/tasks-tab'
import { HistoryTab } from './ui/detail-tabs'
import { ConnectionsTab } from './ui/connections-tab'
import { DetailSidebar } from './ui/detail-sidebar'
import { WorkItemUnavailable } from './ui/work-item-unavailable'
import { workItemUnavailableReason } from './model/unavailable-reason'
import { BRAND } from '@/shared/config/brand'
import { STORAGE_KEYS } from '@/shared/config/storage-keys'
import { RichTextEditor } from '@/shared/ui/rich-text-editor'
import { AttachmentBlock } from '@/features/collaboration/ui/attachment-block'
import { LinkedItemsBlock } from '@/features/work-items/ui/linked-items-block'
import { CommentThread } from '@/features/collaboration/ui/comment-thread'
import { Spinner } from '@/shared/ui/spinner'
import { useSaveState } from '@/shared/lib/hooks/use-save-state'
import { usePendingPatch } from '@/shared/lib/hooks/use-pending-patch'
import { SaveCancelBar } from '@/shared/ui/save-cancel-bar'
import { useUploadPastedImages } from '@/features/collaboration/use-upload-pasted-images'
import { listResource } from '@/shared/lib/query/resource'
import { EMPTY_VALUE } from '@/shared/lib/utils'

// ── Types ─────────────────────────────────────────────────────────────────────

type DetailTab = 'details' | 'tasks' | 'test-cases' | 'connections' | 'history'

// ── Helpers ───────────────────────────────────────────────────────────────────

// Local Field removed — use shared <FormField> from @/shared/ui/form-field instead.
// Sidebar selects use shared <NativeSelect> from @/shared/ui/native-select.

// ── Details tab ───────────────────────────────────────────────────────────────

function DetailsTab({
  item,
  onFieldChange,
  readOnly,
}: {
  item: WorkItem
  onFieldChange: (patch: Partial<UpdateWorkItemInput>) => void
  readOnly: boolean
}) {
  const { t } = useTranslation('work-items')
  const isTask = item.type === 'task'

  const handleChange = useCallback(
    (field: 'description' | 'notes' | 'releaseNotes') => (html: string) => {
      onFieldChange({ [field]: html || null })
    },
    [onFieldChange],
  )

  return (
    <div className="w-full space-y-5">
      <h2 className="text-ui-xl font-semibold text-foreground">{t('details.heading')}</h2>

      <RichTextEditor
        title={t('common:description')}
        value={item.description}
        minHeight={120}
        readOnly={readOnly}
        onChange={handleChange('description')}
      />

      <AttachmentBlock
        subject={{ entityType: 'work_item', entityId: item.id }}
        readOnly={readOnly}
      />

      <LinkedItemsBlock workItemId={item.id} projectId={item.projectId} readOnly={readOnly} />

      <RichTextEditor
        title={t('details.notes')}
        value={item.notes}
        minHeight={80}
        readOnly={readOnly}
        onChange={handleChange('notes')}
      />

      {/* Release Notes — Story/Defect only */}
      {!isTask && (
        <RichTextEditor
          title={t('details.releaseNotes')}
          value={item.releaseNotes}
          minHeight={80}
          readOnly={readOnly}
          onChange={handleChange('releaseNotes')}
        />
      )}

      <CommentThread
        subject={{ entityType: 'work_item', entityId: item.id }}
        projectId={item.projectId}
        readOnly={readOnly}
      />
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function WorkItemDetailPage() {
  const { t } = useTranslation('work-items')
  const { itemKey } = useParams({ from: '/auth/item/$itemKey' })
  // Back means back — the Backlog is only where a deep link lands (see `useDetailBack`).
  const back = useDetailBack({ to: '/backlog' })
  const [activeTab, setActiveTab] = useState<DetailTab>('details')

  // P1-10: sidebar collapse — persisted in localStorage so preference survives navigation
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEYS.WI_SIDEBAR_COLLAPSED) === '1'
    } catch {
      return false
    }
  })
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev
      try {
        localStorage.setItem(STORAGE_KEYS.WI_SIDEBAR_COLLAPSED, next ? '1' : '0')
      } catch {
        /* noop */
      }
      return next
    })
  }, [])

  const byKeyQuery = useWorkItemByKey(itemKey)
  const { data: itemByKey, isLoading: loadingKey } = byKeyQuery

  // WID-FR-003: collapse back to the Backlog's summary panel, item still selected (AC 7).
  const collapseToSummary = useCollapseToSummary(itemKey)

  const updateMutation = useUpdateWorkItem(itemByKey?.id ?? '')
  const { status: saveStatus, errorMsg: saveErrorMsg, wrap: wrapSave } = useSaveState()
  const { uploadAndRewrite } = useUploadPastedImages(
    itemByKey?.id ? { entityType: 'work_item', entityId: itemByKey.id } : undefined,
  )

  // P1-11: work item is read-only when the user lacks work_item:edit permission.
  // BA spec: all active roles (non-Viewer) can update any work item.
  const { can } = useProjectPermissions(itemByKey?.projectId)
  const readOnly = !can('work_item:edit')
  /**
   * DELETE, from the record itself — `P3-QA-FR-010`: "Authorized user can delete a Defect after
   * confirmation; delete is soft delete and removes it from active Backlog/Quality/Iteration/report
   * results", and §27 of the same SRS repeats the confirmation.
   *
   * The detail page is where this has to live for a Defect reached from `Quality > Defect`, because
   * `P3-QA-FR-016A` withholds that grid's bulk actions until the BA confirms them — so without it,
   * the one surface dedicated to Defects offers no way to perform a verb §3.2 grants. `Closed` /
   * `Closed Declined` are NOT prerequisites (`FR-011`), so nothing gates this on the state.
   */
  const deleteItem = useDeleteWorkItem()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const currentUserId = useAuthStore((s) => s.user?.id)

  // P1-23: watchers
  const { data: watchers = [] } = useWatchers(itemByKey?.id)
  const toggleWatch = useToggleWatch(itemByKey?.id)
  const isWatching = watchers.some((w) => w.userId === currentUserId)

  // Tasks tab count (DEV-012): drive from the SAME collection the Tasks table
  // and roll-up read, so the badge always matches the persisted child tasks and
  // refreshes after a create/delete (both invalidate the ['work-items'] root).
  const showsTasks = itemByKey != null && itemByKey.type !== 'task'
  const tasksForCountQuery = useTasks(showsTasks ? itemByKey.id : undefined)
  const tasksForCount = listResource(tasksForCountQuery)
  // `null` when the count is not KNOWN, so the badge renders `--` rather than a measured `0`. A `0`
  // on this badge is a claim that the Story has no breakdown, and it is the number a reader uses to
  // decide whether to open the tab at all.
  const taskCount = tasksForCount.phase === 'error' ? null : tasksForCount.rows.length

  // Test Cases tab count — same shape as Tasks' badge: `null` when unknown (renders `--`), a
  // measured `0` is a claim that this item has no Test Cases and the count reads the SAME
  // collection the tab itself lists (no second definition of one number).
  const showsTestCases = itemByKey != null && itemByKey.type !== 'task'
  const testCasesForCountQuery = useTestCases(showsTestCases ? itemByKey.id : undefined)
  const testCasesForCount = listResource(testCasesForCountQuery)
  const testCaseCount = testCasesForCount.phase === 'error' ? null : testCasesForCount.rows.length

  // Connections tab badge = linked pull requests + changesets (matches Rally,
  // e.g. 11 connections + 12 changesets → "23"). Both queries live under the
  // ['work-items'] root, so they refresh with the rest of the work-item views.
  const { data: scmConnections } = useWorkItemConnections(itemByKey?.id)
  const { data: scmChangesets } = useWorkItemChangesets(itemByKey?.id)
  const connectionsCount = (scmConnections?.total ?? 0) + (scmChangesets?.total ?? 0)

  // Broadcom-Rally-style Save/Cancel: field edits accumulate locally (sidebar
  // dropdowns AND rich-text editors alike) instead of auto-saving on every
  // change; the floating bar below commits or discards them all at once.
  // Falls back to an empty object while the entity is still loading — the
  // hook must run unconditionally on every render (Rules of Hooks), the
  // loadingKey/!itemByKey guards below happen after.
  const {
    value: item,
    isDirty,
    saving,
    setField,
    save,
    cancel,
  } = usePendingPatch<WorkItem, UpdateWorkItemInput>(
    itemByKey ?? ({} as WorkItem),
    itemByKey?.id,
    async (patch) => {
      // Upload any pasted-image previews still sitting as blob: URLs before
      // persisting — this is the actual "upload happens on Save" step.
      const resolved = { ...patch }
      if (typeof resolved.description === 'string') {
        resolved.description = await uploadAndRewrite(resolved.description)
      }
      if (typeof resolved.notes === 'string') {
        resolved.notes = await uploadAndRewrite(resolved.notes)
      }
      if (typeof resolved.releaseNotes === 'string') {
        resolved.releaseNotes = await uploadAndRewrite(resolved.releaseNotes)
      }
      await wrapSave(async () => {
        await updateMutation.mutateAsync(resolved)
      })
    },
  )

  if (loadingKey) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner size="lg" />
      </div>
    )
  }

  // Three different sentences, not one (GAP-P4-RBAC-003 AC6). `by-key` resolves the row and THEN
  // asserts `work_item:view` on its project, so a reader with no access gets a 403 here — and this
  // page is the only place that refusal can be rendered, because the route carries no
  // `@RequirePermission` for it and `RequirePermission` renders children when its own permission read
  // fails. Before this, every one of the three rendered as "not found" at best, and a blank page in
  // the case the BA retested. See `ui/work-item-unavailable.tsx`.
  if (!itemByKey) {
    return (
      <WorkItemUnavailable
        reason={workItemUnavailableReason(byKeyQuery.isError, byKeyQuery.error)}
        itemKey={itemKey}
        error={byKeyQuery.error}
        onBack={back}
      />
    )
  }

  const isTask = item.type === 'task'

  type TabDef = { id: DetailTab; icon: React.ReactNode; label: string }
  const tabs: TabDef[] = [
    {
      id: 'details',
      icon: <FileText size={19} />,
      label: t('tabs.details'),
    },
    ...(!isTask
      ? [
          {
            id: 'tasks' as DetailTab,
            icon: (
              <span className="flex items-center gap-1.5">
                <ListChecks size={19} />
                <span className="text-ui-xs font-semibold tabular-nums">
                  {taskCount ?? EMPTY_VALUE}
                </span>
              </span>
            ),
            label: t('tabs.tasks'),
          },
        ]
      : []),
    ...(!isTask
      ? [
          {
            id: 'test-cases' as DetailTab,
            icon: (
              <span className="flex items-center gap-1.5">
                <FlaskConical size={19} />
                <span className="text-ui-xs font-semibold tabular-nums">
                  {testCaseCount ?? EMPTY_VALUE}
                </span>
              </span>
            ),
            label: t('test-cases:tabName'),
          },
        ]
      : []),
    {
      id: 'connections',
      icon: (
        <span className="flex items-center gap-1.5">
          <GitPullRequest size={19} />
          <span className="text-ui-xs font-semibold tabular-nums">{connectionsCount}</span>
        </span>
      ),
      label: t('tabs.connections'),
    },
    {
      id: 'history',
      icon: <History size={19} />,
      label: t('tabs.history'),
    },
  ]

  // The route component persists across itemKey changes, so a Story's "Tasks"
  // tab could remain selected on a Task that has no such tab. Derive the tab to
  // render (fall back to Details) instead of resetting state — no effect/ref.
  const activeTabId: DetailTab = tabs.some((tb) => tb.id === activeTab) ? activeTab : 'details'

  return (
    <DetailLayout
      onBack={back}
      // WID-FR-003 / AC 7: collapse returns to the Backlog with this item still selected in the
      // summary panel. `onBack` above is the other gesture — it leaves the item behind.
      //
      // Story/Defect only, which is this SRS's own scope ("Full page detail cho Story/Defect")
      // and the field table's own destination: a Task is not a Backlog row, so there would be no
      // summary panel state to return it to. Omitting the prop renders no control at all.
      onCollapse={isTask ? undefined : collapseToSummary}
      collapseLabel={t('summary.collapse')}
      badge={<TypeBadge type={item.type} />}
      itemKey={item.itemKey}
      title={
        readOnly ? (
          item.title
        ) : (
          <input
            value={item.title ?? ''}
            onChange={(e) => setField({ title: e.target.value })}
            className="w-full rounded border-0 bg-transparent px-1 py-0.5 text-base font-semibold text-white placeholder-white/60 focus:bg-white/10 focus:outline-none"
            aria-label="Title"
          />
        )
      }
      tabs={tabs.map((tb) => ({ key: tb.id, label: tb.label, icon: tb.icon }))}
      activeTab={activeTabId}
      onTabChange={(k) => setActiveTab(k as DetailTab)}
      actions={
        <>
          {/* Watcher count badge — always shown (Rally parity), even at 0. */}
          <div
            className="flex items-center gap-1 rounded px-2 py-1 text-ui-sm font-medium"
            style={{ backgroundColor: 'rgba(255,255,255,0.12)', color: BRAND.accentBg }}
            title={`${watchers.length} watcher${watchers.length !== 1 ? 's' : ''}`}
          >
            <Users size={12} />
            <span>{watchers.length}</span>
          </div>

          {/* Watch / Unwatch — shared dark-bar toggle (primary tone when watching) */}
          <DetailHeaderButton
            tone={isWatching ? 'primary' : 'ghost'}
            ariaLabel={isWatching ? 'Unwatch this item' : 'Watch this item'}
            title={
              isWatching
                ? 'Unwatch — stop receiving notifications'
                : 'Watch — get notified on changes'
            }
            onClick={() => void toggleWatch.mutate(isWatching)}
            disabled={toggleWatch.isPending}
          >
            {isWatching ? <BellOff size={14} /> : <Bell size={14} />}
            <span>{isWatching ? t('watch.watching') : t('watch.watch')}</span>
          </DetailHeaderButton>

          {/* Delete — `P3-QA-FR-010`. Absent rather than disabled without the code: the verb is
              either granted or it is not, and a control that only refuses is noise. */}
          {can('work_item:delete') && (
            <DetailHeaderButton
              tone="ghost"
              ariaLabel={t('delete.action')}
              title={t('delete.title')}
              onClick={() => setConfirmDelete(true)}
              disabled={deleteItem.isPending}
            >
              <Trash2 size={14} />
              <span>{t('delete.action')}</span>
            </DetailHeaderButton>
          )}
        </>
      }
    >
      {/* The confirmation `FR-010` requires. NAMED, not typed: the delete is a SOFT one, so the
          record is recoverable in the database — the typed gate is reserved for the irreversible. */}
      <ConfirmDialog
        open={confirmDelete}
        destructive
        title={t('delete.title')}
        message={t('delete.message', { key: item.itemKey })}
        confirmLabel={t('delete.action')}
        pending={deleteItem.isPending}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          void deleteItem
            .mutateAsync({ id: item.id, projectId: item.projectId })
            .then(() => {
              setConfirmDelete(false)
              notify.success(t('delete.deleted', { key: item.itemKey }))
              // The record is gone from every active list, so staying on its page would render a
              // "not found" — leave the way `onBack` does.
              back()
            })
            .catch((e: unknown) => {
              setConfirmDelete(false)
              notify.error(e instanceof Error ? e.message : t('delete.failed'))
            })
        }}
      />
      {/* Content area */}
      <div className="flex min-h-0 flex-1 bg-avatar">
        {/* Main content */}
        <main className="flex-1 overflow-y-auto bg-surface-subtle p-6">
          {activeTabId === 'details' && (
            <DetailsTab item={item} onFieldChange={setField} readOnly={readOnly} />
          )}
          {activeTabId === 'tasks' && !isTask && (
            <TasksTab
              workItemId={item.id}
              projectId={item.projectId}
              parentTeamId={item.teamId}
              readOnly={readOnly}
            />
          )}
          {activeTabId === 'test-cases' && !isTask && (
            <TestCasesTab workItemId={item.id} projectId={item.projectId} />
          )}
          {activeTabId === 'connections' && <ConnectionsTab workItemId={item.id} />}
          {activeTabId === 'history' && <HistoryTab workItemId={item.id} />}
        </main>

        {/* Sidebar — only on details tab */}
        {activeTabId === 'details' && (
          <DetailSidebar
            item={item}
            onUpdate={setField}
            updating={saving}
            readOnly={readOnly}
            collapsed={sidebarCollapsed}
            onToggleCollapse={toggleSidebar}
            saveStatus={saveStatus}
            saveErrorMsg={saveErrorMsg}
          />
        )}
        {/* Collapsed sidebar tab — re-open handle when sidebar is hidden */}
        {activeTabId === 'details' && sidebarCollapsed && (
          <button
            onClick={toggleSidebar}
            title="Show sidebar"
            className="flex w-6 shrink-0 items-center justify-center border-l border-input bg-surface-subtle transition-colors hover:bg-border-subtle"
          >
            <PanelRightOpen size={14} className="text-muted-foreground" />
          </button>
        )}
      </div>

      {/* Floating Save/Cancel — appears once any field has an unsaved edit
          (sidebar dropdowns or the rich-text editors), matching Broadcom
          Rally's UX instead of auto-saving each field on change. */}
      <SaveCancelBar
        visible={isDirty && !readOnly}
        saving={saving}
        errorMsg={saveStatus === 'error' ? saveErrorMsg : null}
        onSave={() => void save()}
        onCancel={cancel}
      />
    </DetailLayout>
  )
}
