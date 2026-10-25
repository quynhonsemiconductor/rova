import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'

import {
  useMilestoneArtifacts,
  useMilestoneArtifactIds,
  useMilestoneArtifactCandidates,
  useSetMilestoneArtifacts,
} from '@/features/milestones/api'
import { ArtifactsTabView } from '@/entities/work-item/ui/artifacts-tab'
import type { ArtifactTableItem } from '@/entities/work-item/ui/artifact-table'
import { listResource } from '@/shared/lib/query/resource'
import { useArtifactPagination } from '@/entities/work-item/ui/use-artifact-pagination'
import { TypeBadge } from '@/entities/work-item/ui/badges'
import { EMPTY_VALUE } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { SelectionModal } from '@/shared/ui/selection-modal'
import { recordHrefForClick } from '@/entities/work-item/model/record-href'

// ── Artifacts tab ──────────────────────────────────────────────────────────────

/**
 * A portfolio row's Priority is ABSENT: `portfolio_items` has no priority column, so the feed sends
 * `''` and the `EMPTY_VALUE` placeholder is applied here, where presentation rules live. Schedule
 * State gets no equivalent — the shared table renders it as a stepper, which has no text slot.
 */
function withAbsentPlaceholders(rows: ArtifactTableItem[]): ArtifactTableItem[] {
  return rows.map((r) => (r.priority === '' ? { ...r, priority: EMPTY_VALUE } : r))
}

/**
 * Milestone Artifacts — the dashboard rows PLUS the `Add Artifact` control (P3-MS-FR-028: "`Add
 * Artifact` follows the Backlog Story/Defect create/picker pattern and appends the current Milestone
 * relationship"). It was a read-only viewer, which left milestone membership reachable only by
 * opening each work item in turn — `GAP-P3-MS-001`, still an open P0 on the BA's branch, and the one
 * gap with a documented Rally analogue (Rally's milestone detail has its own Artifacts collection
 * page with `Add New` and a multi-select `Remove`).
 *
 * The picker writes the milestone end of the link (`PUT /milestones/:id/artifacts`, SRS §5.2), which
 * shares `assertArtifactsInMilestoneScope` with the work-item end — so an artifact that is legal from
 * the Work Item sidebar is legal here and vice versa. Removal is unticking: the payload REPLACES the
 * assignment list, and §4/AC-13 make removal affect nothing but that one relationship (Release,
 * Iteration, rank and item identity are untouched, which is true by construction because this write
 * only ever touches `milestone_artifacts`).
 *
 * Rally's row-level multi-select `Remove` is not reproduced: the table is the shared read-only
 * `ArtifactTable`, so a selection column would have to be added there for every surface at once.
 */
export function ArtifactsTab({
  milestoneId,
  projectIds,
  teamIds,
  canManage,
}: {
  milestoneId: string
  /** The milestone's project scope — its own project plus any linked ones (FR-021/023). */
  projectIds: readonly string[]
  /** Its selected Teams; empty means no team scope, so every team is eligible. */
  teamIds: readonly string[]
  canManage: boolean
}) {
  const { t } = useTranslation('milestones')
  const navigate = useNavigate()
  const pagination = useArtifactPagination()
  const [pickerOpen, setPickerOpen] = useState(false)

  const artifactsQuery = useMilestoneArtifacts(milestoneId, {
    pageSize: pagination.pageSize,
    search: pagination.search || undefined,
  })
  // See the release tab: the failure travels with the rows, so an unreachable endpoint reads as a
  // failure rather than as "no artifacts linked to this milestone".
  const rows = useMemo(
    () => (artifactsQuery.data ? withAbsentPlaceholders(artifactsQuery.data.data) : undefined),
    [artifactsQuery.data],
  )
  const artifacts = listResource({ ...artifactsQuery, data: rows })

  // The full link set, not the visible page: the write REPLACES the list, so a set built from one
  // page would unlink everything past the page boundary.
  const { data: linkedIds = [], isPending: baselinePending } = useMilestoneArtifactIds(
    canManage ? milestoneId : undefined,
  )
  const { items: candidates } = useMilestoneArtifactCandidates(canManage ? projectIds : [], teamIds)
  const setArtifacts = useSetMilestoneArtifacts()

  // The picker cannot open before its BASELINE has arrived. `SelectionModal` materialises its draft
  // from `selectedIds` on the closed→open transition, and a draft shadows the baseline — so opening
  // while the link list is still in flight would freeze `[]` in, and saving would unlink every
  // existing artifact. Same shape as the user-access modal's frozen `teamIds`, with data loss at the
  // end of it instead of a stuck button.
  const pickerReady = canManage && !baselinePending

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {canManage && (
        <div className="flex shrink-0 items-center justify-end border-b border-border-subtle bg-card px-4 py-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={!pickerReady}
            onClick={() => setPickerOpen(true)}
          >
            <Plus size={13} />
            {t('artifacts.addButton')}
          </Button>
        </div>
      )}

      <ArtifactsTabView
        artifacts={artifacts}
        pageInfo={artifactsQuery.data?.pageInfo}
        entityNoun="milestone"
        pagination={pagination}
        // The SAME rule the row's ID link uses (`defaultRecordHref`): a Feature / Epic by id on the
        // Portfolio surface, a work item by key — so a click and a new tab open the same record.
        onOpenItem={(item) => {
          // Reports (once) when the row's type has no URL rule, instead of a silent no-op.
          const href = recordHrefForClick(item.type, item.itemKey, item.id)
          if (href) void navigate({ href })
        }}
      />

      <SelectionModal
        open={pickerOpen && pickerReady}
        onClose={() => setPickerOpen(false)}
        title={t('artifacts.pickerTitle')}
        searchPlaceholder={t('artifacts.pickerSearch')}
        confirmLabel={t('artifacts.pickerConfirm')}
        items={candidates.map((c) => ({
          id: c.id,
          name: `${c.itemKey} · ${c.title}`,
          icon: <TypeBadge type={c.type} size={16} />,
        }))}
        selectedIds={linkedIds}
        onSave={async (workItemIds) => {
          await setArtifacts.mutateAsync({ milestoneId, workItemIds })
        }}
      />
    </div>
  )
}
