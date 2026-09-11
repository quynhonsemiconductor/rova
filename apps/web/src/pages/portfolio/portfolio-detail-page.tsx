/**
 * Portfolio item detail — Epic or Feature (BA spec §5).
 *
 * Composed from the same shared pieces as Work Item detail, field for field:
 * `DetailLayout` + `DetailTabBar` for the chrome, `DetailTwoPane` for the body,
 * `RichTextEditor` for the Description, and the shared form controls in the sidebar
 * (see `ui/detail-sidebar.tsx`). Editing is buffered through `usePendingPatch` and
 * committed by a `SaveCancelBar`, with a `SaveIndicator` in the sidebar header — the
 * identical save model, so the two pages behave the same under a slow network.
 *
 * NOTE Work Item detail hand-rolls its two-pane body and its own sidebar shell rather
 * than using `DetailTwoPane`; it is the only detail page that does. This page uses the
 * shared one, like Release, Milestone, Project and Iteration detail. Matching Work Item's
 * bespoke pane would mean copying the deviation, so the parity here is in the COMPONENTS
 * and the interaction model, not in that one wrapper.
 *
 * What this page deliberately does NOT have: Linked Items (`work_item_relations` is still
 * keyed by a plain `work_item_id`), portfolio watchers and labels, and Tasks / Defects /
 * Connections, which have no portfolio equivalent by design — the Children tab is the
 * portfolio-specific tab standing in their place.
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useDetailBack } from '@/shared/lib/use-detail-back'
import { FileText, History, ListTree } from 'lucide-react'

import { TypeBadge } from '@/entities/work-item/ui/badges'
import { AcceptedChildrenBlock } from '@/features/portfolio/ui/accepted-children-block'
import { CreatePortfolioItemModal } from './ui/create-portfolio-item-modal'
import { EpicChildrenTable } from './ui/epic-children-table'
import { FeatureChildrenTable } from './ui/feature-children-table'
import { EmptyState } from '@/shared/ui/empty-state'
import { SkeletonList } from '@/shared/ui/skeleton'
import { ActivityHistoryTab } from '@/entities/activity/ui/activity-history-tab'
import { listResource } from '@/shared/lib/query/resource'
import { RichTextEditor } from '@/shared/ui/rich-text-editor'
import { SaveCancelBar } from '@/shared/ui/save-cancel-bar'
import { SaveIndicator } from '@/shared/ui/save-indicator'
import { usePendingPatch } from '@/shared/lib/hooks/use-pending-patch'
import { useSaveState } from '@/shared/lib/hooks/use-save-state'
import { useAppContext } from '@/shared/lib/stores/app-context.store'
import { useProjectPermissions } from '@/features/access/api'
import { useWorkspaceMemberOptions } from '@/features/workspaces/api'
import { useReleaseOptions } from '@/features/releases/api'
import { useMilestoneOptions } from '@/features/milestones/api'
import { useUpdateAnyWorkItem, type WorkItem } from '@/features/work-items/api'
import { CreateWorkItemModal } from '@/features/work-items/ui/create-work-item-modal'
import { PortfolioItemType } from '@/entities/work-item/model/types'
import { DetailLayout, DetailSectionHeading, DetailTwoPane } from '@/shared/ui/detail'
import {
  usePortfolioChildFeatures,
  usePortfolioChildren,
  usePortfolioItem,
  usePortfolioItemActivityLog,
  usePortfolioItems,
  useSetPortfolioItemArchived,
  useUpdatePortfolioItem,
  type PortfolioItemDetail,
  type UpdatePortfolioItemBody,
} from '@/features/portfolio/api'
import { ActionMenu, ActionMenuItem } from '@/shared/ui/action-menu'
import { ConfirmDialog } from '@/shared/ui/confirm-dialog'
import { notify, errorMessage } from '@/shared/lib/toast'
import { AttachmentBlock } from '@/features/collaboration/ui/attachment-block'
import { useUploadPastedImages } from '@/features/collaboration/use-upload-pasted-images'
import { CommentThread } from '@/features/collaboration/ui/comment-thread'
import { entityDetailUrl } from '@/shared/lib/entity-link'
import { PortfolioDetailSidebar } from './ui/detail-sidebar'

export function PortfolioDetailPage() {
  const { t } = useTranslation('portfolio')
  const navigate = useNavigate()
  const { itemId } = useParams({ from: '/auth/portfolio/$itemId' })
  const [tab, setTab] = useState('details')
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [showAddChild, setShowAddChild] = useState(false)
  /** Create a child Feature from an EPIC's Children tab, with this Epic as the fixed parent. */
  const [showAddFeature, setShowAddFeature] = useState(false)
  // `featureId` lives on the work-item UPDATE body and NOT on `CreateWorkItemSchema`, so a new
  // child is created first and linked second — the same two-step the e2e fixtures use to attach a
  // Story to a Feature. See `linkCreatedChild`: the link belongs to BOTH create buttons, so it
  // cannot live inside one of their callbacks.
  const linkChild = useUpdateAnyWorkItem()

  const { data: server, isLoading } = usePortfolioItem(itemId)
  const isEpic = server?.type === 'epic'
  // Only one of these fires — an Epic has child Features, a Feature has linked
  // work items. `enabled` is driven by passing undefined for the wrong shape.
  const { data: childFeatures = [], isLoading: featuresLoading } = usePortfolioChildFeatures(
    isEpic ? itemId : undefined,
  )
  const { data: children = [], isLoading: childrenLoading } = usePortfolioChildren(
    isEpic ? undefined : itemId,
  )
  const activityQuery = usePortfolioItemActivityLog(itemId)
  const activityLogs = listResource(activityQuery)

  // Edit rights follow the ITEM's project, not the selected one: this page is reachable
  // from a cross-project grid, so the two are frequently different.
  const { can } = useProjectPermissions(server?.projectId)
  /**
   * An ARCHIVED item is read-only, whatever the caller may do (`PORTFOLIO_ITEM_ARCHIVED`).
   *
   * Archived work contributes to no rollup, plan total or cutline, and the API now refuses every write
   * on it except Restore. Leaving the fields live meant every edit came back as an error toast — and
   * `Add Item` was worse than that: it creates the Story first and links it second, and the link is
   * refused (`WORK_ITEM_FEATURE_LINK_ARCHIVED`), so the action reported a failure having left a
   * parentless Story in the backlog.
   *
   * Restore stays available: the archive menu item reads its own state and is not gated on this.
   */
  const mayEdit = can('portfolio:edit')
  const canEdit = mayEdit && server?.archivedAt == null

  const { workspace } = useAppContext()
  const { data: members = [] } = useWorkspaceMemberOptions(workspace?.workspaceId)
  const { data: projectReleases = [] } = useReleaseOptions(server?.projectId)
  // Milestone options are Project-scoped (SRS §5.1); the sidebar unions in any already-assigned
  // milestone that falls outside them so a save cannot silently drop it.
  // Both of these are the REFERENCE feeds: this sidebar only labels and chooses. The administrative
  // lists (`useReleaseRecords` / `useMilestones`) carry the record and are gated on codes an Editor
  // does not hold, and a 403 there defaults to `[]` — which renders as "there are none".
  const { data: projectMilestones = [] } = useMilestoneOptions(server?.projectId)
  // Candidate parents: this project's Epics. Skipped entirely for an Epic, which has none.
  const epicList = usePortfolioItems({
    type: PortfolioItemType.Epic,
    projectId: server?.projectId,
  })
  const epics = useMemo(
    () =>
      isEpic ? [] : epicList.items.map((e) => ({ id: e.id, itemKey: e.itemKey, name: e.name })),
    [isEpic, epicList.items],
  )
  const releases = useMemo(
    () => projectReleases.map((r) => ({ id: r.id, releaseKey: r.releaseKey, name: r.name })),
    [projectReleases],
  )

  // Buffered editing, exactly as Work Item detail does it: controls mutate a pending
  // patch, the SaveCancelBar commits, the SaveIndicator reports. `value` is the server
  // item merged with the pending edits, so the form always renders what the user typed.
  const update = useUpdatePortfolioItem()
  const { status: saveStatus, errorMsg, wrap: wrapSave } = useSaveState()
  // Pasting an image into any of the three editors below inserts a local blob: preview; the
  // real upload happens on Save, through the same pipeline Work Item detail uses.
  const { uploadAndRewrite } = useUploadPastedImages(
    server?.id ? { entityType: 'portfolio_item', entityId: server.id } : undefined,
  )
  const {
    value: item,
    isDirty,
    saving,
    setField,
    save,
    cancel,
  } = usePendingPatch<PortfolioItemDetail, UpdatePortfolioItemBody>(
    server ?? null,
    server?.id,
    async (patch) => {
      // Upload any pasted-image previews still sitting as blob: URLs before persisting —
      // the same "upload happens on Save" step as Work Item detail, field for field.
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
      // The new editor gets the same treatment: a field left out here persists `blob:` URLs
      // that resolve to nothing once the tab closes.
      if (typeof resolved.whatSuccessLooksLike === 'string') {
        resolved.whatSuccessLooksLike = await uploadAndRewrite(resolved.whatSuccessLooksLike)
      }
      await wrapSave(async () => {
        await update.mutateAsync({ id: itemId, patch: resolved })
      })
    },
  )

  /**
   * `Add Item`'s ONE completion path — for `Create` and for `Create with details` alike.
   *
   * The Feature link used to live inside the `onCreated` callback, which made it the create
   * button's private business: `Create with details` never ran it, so that button would have
   * produced an UNLINKED Story that never appeared on the tab that created it. It also passed no
   * `onCreatedWithDetails` at all, and the modal's call was optional — so the button did nothing
   * whatsoever: no close, no navigation, no toast (P5-PI-016).
   *
   * Hoisted rather than duplicated, because the two paths differ ONLY in what happens after the
   * link. Sharing it is what guarantees the BA's "exactly ONE item, with its prefills preserved"
   * on both: one POST, one PATCH, no branch that can skip either.
   *
   * The navigation waits for the link. `/item/$itemKey` reads the item fresh, so racing it against
   * the PATCH is how a reader arrives at a detail page whose `Feature` field is still empty — the
   * prefill would look lost even though it landed a moment later. A FAILED link still navigates:
   * the Story exists either way, and the detail page is where the reader can set the Feature by
   * hand. The toast says what went wrong; leaving them on a Children tab that does not list the
   * row they just created would hide it instead.
   */
  async function linkCreatedChild(created: WorkItem, withDetails: boolean) {
    setShowAddChild(false)
    try {
      await linkChild.mutateAsync({ id: created.id, input: { featureId: itemId } })
      // No success toast on the with-details path: the navigation IS the feedback, exactly as
      // Backlog's own `onCreatedWithDetails` treats it.
      if (!withDetails) notify.success(t('detail.children.added', { key: created.itemKey }))
    } catch (err) {
      notify.error(errorMessage(err))
    }
    if (withDetails) {
      void navigate({ to: '/item/$itemKey', params: { itemKey: created.itemKey } })
    }
  }

  const setArchived = useSetPortfolioItemArchived()
  // SRS.md:471 — Archive is DISABLED while an Epic still has active child Features, rather
  // than failing on submit. The service enforces the same rule, so this only saves the user a
  // round trip; it is not the guard.
  const blockedByChildren = isEpic && childFeatures.length > 0

  const back = useDetailBack({ to: '/portfolio' })

  if (isLoading) return <SkeletonList rows={6} />
  // N1: `item` (the hook's `value`) is null exactly when `server` is.
  if (!server || !item) return <EmptyState title={t('detail.notFound')} />

  return (
    <DetailLayout
      onBack={back}
      backLabel={t('title')}
      badge={<TypeBadge type={item.type} />}
      itemKey={item.itemKey}
      copyLink={{ key: item.itemKey, name: item.name, url: entityDetailUrl('portfolioItem', item.id) }}
      title={item.name}
      /* Icons and the inline count, laid out exactly as Work Item detail builds its tabs:
         the same `size={19}` lucide glyph, and a counted tab renders its number INSIDE the
         icon slot rather than through `TabItem.count`, which is what makes the two tab bars
         read identically. `ListTree` is the Children counterpart of Tasks' `ListChecks`. */
      tabs={[
        { key: 'details', label: t('detail.tabs.details'), icon: <FileText size={19} /> },
        {
          key: 'children',
          label: t('detail.tabs.children'),
          icon: (
            <span className="flex items-center gap-1.5">
              <ListTree size={19} />
              <span className="text-ui-xs font-semibold tabular-nums">
                {isEpic ? childFeatures.length : children.length}
              </span>
            </span>
          ),
        },
        { key: 'history', label: t('detail.tabs.history'), icon: <History size={19} /> },
      ]}
      activeTab={tab}
      onTabChange={setTab}
      actions={
        // `mayEdit`, NOT `canEdit`: Restore is the one write an archived item accepts, so gating this
        // menu on the archived state would make the state permanent.
        mayEdit ? (
          <ActionMenu ariaLabel={t('detail.actions.menu')} onDark>
            <ActionMenuItem
              label={item.archivedAt ? t('detail.actions.restore') : t('archive.action')}
              destructive={!item.archivedAt}
              disabled={!item.archivedAt && blockedByChildren}
              onClick={() =>
                item.archivedAt
                  ? void setArchived
                      .mutateAsync({ id: itemId, archived: false })
                      .then(() => notify.success(t('detail.actions.restored')))
                      .catch((err: unknown) => notify.error(errorMessage(err)))
                  : setConfirmArchive(true)
              }
            />
          </ActionMenu>
        ) : undefined
      }
    >
      {tab === 'details' ? (
        <DetailTwoPane
          sidebarTitle={
            <span className="flex items-center gap-2">
              {t('detail.tabs.details')}
              <SaveIndicator status={saveStatus} errorMsg={errorMsg} />
            </span>
          }
          main={
            <div className="flex flex-col gap-4">
              {/* Total Accepted Children sits FIRST, above the Description — that is where
                  real Rally puts it. The rollup is the headline for a portfolio item, so it
                  reads before the prose rather than after three editors. */}
              <AcceptedChildrenBlock data={item.acceptedChildren} />

              {/* Description next, matching Work Item detail — the same
                  `RichTextEditor`, so the toolbar, the expand affordance and the
                  paste-an-image behaviour are identical. It reports every keystroke
                  into the pending patch; the Save bar decides when it persists. */}
              <RichTextEditor
                title={t('detail.fields.description')}
                value={item.description}
                readOnly={!canEdit}
                onChange={(html) => setField({ description: html })}
              />

              {/* Attachments — the same table Work Item detail renders (Name / Description /
                  When / Size), from the same component. Migration 0083 made the link table
                  polymorphic, so this is one route tree per entity over one code path, not a
                  second uploader. */}
              <AttachmentBlock
                subject={{ entityType: 'portfolio_item', entityId: item.id }}
                readOnly={!canEdit}
              />

              {/* Notes and Release Notes, the same editors in the same order as Work Item
                  detail. `work_items` already carried this exact pair, so migration 0080
                  added the same two columns here rather than inventing a concept. */}
              <RichTextEditor
                title={t('detail.fields.notes')}
                value={item.notes}
                readOnly={!canEdit}
                onChange={(html) => setField({ notes: html })}
              />
              <RichTextEditor
                title={t('detail.fields.releaseNotes')}
                value={item.releaseNotes}
                readOnly={!canEdit}
                onChange={(html) => setField({ releaseNotes: html })}
              />

              {/* What Success Looks Like — the BA's fourth block, on BOTH Feature and Epic
                  detail (SRS §5.1, §11.4). It had no column behind it, so the field could not
                  exist at all; migration 0086 adds one shaped exactly like Notes, which is why
                  this is the same editor rather than a bespoke box. */}
              <RichTextEditor
                title={t('detail.fields.whatSuccessLooksLike')}
                value={item.whatSuccessLooksLike}
                readOnly={!canEdit}
                onChange={(html) => setField({ whatSuccessLooksLike: html })}
              />

              {/* Comments — the SAME component Work Item detail renders, in the same place
                  (last in the main pane). It takes an entity pair rather than a work-item
                  id because migration 0082 made `comments` polymorphic; the thread itself,
                  including @mentions and own-comment editing, is not duplicated. */}
              <CommentThread
                subject={{ entityType: 'portfolio_item', entityId: item.id }}
                projectId={item.projectId}
                readOnly={!canEdit}
              />
            </div>
          }
          sidebar={
            <PortfolioDetailSidebar
              item={item}
              canEdit={canEdit}
              members={members}
              releases={releases}
              epics={epics}
              milestones={projectMilestones}
              onUpdate={setField}
            />
          }
        />
      ) : tab === 'history' ? (
        /* The SAME shared tab Release, Milestone and Project detail render — one
           polymorphic activity store means one component, not one per entity. */
        <div className="flex-1 overflow-y-auto bg-card p-6">
          <ActivityHistoryTab
            logs={activityLogs}
            title={t('detail.history.title')}
            subtitle={t('detail.history.subtitle')}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-4">
          <DetailSectionHeading>
            {isEpic ? t('detail.children.featuresHeading') : t('detail.children.itemsHeading')}
          </DetailSectionHeading>
          {isEpic && (
            <p className="text-ui-xs text-foreground-subtle">{t('detail.children.epicNote')}</p>
          )}

          {/* A real grid, per the BA's "full Backlog-style table" — the same `useDataTable` +
              `DataTableFrame` + `TableTotalsRow` every other grid uses. Two components rather than one
              parameterised table: an Epic's children are FEATURES with roll-ups, a Feature's are
              Stories and Defects with priority and iteration, and one table taking a `kind` flag would
              be a switch statement in every cell. */}
          {isEpic ? (
            <EpicChildrenTable
              features={childFeatures}
              projectId={server?.projectId}
              canEdit={canEdit}
              isLoading={featuresLoading}
              onAddFeature={() => setShowAddFeature(true)}
            />
          ) : (
            <FeatureChildrenTable
              children={children}
              projectId={server?.projectId}
              canEdit={canEdit}
              isLoading={childrenLoading}
              // No `Add Item` on an archived Feature: the link would be refused and the Story it
              // created first would be orphaned.
              onAddItem={canEdit ? () => setShowAddChild(true) : undefined}
            />
          )}
        </div>
      )}

      {/* Same commit control as Work Item detail: it appears only when there is something
          to commit, so a read-only visit never shows it. */}
      {/* Archiving is reversible (it sets `archived_at`, never a DELETE) but it removes the
          item from every default list, so it still confirms. */}
      <ConfirmDialog
        open={confirmArchive}
        title={t('archive.title')}
        message={t('detail.actions.archiveOne', { name: item.name })}
        confirmLabel={t('archive.confirm')}
        destructive
        onCancel={() => setConfirmArchive(false)}
        onConfirm={() => {
          setConfirmArchive(false)
          void setArchived
            .mutateAsync({ id: itemId, archived: true })
            .then(() => notify.success(t('archive.archived', { count: 1 })))
            // The service re-checks the child-Feature guard, so a race that slipped past the
            // disabled menu item still surfaces as a message rather than a silent no-op.
            .catch((err: unknown) => notify.error(errorMessage(err)))
        }}
      />

      {/*
        §5.2's `Add Item`: the SAME creation flow Backlog uses, restricted to Story/Defect (the
        modal already offers only those two), pre-filled with this Feature's Project, and linked
        to the Feature on the way out.
        BOTH buttons run the same completion path — see `linkCreatedChild`. The link runs before
        the toast so a failed link is reported as a failure rather than hidden behind a success
        message.
      */}
      {showAddChild && server?.projectId && (
        <CreateWorkItemModal
          projectId={server.projectId}
          onClose={() => setShowAddChild(false)}
          onCreated={(created) => void linkCreatedChild(created, false)}
          onCreatedWithDetails={(created) => void linkCreatedChild(created, true)}
        />
      )}

      {/* An EPIC's children are Features, so its Children tab creates one — through the same
          modal the Portfolio list uses, with this Epic pinned as the parent. */}
      {showAddFeature && server?.projectId && (
        <CreatePortfolioItemModal
          projectId={server.projectId}
          type={PortfolioItemType.Feature}
          fixedParentId={itemId}
          onClose={() => setShowAddFeature(false)}
        />
      )}

      <SaveCancelBar
        visible={isDirty}
        saving={saving}
        errorMsg={errorMsg}
        onSave={() => void save()}
        onCancel={cancel}
      />
    </DetailLayout>
  )
}
