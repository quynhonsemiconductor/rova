/**
 * NOT RENDERED ANYWHERE — read this before wiring it back in.
 *
 * The Backlog was its only call site, and that cell was removed on the product owner's ruling
 * (2026-08-24) because of HOW it was mounted, not because the verb is unwanted: the cell carried
 * `ml-auto` inside a row whose `minWidth` is `max-content`, so on a horizontally scrolling grid it
 * detached from its own row — the trigger rendered mid-row and its popover opened at the far left of
 * the screen. The header had no matching trailing column either, so header and rows resolved to
 * different widths and every column drifted out of alignment. See the note at the removal site in
 * `pages/backlog/backlog-page.tsx`.
 *
 * Kept rather than deleted because the component itself is sound and the requirement it was built
 * for is still on the books — `P2-BL-FR-022` / §124, "Delete Defect | Row or detail action with
 * confirmation", which the BA raised twice. Removing the row affordance is therefore a DECLARED
 * REVERSAL of a BA finding, recorded in `docs/PR-487-BA-CONFLICTS.md`.
 *
 * IF IT COMES BACK: mount it as a real trailing COLUMN that the header renders too, never as an
 * `ml-auto` cell the header knows nothing about. That is the mistake that produced both defects.
 */
import { useTranslation } from 'react-i18next'

import { RowActionsMenu } from '@/shared/ui/row-actions-menu'
import { useDeleteWorkItem } from '@/features/work-items/api'

/**
 * The per-ROW actions on a work-item grid — today, Delete.
 *
 * `P2-BL-FR-022` and §124 of the same SRS put this here: "Delete Defect | Row or detail action with
 * confirmation" — the ROW being the half that was missing. The verb was reachable two ways before and neither was that row: the bulk bar, which
 * only appears once rows are selected, and (since the detail page grew one) the record itself. So the
 * BA's report — "cannot delete work item in Backlog" — was true of the grid even though the server had
 * allowed the delete all along.
 *
 * Shared rather than written into the page: the same row action belongs on Quality and Iteration
 * Status when the BA rules on those grids, and a second copy is how two grids come to confirm
 * differently. It also keeps `backlog-page.tsx` under the file-length ratchet.
 *
 * The confirmation is NAMED, not typed: the delete is SOFT (`P3-QA-FR-020` retains the child Tasks,
 * attachments, comments and relations), so the record is recoverable and the typed gate is reserved
 * for the irreversible.
 *
 * The menu/dialog/pending/error-toast plumbing itself now lives in the mutation-agnostic
 * `RowActionsMenu` (Phase F) — this component supplies only its own labels and `useDeleteWorkItem`
 * mutation, so `TestCaseRowActions` (the Test Cases tab) can reuse the identical shape without a
 * second copy of the wiring.
 */
export function WorkItemRowActions({
  itemId,
  itemKey,
  projectId,
  canDelete,
  onDeleted,
}: {
  itemId: string
  itemKey: string
  projectId: string
  /** `work_item:delete` on this project. The menu renders NOTHING without it — an action that only
   *  refuses is noise, and the row already has no other verb. */
  canDelete: boolean
  onDeleted?: () => void
}) {
  const { t } = useTranslation('work-items')
  const del = useDeleteWorkItem()

  return (
    <RowActionsMenu
      menuLabel={t('rowActions.label', { key: itemKey })}
      deleteActionLabel={t('delete.action')}
      confirmTitle={t('delete.title')}
      confirmMessage={t('delete.message', { key: itemKey })}
      deletedMessage={t('delete.deleted', { key: itemKey })}
      failedMessage={t('delete.failed')}
      canDelete={canDelete}
      onDelete={async () => {
        await del.mutateAsync({ id: itemId, projectId })
        onDeleted?.()
      }}
    />
  )
}
