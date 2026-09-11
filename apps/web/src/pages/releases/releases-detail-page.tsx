/**
 * Release Detail Page — P3.2 Release Management
 *
 * Visual layout matching SRS §5 and §6.1 with rich text editing areas (Theme, Notes) on the left
 * and a right sidebar panel of METADATA ONLY — Project, State, Start/Release Date, Planned Velocity,
 * Plan Estimate, Version (P3-REL-FR-018, AC #10).
 *
 * No Task Roll-up, no Accepted total and no Burndown, per P3-REL-FR-023 / FR-024 / FR-037: every
 * release progress and acceptance number belongs to `Portfolio > Release Tracking`. Do not re-add
 * one here — see the CLAUDE.md note on `GET /releases/:id/burndown` for the history.
 * P3.3: Added Artifacts tab showing linked US/DE work items.
 */
import { useState } from 'react'
import { ProjectCell } from '@/shared/ui/project-cell'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Link, useParams } from '@tanstack/react-router'
import { useDetailBack } from '@/shared/lib/use-detail-back'
import { FileText, History, Loader2, Package } from 'lucide-react'
import { DetailLayout, DetailTwoPane } from '@/shared/ui/detail/detail-layout'
import { DetailField, DetailFieldPair, DetailReadonlyValue } from '@/shared/ui/detail/detail-field'
import { SearchableSelect } from '@/shared/ui/searchable-select'
import { DateField } from '@/shared/ui/date-field'
import { Input } from '@/shared/ui/input'
import { RichTextEditor } from '@/shared/ui/rich-text-editor'
import { SaveCancelBar } from '@/shared/ui/save-cancel-bar'
import { usePendingPatch } from '@/shared/lib/hooks/use-pending-patch'
import { TypeBadge } from '@/entities/work-item/ui/badges'
import { ReleaseArtifactsTab } from './ui/release-artifacts-tab'
import { ActivityHistoryTab } from '@/entities/activity/ui/activity-history-tab'
import { listResource } from '@/shared/lib/query/resource'
import { RELEASE_STATES, RELEASE_STATUS_STYLE } from './model/release-states'
import { useProjectPermissions } from '@/features/access/api'
import { useRecordProject } from '@/shared/lib/deep-link-project'
import { entityDetailUrl } from '@/shared/lib/entity-link'
import {
  useRelease,
  useUpdateRelease,
  useReleaseActivityLog,
  type Release,
  type ReleaseStatus,
  type UpdateReleaseInput,
} from '@/features/releases/api'

type TabKey = 'details' | 'artifacts' | 'history'

