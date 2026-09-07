/**
 * Test Cases tab on Story/Defect detail (Phase 7, Phase A read path + Phase B create).
 *
 * The list, in rank order, the ID cell opens the Test Case's own detail route, and `Add New`
 * opens the create modal (`test_case:create`-gated — AC3/B4).
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { ListChecks } from 'lucide-react'
import { useTestCases } from '@/features/test-cases/api'
import { testCaseColumns, type TestCaseCtx } from '@/features/test-cases/model/test-case-columns'
import { CreateTestCaseModal } from '@/features/test-cases/ui/create-test-case-modal'
import { listResource } from '@/shared/lib/query/resource'
import { DataTableFrame, useDataTable } from '@/shared/ui/table'
import { Button } from '@/shared/ui/button'
import { EmptyState } from '@/shared/ui/empty-state'
import { useProjectPermissions } from '@/features/access/api'

export function TestCasesTab({ workItemId, projectId }: { workItemId: string; projectId: string }) {
  const { t } = useTranslation('test-cases')
  const navigate = useNavigate()
  const { can } = useProjectPermissions(projectId)
  const canCreate = can('test_case:create')
  const [creating, setCreating] = useState(false)

  const query = useTestCases(workItemId)
  const testCases = listResource(query)

  const columns = testCaseColumns()
  const table = useDataTable(columns, { storageKey: 'test-cases:columns' })

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
      <DataTableFrame
        header={table.headerProps}
        loading={testCases.isLoading}
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
      >
        {testCases.rows.map((row) => (
          <div
            key={row.id}
            className="group flex min-h-[35px] items-center border-b border-border-inner px-3 text-ui-md transition-colors hover:bg-primary-lighter"
          >
            {table.renderCells(row, ctx)}
          </div>
        ))}
      </DataTableFrame>
    </div>
  )
}
