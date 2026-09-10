/**
 * TestCaseBulkDeleteCopy — the Test Cases tab's Delete + Copy bulk actions, rendered inside the
 * shared `BulkActionBar` (via `SelectableTable`'s `bulkActions` slot) once ≥1 row is selected.
 *
 * Mirrors `BulkDeleteCopy` (work items / Tasks tab) exactly in shape, but calls the Test Case
 * mutations — `useDeleteTestCase` / `useCreateTestCase` — rather than `useDeleteWorkItem`, since a
 * Test Case is not a work item and shares no delete/duplicate route with one.
 */
import { useState } from 'react'
import { Trash2, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'

import { BulkBarButton } from '@/shared/ui/bulk-action-bar'
import { ConfirmDialog } from '@/shared/ui/confirm-dialog'
import { useCreateTestCase, useDeleteTestCase, type TestCase } from '@/features/test-cases/api'
import type { RowSelection } from '@/shared/lib/hooks/use-row-selection'

export function TestCaseBulkDeleteCopy({
  workItemId,
  testCases,
  selection,
  canDelete,
}: {
  workItemId: string
  /** The visible rows, so Copy can read the single selected row's fields to duplicate. */
  testCases: readonly TestCase[]
  selection: RowSelection
  /** `test_case:delete` on this project. */
  canDelete: boolean
}) {
  const { t } = useTranslation('test-cases')
  const del = useDeleteTestCase(workItemId)
  const create = useCreateTestCase(workItemId)
  const [confirm, setConfirm] = useState(false)

  const ids = [...selection.selectedIds]

  async function doDelete() {
    setConfirm(false)
    const results = await Promise.allSettled(ids.map((id) => del.mutateAsync(id)))
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')

    if (rejected.length === 0) {
      toast.success(`${ids.length} item${ids.length === 1 ? '' : 's'} deleted`)
    } else {
      const reasons = [
        ...new Set(
          rejected.map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason))),
        ),
      ]
      const scope =
        rejected.length === ids.length
          ? ids.length === 1
            ? 'Not deleted'
            : `None of ${ids.length} deleted`
          : `${rejected.length} of ${ids.length} not deleted`
      toast.error(`${scope}: ${reasons.join(' ')}`)
    }
    selection.clear()
  }

  async function doCopy() {
    const src = testCases.find((tc) => selection.selectedIds.has(tc.id))
    if (!src) return
    try {
      await create.mutateAsync({
        name: `${src.name} (copy)`,
        type: src.type,
        method: src.method,
        priority: src.priority,
      })
      selection.clear()
      toast.success('Test Case copied')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Copy failed')
    }
  }

  return (
    <>
      {canDelete && (
        <BulkBarButton
          icon={<Trash2 size={13} />}
          label={t('delete.action')}
          danger
          onClick={() => setConfirm(true)}
          disabled={del.isPending}
        />
      )}
      <BulkBarButton
        icon={<Copy size={13} />}
        label="Copy"
        onClick={() => void doCopy()}
        disabled={selection.count > 1 || create.isPending}
      />
      <ConfirmDialog
        open={confirm}
        title={`Delete ${ids.length} item${ids.length === 1 ? '' : 's'}?`}
        message="This permanently removes the selected item(s). Their Results are deleted with them and do not survive independently."
        confirmLabel={t('delete.action')}
        destructive
        pending={del.isPending}
        onConfirm={() => void doDelete()}
        onCancel={() => setConfirm(false)}
      />
    </>
  )
}
