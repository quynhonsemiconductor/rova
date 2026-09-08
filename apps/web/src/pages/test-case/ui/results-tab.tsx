/**
 * Test Case Results tab (Phase D — SRS §7, §8). The list, latest-first (server-ordered, BR14),
 * and `Add Result` opens the create modal (`test_result:create`-gated).
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ClipboardList } from 'lucide-react'
import { useTestResults } from '@/features/test-cases/api'
import {
  testResultColumns,
  type TestResultCtx,
} from '@/features/test-cases/model/test-result-columns'
import { AddTestResultModal } from '@/features/test-cases/ui/add-test-result-modal'
import { listResource } from '@/shared/lib/query/resource'
import { DataTableFrame, useDataTable } from '@/shared/ui/table'
import { Button } from '@/shared/ui/button'
import { EmptyState } from '@/shared/ui/empty-state'
import { useProjectPermissions } from '@/features/access/api'

export function ResultsTab({
  testCaseId,
  projectId,
  workItemKey,
}: {
  testCaseId: string
  projectId: string
  /** The Test Case's own Work Product item key — ONE value for the whole tab (BR13). */
  workItemKey: string | null
}) {
  const { t } = useTranslation('test-cases')
  const { can } = useProjectPermissions(projectId)
  const canCreate = can('test_result:create')
  const [creating, setCreating] = useState(false)

  const query = useTestResults(testCaseId)
  const results = listResource(query)

  const columns = testResultColumns()
  const table = useDataTable(columns, { storageKey: 'test-results:columns' })

  const ctx: TestResultCtx = { workItemKey }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {creating && (
        <AddTestResultModal
          testCaseId={testCaseId}
          projectId={projectId}
          onClose={() => setCreating(false)}
        />
      )}
      <div className="flex items-center justify-end">
        <Button
          size="sm"
          disabled={!canCreate}
          title={canCreate ? undefined : t('results.addNew.noPermission')}
          onClick={() => setCreating(true)}
        >
          {t('results.addNew.label')}
        </Button>
      </div>
      <DataTableFrame
        header={table.headerProps}
        loading={results.isLoading}
        error={
          results.isError ? (
            <EmptyState
              title={t('results.error.title')}
              description={t('results.error.description')}
              size="sm"
            />
          ) : undefined
        }
        empty={
          results.phase === 'empty' ? (
            <EmptyState
              icon={<ClipboardList size={32} className="text-border-strong" />}
              title={t('results.empty.title')}
              description={t('results.empty.description')}
              size="sm"
            />
          ) : undefined
        }
      >
        {results.rows.map((row) => (
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
