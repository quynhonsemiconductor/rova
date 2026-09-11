/**
 * Test Cases tab on Story/Defect detail (Phase 7, Phase A read path + Phase B create + Phase F
 * delete/reorder).
 *
 * The list, in rank order, the ID cell opens the Test Case's own detail route, `Add New` opens
 * the create modal (`test_case:create`-gated — AC3/B4), and each row carries a drag grip (F3) and
 * a trailing Delete action (F2, `test_case:delete`-gated).
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { ListChecks } from 'lucide-react'
import { useReorderTestCase, useTestCases } from '@/features/test-cases/api'
import { testCaseColumns, type TestCaseCtx } from '@/features/test-cases/model/test-case-columns'
import { CreateTestCaseModal } from '@/features/test-cases/ui/create-test-case-modal'
import { TestCaseRowActions } from '@/features/test-cases/ui/test-case-row-actions'
import { listResource } from '@/shared/lib/query/resource'
import { useDataTable, useRowRerank, SelectableTable } from '@/shared/ui/table'
import { Button } from '@/shared/ui/button'
import { EmptyState } from '@/shared/ui/empty-state'
import { useProjectPermissions } from '@/features/access/api'
import { TestCaseRow } from './test-case-row'

export function TestCasesTab({ workItemId, projectId }: { workItemId: string; projectId: string }) {
  const { t } = useTranslation('test-cases')
  const navigate = useNavigate()
  const { can } = useProjectPermissions(projectId)
  const canCreate = can('test_case:create')
  const canEdit = can('test_case:edit')
  const canDelete = can('test_case:delete')
  const [creating, setCreating] = useState(false)

  const query = useTestCases(workItemId)
  const testCases = listResource(query)

  const columns = testCaseColumns()
  const table = useDataTable(columns, { storageKey: 'test-cases:columns' })

  // Rank drag-reorder (F3). No column sort exists on this tab (the whole set loads at once, in
  // rank order, like the Tasks tab), so reorder is only ever disabled by the permission gate.
  const reorderMutation = useReorderTestCase(workItemId)
  const rerank = useRowRerank({
    items: testCases.rows,
    disabled: !canEdit,
    onReorder: ({ id, beforeId, afterId }) =>
      reorderMutation.mutate(
        { id, beforeId, afterId },
        { onError: (err) => toast.error(err instanceof Error ? err.message : t('reorder.failed')) },
      ),
  })

  const ctx: TestCaseCtx = {
    rowNum: (id) => testCases.rows.findIndex((tc) => tc.id === id) + 1,
    openTestCase: (testCaseKey) =>
      void navigate({ to: '/test-case/$testCaseKey', params: { testCaseKey } }),
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {creating && (
        <CreateTestCaseModal workItemId={workItemId} onClose={() => setCreating(false)} />
      )}
      <div className="flex items-center justify-end">
        <Button
          size="sm"
          disabled={!canCreate}
          title={canCreate ? undefined : t('addNew.noPermission')}
          onClick={() => setCreating(true)}
        >
          {t('addNew.label')}
        </Button>
      </div>
      <SelectableTable
        rows={rerank.items}
        selectable={false}
        headerProps={table.headerProps}
        padClassName="px-3"
        dnd={{
          dndContextProps: rerank.dndContextProps,
          sortableContextProps: rerank.sortableContextProps,
        }}
        loading={testCases.isLoading}
        skeleton={{ rows: 5 }}
        error={
          testCases.isError ? (
            <EmptyState title={t('error.title')} description={t('error.description')} size="sm" />
          ) : undefined
        }
        empty={
          testCases.phase === 'empty' ? (
            <EmptyState
              icon={<ListChecks size={32} className="text-border-strong" />}
              title={t('empty.title')}
              description={t('empty.description')}
              size="sm"
            />
          ) : undefined
        }
        renderRow={(row) => (
          <TestCaseRow key={row.id} id={row.id} dragDisabled={!canEdit}>
            {(dragHandle) => (
              <>
                {table.renderCells(row, { ...ctx, dragHandle: () => dragHandle })}
                <TestCaseRowActions
                  testCaseId={row.id}
                  testCaseKey={row.testCaseKey}
                  workItemId={workItemId}
                  canDelete={canDelete}
                />
              </>
            )}
          </TestCaseRow>
        )}
      />
    </div>
  )
}
