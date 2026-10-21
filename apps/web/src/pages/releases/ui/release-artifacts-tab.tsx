import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'

import { useReleaseArtifacts, useSetReleaseArtifacts } from '@/features/releases/api'
import { useWorkItems } from '@/features/work-items/api'
import { useProjectPermissions } from '@/features/access/api'
import { ArtifactsTabView } from '@/entities/work-item/ui/artifacts-tab'
import type { ArtifactTableItem } from '@/entities/work-item/ui/artifact-table'
import { listResource } from '@/shared/lib/query/resource'
import { useArtifactPagination } from '@/entities/work-item/ui/use-artifact-pagination'
import { TypeBadge } from '@/entities/work-item/ui/badges'
import { EMPTY_VALUE } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { SelectionModal } from '@/shared/ui/selection-modal'
import { defaultRecordHref } from '@/entities/work-item/model/record-href'

/**
 * `MAX_LIMIT` on the shared page query. Past this the picker offers the first page only — the same
 * ceiling `useProjects` already lives with, and the reason the modal carries its own search box.
 */
const CANDIDATE_LIMIT = 100

/**
 * A portfolio row's Priority is ABSENT, not blank: `portfolio_items` has no priority column, so the
 * feed sends `''` (deliberately not a member of the enum, so nothing can read it as a value) and the
 * placeholder is applied here, because `EMPTY_VALUE` is a presentation rule. Schedule State gets no
 * equivalent — the shared table renders it as a segmented stepper, which has no text slot.
 */
function withAbsentPlaceholders(rows: ArtifactTableItem[]): ArtifactTableItem[] {
  return rows.map((r) => (r.priority === '' ? { ...r, priority: EMPTY_VALUE } : r))
}

/**
 * Release Artifacts — the dashboard rows PLUS add/remove (P3-REL-FR-029: "User can MANAGE assigned
 * Story/Defect work items from the Release detail/artifact surface", and Q02 "Confirmed: support both
 * Backlog/Work Item Detail and Release detail/artifact surface"). It was a read-only viewer.
 *
 * A release owns no join table, so membership IS `work_items.release_id`: ticking sets it to this
 * release, unticking clears it to Unscheduled — which is exactly what the BA mockup's
 * `ArtifactDashboard` toggle does. Assigning an item that already belongs to another release replaces
 * that assignment (FR-030/FR-031), and both views refresh (FR-036/FR-038) because the mutation is
 * tagged `release` as well as `work-item`.
 *
 * Rally's own release analogue is the drag-and-drop Release Planning board rather than a collection
 * page on the release, so this surface is the BA's design; the checkbox picker is the closest shared
 * primitive to the approved mockup.
 */
