/**
 * Milestone Detail Page — P3.3
 *
 * Two-panel layout with Details / Artifacts tabs matching the Release detail page pattern.
 * Details tab: left panel (description, notes) + right sidebar (projects, teams, releases, owner, dates, status).
 * Artifacts tab: backlog-style table of assigned US/DE work items with search + pagination.
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Link, useParams } from '@tanstack/react-router'
import { useDetailBack } from '@/shared/lib/use-detail-back'
import { FileText, History, Loader2, Package } from 'lucide-react'
import { BRAND } from '@/shared/config/brand'
import { DetailLayout, DetailTwoPane } from '@/shared/ui/detail/detail-layout'
import { DetailField } from '@/shared/ui/detail/detail-field'
import { SearchableSelect } from '@/shared/ui/searchable-select'
import { OwnerSelectField } from '@/shared/ui/entity-select-field'
import { TeamAvatar } from '@/shared/ui/team-cell'
import { RichTextEditor } from '@/shared/ui/rich-text-editor'
import { DateField } from '@/shared/ui/date-field'
import { ArtifactsTab } from './ui/detail-parts'
import { ActivityHistoryTab } from '@/entities/activity/ui/activity-history-tab'
import { listResource } from '@/shared/lib/query/resource'
import { MILESTONE_STATUS_STYLE } from '@/features/milestones/status-colors'
import { SaveCancelBar } from '@/shared/ui/save-cancel-bar'
import { usePendingPatch } from '@/shared/lib/hooks/use-pending-patch'
import { TypeBadge } from '@/entities/work-item/ui/badges'
import { useProjectPermissions } from '@/features/access/api'
import { useAppContext } from '@/shared/lib/stores/app-context.store'
import {
  useMilestone,
  useMilestoneActivityLog,
  useUpdateMilestone,
  useMilestoneProjects,
  useMilestoneTeams,
  useMilestoneReleases,
  type Milestone,
  type MilestoneStatus,
  type UpdateMilestoneInput,
} from '@/features/milestones/api'
import { useReleasesForProjects } from '@/features/releases/api'
import { useWorkspaceTeams } from '@/features/teams/api'
import { useProjectMembers } from '@/features/teams/api'
import { useProjects } from '@/features/projects/api'
import { formatWholePercent } from '@/shared/lib/utils'
import { entityLinkFor } from '@/shared/lib/entity-link'

// ── Status config ──────────────────────────────────────────────────────────────

const STATUS_STYLE = MILESTONE_STATUS_STYLE

const MILESTONE_STATUSES: MilestoneStatus[] = [
  'planned',
  'at_risk',
  'met',
  'missed',
  'cancelled',
  'completed',
]

// ── Main page ─────────────────────────────────────────────────────────────────

type TabKey = 'details' | 'artifacts' | 'history'

export function MilestoneDetailPage() {
  const { t } = useTranslation('milestones')
  // Back means back; the list is only the deep-link fallback (see `useDetailBack`).
  const back = useDetailBack({ to: '/milestones' })
  const { milestoneId } = useParams({ from: '/auth/milestones/$milestoneId' })
  const { workspace } = useAppContext()
  const workspaceId = workspace?.workspaceId ?? ''

  const { data: milestone, isLoading, isError } = useMilestone(milestoneId)
  const activityQuery = useMilestoneActivityLog(milestoneId)
  const activityLogs = listResource(activityQuery)
  const update = useUpdateMilestone()

  // Relation data (arrays of linked entity IDs)
  const { data: linkedProjectIds = [] } = useMilestoneProjects(milestoneId)
  const { data: linkedTeamIds = [] } = useMilestoneTeams(milestoneId)
  const { data: linkedReleaseIds = [] } = useMilestoneReleases(milestoneId)

  // Permissions and member/release lookups are scoped to the milestone's OWN
  // project(s) — not the app-context project — so the page is correct no matter
  // which project the workspace selector currently points at (DEV-006).
  const milestoneProjectId = milestone?.projectId ?? ''
  const { can } = useProjectPermissions(milestoneProjectId || undefined)
  const canManage = can('milestone:create') || can('milestone:edit') || can('milestone:delete')

  // The milestone's PROJECT SCOPE: its home project unioned with every linked one (FR-021/023). It
  // bounds both the selectable releases and the artifacts the picker may offer.
  const scopeProjectIds = useMemo(
    () => [...new Set([milestoneProjectId, ...linkedProjectIds].filter(Boolean))],
    [milestoneProjectId, linkedProjectIds],
  )

  // Available items for selection modals
  const { data: allProjects = [] } = useProjects(workspaceId || undefined)
  const { data: allTeams = [] } = useWorkspaceTeams(workspaceId || undefined)
  const { data: allReleases = [] } = useReleasesForProjects(scopeProjectIds)
  const { data: members = [] } = useProjectMembers(milestoneProjectId || undefined)

  const [activeTab, setActiveTab] = useState<TabKey>('details')

  // Broadcom-Rally-style deferred save (matches the Work Item / Release / Timebox
  // detail pages): name, status, owner and description/notes rich text accumulate
  // locally and commit together via the floating Save/Cancel bar. Relation sets
  // (projects/teams/releases) commit immediately via their own set-mutations from
  // the inline multi-select dropdowns; target dates are manual when no Release is
  // linked, else derived read-only.
  const {
    value: mrel,
    pending,
    isDirty,
    saving,
    setField,
    save,
    cancel,
  } = usePendingPatch<Milestone, UpdateMilestoneInput>(
    milestone ?? null,
    milestoneId,
    async (patch) => {
      try {
        return await update.mutateAsync({ id: milestoneId, ...patch })
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('detail.saveFailed'))
        throw err
      }
    },
  )

  function handleSave() {
    // N1: `mrel` is `Milestone | null` before the entity loads; `handleSave` is only reachable
    // from the rendered form below, which already guards `!mrel` (the early return below), but TS
    // can't see that across the function boundary — `?.` keeps this branch type-safe regardless.
    if (!(mrel?.name ?? '').trim()) {
      toast.error(t('detail.nameRequired'))
      return
    }
    void save().catch(() => {})
  }

  // ── Loading / error states ──────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-background">
        <Loader2 className="animate-spin text-primary" size={24} />
      </div>
    )
  }

  // N1: `mrel` (the hook's `value`) is null exactly when `milestone` is.
  if (isError || !milestone || !mrel) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-background">
        <p className="text-ui-lg text-muted-foreground">{t('detail.loadError')}</p>
        <Link to="/milestones" className="text-ui-md font-semibold text-primary hover:underline">
          {t('detail.backToMilestones')}
        </Link>
      </div>
    )
  }

  // Relation multi-selects flow through the deferred Save/Cancel patch like every
  // other field: show the pending selection (falls back to the saved link list),
  // and the milestone PATCH commits project/team/release links on Save.
  const effProjectIds = pending.projectIds ?? linkedProjectIds
  const effTeamIds = pending.teamIds ?? linkedTeamIds
  const effReleaseIds = pending.releaseIds ?? linkedReleaseIds

  // Target dates are derived (read-only) while ≥1 Release is linked; with none
  // linked they are user-managed manual fields (reconciled SRS §2 / P3-MS-019).
  const hasLinkedReleases = effReleaseIds.length > 0

  const TABS = [
    { key: 'details', label: t('detail.tabs.details'), icon: <FileText size={19} /> },
    { key: 'artifacts', label: t('detail.tabs.artifacts'), icon: <Package size={19} /> },
    {
      key: 'history',
      label: t('detail.tabs.history', 'Revision History'),
      icon: <History size={19} />,
    },
  ]

  return (
    <DetailLayout
      onBack={back}
      badge={<TypeBadge type="milestone" />}
      itemKey={milestone.milestoneKey}
      copyLink={entityLinkFor('milestone', milestone.id, milestone.milestoneKey, milestone.name)}
      title={
        canManage ? (
          <input
            value={mrel.name ?? ''}
            onChange={(e) => setField({ name: e.target.value })}
            className="w-80 rounded border-0 bg-transparent px-1 py-0.5 text-base font-semibold text-white placeholder-white/60 focus:bg-white/10 focus:outline-none"
            aria-label={t('common:name')}
          />
        ) : (
          milestone.name
        )
      }
      tabs={TABS}
      activeTab={activeTab}
      onTabChange={(key) => setActiveTab(key as TabKey)}
    >
      {activeTab === 'artifacts' ? (
        /* The picker's eligibility mirrors the server's scope rule, so it is fed the SAVED scope
           (`linked*`, not the `eff*` pending draft): an unsaved Projects/Teams edit is not yet the
           scope `assertArtifactsInMilestoneScope` will check the write against. */
        <ArtifactsTab
          milestoneId={milestoneId}
          projectIds={scopeProjectIds}
          teamIds={linkedTeamIds}
          /* `milestone:edit` specifically, which is what `PUT :id/artifacts` requires — not the
             page's create-or-edit-or-delete `canManage`, which would show the control to a
             create-only principal and hand them a 403. */
          canManage={can('milestone:edit')}
        />
      ) : activeTab === 'history' ? (
        <div className="flex-1 overflow-y-auto bg-card p-6">
          <ActivityHistoryTab
            logs={activityLogs}
            title={t('detail.historyTitle', 'Revision History')}
            subtitle={t('detail.historySubtitle', 'Every change to this milestone, newest first.')}
          />
        </div>
      ) : (
        <DetailTwoPane
          sidebarTitle={t('detail.metadataDetails')}
          main={
            <>
              <RichTextEditor
                title={t('common:description')}
                value={mrel.description}
                minHeight={120}
                readOnly={!canManage}
                onChange={(html) => setField({ description: html || null })}
              />
              <RichTextEditor
                title={t('detail.notesLabel')}
                value={mrel.notes}
                minHeight={80}
                readOnly={!canManage}
                onChange={(html) => setField({ notes: html || null })}
              />
            </>
          }
          sidebar={
            <>
              {/* Projects / Teams / Releases — many-to-many (P3-MS-FR-007/008/009),
                  edited via the shared searchable multi-select dropdown (Selected /
                  Available groups + search), consistent with every other picker
                  (Broadcom-Rally parity, replaces the old selection modal). */}
              <DetailField label={t('detail.projects')}>
                <SearchableSelect
                  variant="field"
                  multiple
                  value={effProjectIds}
                  readOnly={!canManage}
                  ariaLabel={t('detail.projects')}
                  placeholder={t('detail.noProjects', 'None')}
                  searchPlaceholder="Search"
                  options={allProjects.map((p) => ({
                    value: p.id,
                    label: p.name,
                    searchText: p.name,
                  }))}
                  onChange={(ids) => setField({ projectIds: ids as string[] })}
                />
              </DetailField>
              <DetailField label={t('detail.teams')}>
                <SearchableSelect
                  variant="field"
                  multiple
                  value={effTeamIds}
                  readOnly={!canManage}
                  ariaLabel={t('detail.teams')}
                  placeholder={t('detail.noTeams', 'None')}
                  searchPlaceholder="Search"
                  options={allTeams.map((tm) => ({
                    value: tm.id,
                    label: tm.name,
                    searchText: tm.name,
                    icon: <TeamAvatar teamKey={tm.key} name={tm.name} size={16} />,
                  }))}
                  onChange={(ids) => setField({ teamIds: ids as string[] })}
                />
              </DetailField>
              <DetailField label={t('detail.releases')}>
                <SearchableSelect
                  variant="field"
                  multiple
                  value={effReleaseIds}
                  readOnly={!canManage}
                  ariaLabel={t('detail.releases')}
                  placeholder={t('detail.noReleases', 'None')}
                  searchPlaceholder="Search"
                  options={allReleases.map((r) => ({
                    value: r.id,
                    label: r.name,
                    searchText: r.name,
                    icon: <TypeBadge type="release" size={16} />,
                  }))}
                  onChange={(ids) => setField({ releaseIds: ids as string[] })}
                />
              </DetailField>

              <div className="border-t border-border-subtle" />

              <OwnerSelectField
                label={t('common:owner')}
                value={mrel.ownerId ?? ''}
                onChange={(v) => setField({ ownerId: v || null })}
                members={members}
                disabled={!canManage}
                placeholder={t('detail.unassigned')}
              />

              <DetailField label={t('detail.targetStartDate')}>
                <DateField
                  variant="field"
                  value={mrel.targetStartDate ?? null}
                  readOnly={!canManage || hasLinkedReleases}
                  ariaLabel={t('detail.targetStartDate')}
                  onChange={
                    canManage && !hasLinkedReleases
                      ? (v) => setField({ targetStartDate: v })
                      : undefined
                  }
                />
                {hasLinkedReleases && (
                  <p className="text-ui-xs text-foreground-subtle">
                    {t('detail.derivedFromReleases')}
                  </p>
                )}
              </DetailField>

              <DetailField label={t('detail.targetEndDate')}>
                <DateField
                  variant="field"
                  value={mrel.targetEndDate ?? null}
                  readOnly={!canManage || hasLinkedReleases}
                  ariaLabel={t('detail.targetEndDate')}
                  onChange={
                    canManage && !hasLinkedReleases
                      ? (v) => setField({ targetEndDate: v })
                      : undefined
                  }
                />
                {hasLinkedReleases && (
                  <p className="text-ui-xs text-foreground-subtle">
                    {t('detail.derivedFromReleases')}
                  </p>
                )}
              </DetailField>

              <DetailField label={t('common:status')}>
                <SearchableSelect
                  variant="field"
                  value={mrel.status}
                  readOnly={!canManage}
                  ariaLabel={t('common:status')}
                  options={MILESTONE_STATUSES.map((st) => ({
                    value: st,
                    label: STATUS_STYLE[st].label,
                  }))}
                  onChange={(v) => setField({ status: v as MilestoneStatus })}
                />
              </DetailField>

              {milestone.progress && (
                <div className="space-y-2 rounded-md border border-border-subtle bg-surface-hover p-3">
                  <h3 className="text-ui-xs font-bold tracking-wider text-muted-foreground uppercase">
                    {t('detail.progress')}
                  </h3>
                  <div className="space-y-1">
                    <div className="flex justify-between text-ui-sm font-semibold text-foreground">
                      <span>{t('detail.completion')}</span>
                      <span>{formatWholePercent(milestone.progress.progressPercent)}</span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-avatar">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${milestone.progress.progressPercent ?? 0}%`,
                          // Grey when not computable: nothing estimated and not all done.
                          backgroundColor:
                            milestone.progress.progressPercent === null
                              ? BRAND.borderSubtle
                              : milestone.progress.progressPercent === 100
                                ? BRAND.success
                                : BRAND.primaryLight,
                        }}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-ui-xs text-foreground-subtle">
                    <div>
                      {t('detail.itemsLabel')}{' '}
                      <span className="font-semibold text-foreground">
                        {milestone.progress.completedItems}/{milestone.progress.totalItems}
                      </span>
                    </div>
                    <div>
                      {t('detail.pointsLabel')}{' '}
                      <span className="font-semibold text-foreground">
                        {milestone.progress.completedPoints}/{milestone.progress.totalPoints}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </>
          }
        />
      )}
      {activeTab === 'details' && (
        <SaveCancelBar
          visible={isDirty && canManage}
          saving={saving}
          errorMsg={null}
          onSave={handleSave}
          onCancel={cancel}
        />
      )}
    </DetailLayout>
  )
}
