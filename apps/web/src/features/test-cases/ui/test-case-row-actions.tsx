/**
 * The per-ROW Delete on the Test Cases tab (F2). `test_case:delete` governs visibility, matching
 * the plan's §4 permission grant (all eight codes to Editor). Reuses the SAME `RowActionsMenu`
 * shell `WorkItemRowActions` uses (CLAUDE.md: a second copy is how two grids come to confirm
 * differently) — only the labels and the mutation differ.
 *
 * The confirmation is NAMED, not typed: the delete is SOFT, but unlike a Work Item's delete
 * (which RETAINS everything hanging off the row, `P3-QA-FR-020`) a Test Case's Results are
 * soft-deleted WITH it and do not survive independently — the copy says so, rather than reusing
 * Work Item delete's "retained" language for a different actual behaviour.
 *
 * A TRAILING cell, not a declared column: not resizable, not reorderable, not hideable, and it
 * has no header counterpart (`test-case-columns.tsx` never lists it). Hidden at rest and revealed
 * on `group-hover` (the parent row carries `group`) AND `focus-within` — both, or a keyboard-only
 * reader tabbing to the trigger would see nothing to press (CLAUDE.md: the row's only verb).
 */
import { useTranslation } from 'react-i18next'

import { RowActionsMenu } from '@/shared/ui/row-actions-menu'
import { useDeleteTestCase } from '@/features/test-cases/api'

export function TestCaseRowActions({
  testCaseId,
  testCaseKey,
  workItemId,
  canDelete,
}: {
  testCaseId: string
  testCaseKey: string
  workItemId: string
  /** `test_case:delete` on this project. The menu renders NOTHING without it. */
  canDelete: boolean
}) {
  const { t } = useTranslation('test-cases')
  const del = useDeleteTestCase(workItemId)

  if (!canDelete) return null

  return (
    <div className="flex shrink-0 items-center justify-center opacity-0 transition-opacity duration-100 group-hover:opacity-100 focus-within:opacity-100">
      <RowActionsMenu
        menuLabel={t('rowActions.label', { key: testCaseKey })}
        deleteActionLabel={t('delete.action')}
        confirmTitle={t('delete.title')}
        confirmMessage={t('delete.message', { key: testCaseKey })}
        deletedMessage={t('delete.deleted', { key: testCaseKey })}
        failedMessage={t('delete.failed')}
        canDelete={canDelete}
        onDelete={() => del.mutateAsync(testCaseId)}
      />
    </div>
  )
}