export function ReleaseArtifactsTab({
  releaseId,
  projectId,
  canManage,
}: {
  releaseId: string
  /** The RELEASE's own project — the scope `bulk-release` validates the selection against. */
  projectId: string
  canManage: boolean
}) {
  const { t } = useTranslation('releases')
  const navigate = useNavigate()
  const pagination = useArtifactPagination()
  const [pickerOpen, setPickerOpen] = useState(false)

  // The write is `work_item:edit` on the RELEASE's project, because the column it moves belongs to
  // the work item — `canManage` (release create/edit/delete) is a different code and, on the release
  // page, is resolved against the app-context project rather than this release's. Requiring both is
  // what stops the control appearing for a principal the bulk endpoint will refuse.
  const { can } = useProjectPermissions(projectId || undefined)
  const mayEdit = canManage && can('work_item:edit')

  const artifactsQuery = useReleaseArtifacts(releaseId, {
    pageSize: pagination.pageSize,
    search: pagination.search || undefined,
  })
  // The rows and the page cursor come out of one response; `listResource` keeps the FAILURE with
  // the rows so the table cannot print "No artifacts linked to this release" for a 400.
  const rows = useMemo(
    () => (artifactsQuery.data ? withAbsentPlaceholders(artifactsQuery.data.data) : undefined),
    [artifactsQuery.data],
  )
  const artifacts = listResource({ ...artifactsQuery, data: rows })

  // One feed for both halves of the picker: the project's stories/defects are the candidates, and the
  // subset already pointing at this release is the current selection. Reading membership from the
  // same rows is what keeps the diff below honest when the artifacts table is showing page 2.
  /**
   * What the picker's search box asked for, sent to the SERVER.
   *
   * The candidates are one page of a project's work items (`CANDIDATE_LIMIT`), and the modal used to
   * filter that page in the browser — so an item outside it could not be found and therefore could not
   * be ticked, which is what "the checkbox sometimes doesn't fetch" was. The term now narrows the
   * QUERY, so any story or defect in the project is reachable.
   */
  const [candidateSearch, setCandidateSearch] = useState('')

  /**
   * TWO reads of the same list, and they must not be one.
   *
   * `baseline` is UNSEARCHED and decides MEMBERSHIP — which items already point at this release, which
   * is both the modal's opening tick state and the left-hand side of the save diff. `offered` is the
   * searched page and decides only which rows the reader can see.
   *
   * Collapsing them is a silent data-loss bug, not an optimisation: with one searched query, unticking
   * an item and then typing in the search box drops it out of the membership set, so the save computes
   * `remove: []` and the untick is discarded without a word. The baseline has to be a fact about the
   * release, not about what is on screen.
   *
   * With no search term both hooks resolve the same query key, so this costs one request until someone
   * types.
   */
  const baselineItems = useWorkItems(
    mayEdit && projectId ? { projectId, limit: CANDIDATE_LIMIT } : null,
  )
  const offeredItems = useWorkItems(
    mayEdit && projectId
      ? { projectId, limit: CANDIDATE_LIMIT, q: candidateSearch.trim() || undefined }
      : null,
  )
  const baselinePending = baselineItems.isPending

  const isWorkProduct = (w: { type: string }) => w.type === 'story' || w.type === 'defect'
  const candidates = useMemo(
    () => (offeredItems.data ?? []).filter(isWorkProduct),
    [offeredItems.data],
  )
  const assignedIds = useMemo(
    () =>
      (baselineItems.data ?? [])
        .filter((w) => isWorkProduct(w) && w.releaseId === releaseId)
        .map((w) => w.id),
    [baselineItems.data, releaseId],
  )
  const setArtifacts = useSetReleaseArtifacts()

  // The picker cannot open before its BASELINE has arrived. `SelectionModal` materialises its draft
  // from `selectedIds` on the closed→open transition, and a draft shadows the baseline — so opening
  // while the feed is in flight would freeze `[]` in, and the diff below would then read every
  // currently assigned item as "left ticked", i.e. as nothing to do, while removing nothing and
  // adding nothing. Same shape as the user-access modal's frozen `teamIds`.
  const pickerReady = mayEdit && !baselinePending

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {mayEdit && (
        <div className="flex shrink-0 items-center justify-end border-b border-border-subtle bg-card px-4 py-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={!pickerReady}
            onClick={() => setPickerOpen(true)}
          >
            <Plus size={13} />
            {t('detailPage.artifacts.addButton')}
          </Button>
        </div>
      )}

      <ArtifactsTabView
        artifacts={artifacts}
        pageInfo={artifactsQuery.data?.pageInfo}
        entityNoun="release"
        pagination={pagination}
        // A release's artifacts come from TWO tables — `work_items.release_id` and, for a Feature,
        // `portfolio_items.release_id` — and the row's own `type` (disjoint enums) says which. The
        // SAME rule the row's ID link uses (`defaultRecordHref`): a Feature / Epic by id on the
        // Portfolio surface, a work item by key — so a click and a new tab open the same record.
        onOpenItem={(item) => {
          const href = defaultRecordHref(item.type, item.itemKey, item.id)
          if (href) void navigate({ href })
        }}
      />

      <SelectionModal
        open={pickerOpen && pickerReady}
        onClose={() => setPickerOpen(false)}
        title={t('detailPage.artifacts.pickerTitle')}
        searchPlaceholder={t('detailPage.artifacts.pickerSearch')}
        confirmLabel={t('detailPage.artifacts.pickerConfirm')}
        items={candidates.map((c) => ({
          id: c.id,
          name: `${c.itemKey} · ${c.title}`,
          icon: <TypeBadge type={c.type} size={16} />,
        }))}
        selectedIds={assignedIds}
        onSearchChange={setCandidateSearch}
        onSave={async (ids) => {
          // A diff, not a replace-set: `bulk-release` writes one release id per call, and the items
          // this release never had must not be touched at all.
          const next = new Set(ids)
          await setArtifacts.mutateAsync({
            projectId,
            releaseId,
            add: ids.filter((id) => !assignedIds.includes(id)),
            remove: assignedIds.filter((id) => !next.has(id)),
          })
        }}
      />
    </div>
  )
}