export function ReleaseDetailPage() {
  const { t } = useTranslation('releases')
  // Back means back; the list is only the deep-link fallback (see `useDetailBack`).
  const back = useDetailBack({ to: '/releases' })
  const { releaseId } = useParams({ from: '/auth/releases/$releaseId' })

  const { data: release, isLoading, isError } = useRelease(releaseId)

  /**
   * Both of these read the RELEASE's own project, never the selected one — the rule the Artifacts
   * tab below already followed, and this file's only remaining exception to it.
   *
   * A release id is workspace-unique, so `/releases/:id` is a valid deep link with no project in the
   * URL and a bookmarked or forwarded one opens a release in ANY project the caller can read. Asking
   * `useProjectPermissions` about the selected project therefore answered a question about the wrong
   * project in both directions: an Editor on this release's project saw it locked because they hold
   * nothing on the one they happened to have selected, and an Admin of the selected project saw
   * editors on a release they cannot write — every Save 403ing to `/403`. The scope label had the
   * same fault visibly: a PAY release rendered `Project scope: NXP`.
   */
  const { can } = useProjectPermissions(release?.projectId)
  const releaseProject = useRecordProject(release?.projectId)
  const canManage = can('release:create') || can('release:edit') || can('release:delete')
  const activityQuery = useReleaseActivityLog(releaseId)
  const activityLogs = listResource(activityQuery)
  const update = useUpdateRelease(releaseId)

  const [activeTab, setActiveTab] = useState<TabKey>('details')

  // Broadcom-Rally-style deferred save (matches the Work Item + Timebox detail
  // pages): every field edit — title, dates, velocity/estimate, version, theme/
  // notes rich text, lifecycle state — accumulates locally and commits together
  // via the floating Save/Cancel bar, instead of auto-saving each field on blur.
  const {
    value: vrel,
    isDirty,
    saving,
    setField,
    save,
    cancel,
  } = usePendingPatch<Release, UpdateReleaseInput>(release ?? null, releaseId, async (patch) => {
    try {
      return await update.mutateAsync(patch)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('detail.updateFailed'))
      throw err
    }
  })

  function handleSave() {
    // N1: `vrel` is `Release | null` before the entity loads; the rendered form already guards
    // `!release` (the early return below), but TS can't see that across the function boundary.
    if (!(vrel?.name ?? '').trim()) {
      toast.error(t('create.nameRequired'))
      return
    }
    if (vrel?.startDate && vrel.releaseDate && vrel.releaseDate < vrel.startDate) {
      toast.error(t('create.dateOrder'))
      return
    }
    void save().catch(() => {})
  }

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-background">
        <Loader2 className="animate-spin text-primary" size={24} />
      </div>
    )
  }

  // N1: `vrel` (the hook's `value`) is null exactly when `release` is.
  if (isError || !release || !vrel) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-background">
        <p className="text-ui-lg text-muted-foreground">{t('detailPage.loadError')}</p>
        <Link to="/releases" className="text-ui-md font-semibold text-primary hover:underline">
          {t('detailPage.backToReleases')}
        </Link>
      </div>
    )
  }

  const TABS = [
    { key: 'details', label: t('detailPage.tabs.details'), icon: <FileText size={19} /> },
    { key: 'artifacts', label: t('detailPage.tabs.artifacts'), icon: <Package size={19} /> },
    {
      key: 'history',
      label: t('detailPage.tabs.history', 'Revision History'),
      icon: <History size={19} />,
    },
  ]

  return (
    <DetailLayout
      onBack={back}
      badge={<TypeBadge type="release" />}
      itemKey={release.releaseKey}
      copyLink={{
        key: release.releaseKey,
        name: release.name ?? '',
        url: entityDetailUrl('release', release.id),
      }}
      title={
        canManage ? (
          <input
            value={vrel.name ?? ''}
            onChange={(e) => setField({ name: e.target.value })}
            className="w-72 rounded border-0 bg-transparent px-1 py-0.5 text-base font-semibold text-white placeholder-white/60 focus:bg-white/10 focus:outline-none"
            aria-label={t('common:name')}
          />
        ) : (
          release.name
        )
      }
      tabs={TABS}
      activeTab={activeTab}
      onTabChange={(key) => setActiveTab(key as TabKey)}
    >
      {activeTab === 'artifacts' ? (
        /* The RELEASE's own project, not the app-context one: the bulk write validates the selection
           against it, and a release opened from a notification need not belong to the selected
           project. */
        <ReleaseArtifactsTab
          releaseId={releaseId}
          projectId={release.projectId}
          canManage={canManage}
        />
      ) : activeTab === 'history' ? (
        <div className="flex-1 overflow-y-auto bg-card p-6">
          <ActivityHistoryTab
            logs={activityLogs}
            title={t('detailPage.historyTitle', 'Revision History')}
            subtitle={t(
              'detailPage.historySubtitle',
              'Every change to this release, newest first.',
            )}
          />
        </div>
      ) : (
        <DetailTwoPane
          sidebarTitle={t('detailPage.metadataTitle')}
          main={
            <>
              <RichTextEditor
                title={t('detailPage.themeTitle')}
                value={vrel.theme}
                minHeight={100}
                readOnly={!canManage}
                onChange={(html) => setField({ theme: html || null })}
              />
              <RichTextEditor
                title={t('detailPage.notesTitle')}
                value={vrel.notes}
                minHeight={140}
                readOnly={!canManage}
                onChange={(html) => setField({ notes: html || null })}
              />
              {/* Release Notes — separate from Theme/Notes (P3-REL-FR-034). */}
              <RichTextEditor
                title={t('detailPage.releaseNotesTitle', 'Release Notes')}
                value={vrel.releaseNotes}
                minHeight={120}
                readOnly={!canManage}
                onChange={(html) => setField({ releaseNotes: html || null })}
              />
            </>
          }
          sidebar={
            /*
              METADATA ONLY (P3-REL-FR-018, AC #10). The Task Roll-up + Accepted panel that used to
              sit below this — and the Burndown table below that, and the fetch that fed it — are
              gone: FR-023 forbids a Task Roll-up, Burndown or any other release progress widget
              here, and FR-024/FR-037 put every accepted/progress total in
              `Portfolio > Release Tracking`.
            */
            <div className="space-y-4">
              <DetailField label={t('detailPage.projectScope')}>
                <ProjectCell
                  projectKey={releaseProject?.projectKey}
                  projectName={releaseProject?.projectName}
                />
              </DetailField>

              <DetailField label={t('detailPage.lifecycleState')}>
                <SearchableSelect
                  variant="field"
                  value={(vrel.state ?? vrel.status) as ReleaseStatus}
                  readOnly={!canManage}
                  ariaLabel={t('detailPage.lifecycleState')}
                  options={RELEASE_STATES.map((st) => ({
                    value: st,
                    label: RELEASE_STATUS_STYLE[st].label,
                  }))}
                  onChange={(v) => setField({ state: v as ReleaseStatus })}
                />
              </DetailField>

              <DetailFieldPair>
                <DetailField label={t('detail.startDateLabel')}>
                  <DateField
                    variant="field"
                    value={vrel.startDate || null}
                    readOnly={!canManage}
                    ariaLabel={t('detail.startDateLabel')}
                    onChange={canManage ? (v) => setField({ startDate: v }) : undefined}
                  />
                </DetailField>

                <DetailField label={t('detail.releaseDateLabel')}>
                  <DateField
                    variant="field"
                    value={vrel.releaseDate || null}
                    readOnly={!canManage}
                    ariaLabel={t('detail.releaseDateLabel')}
                    onChange={canManage ? (v) => setField({ releaseDate: v }) : undefined}
                  />
                </DetailField>
              </DetailFieldPair>

              <DetailFieldPair>
                <DetailField label={t('detail.plannedVelocityLabel')}>
                  {canManage ? (
                    <Input
                      type="number"
                      min={0}
                      value={vrel.plannedVelocity ?? ''}
                      onChange={(e) =>
                        setField({
                          plannedVelocity: e.target.value === '' ? null : Number(e.target.value),
                        })
                      }
                      placeholder="0"
                    />
                  ) : (
                    <DetailReadonlyValue mono>{vrel.plannedVelocity ?? '--'}</DetailReadonlyValue>
                  )}
                </DetailField>

                <DetailField label={t('detail.planEstimateLabel')}>
                  {canManage ? (
                    <Input
                      type="number"
                      min={0}
                      value={vrel.planEstimate ?? ''}
                      onChange={(e) =>
                        setField({
                          planEstimate: e.target.value === '' ? null : Number(e.target.value),
                        })
                      }
                      placeholder="0"
                    />
                  ) : (
                    <DetailReadonlyValue mono>{vrel.planEstimate ?? '--'}</DetailReadonlyValue>
                  )}
                </DetailField>
              </DetailFieldPair>

              <DetailField label={t('detailPage.versionTag')}>
                {canManage ? (
                  <Input
                    value={vrel.version ?? ''}
                    onChange={(e) => setField({ version: e.target.value || null })}
                    placeholder="e.g. v2.4.0"
                  />
                ) : (
                  <DetailReadonlyValue>{vrel.version || '--'}</DetailReadonlyValue>
                )}
              </DetailField>
            </div>
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
