/**
 * Test Case Detail Page (Phase 7, Phase A — AC4). READ-ONLY: every field renders through
 * `DetailReadonlyValue` / `RichTextEditor[readOnly]`, never an editable control — edit is Phase C.
 *
 * ONE tab (`Details`) in Phase A. `Results` and `Revision History` are omitted rather than shipped
 * as empty placeholders: neither has a backend route yet (Results is Phase D, Test Case activity
 * logging is Phase C), and a tab with nothing behind it is the same premature-affordance problem
 * `Add New`'s disabled-with-tooltip treatment exists to avoid elsewhere — confirmed with the plan
 * owner rather than assumed.
 */
import { useParams, Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { FileText } from 'lucide-react'
import { useDetailBack } from '@/shared/lib/use-detail-back'
import { useTestCaseByKey } from '@/features/test-cases/api'
import { useWorkItem } from '@/features/work-items/api'
import { DetailLayout, DetailTwoPane } from '@/shared/ui/detail/detail-layout'
import { DetailField, DetailFieldPair, DetailReadonlyValue } from '@/shared/ui/detail/detail-field'
import { RichTextEditor } from '@/shared/ui/rich-text-editor'
import { VerdictBadge } from '@/features/test-cases/ui/verdict-badge'
import { ProjectCell } from '@/shared/ui/project-cell'
import { useRecordProject } from '@/shared/lib/deep-link-project'
import { PageSpinner } from '@/shared/ui/spinner'
import { testCaseUnavailableReason } from './model/unavailable-reason'
import { TestCaseUnavailable } from './ui/test-case-unavailable'

export function TestCaseDetailPage() {
  const { t } = useTranslation('test-cases')
  const back = useDetailBack({ to: '/backlog' })
  const { testCaseKey } = useParams({ from: '/auth/test-case/$testCaseKey' })

  const { data: testCase, isLoading, isError, error } = useTestCaseByKey(testCaseKey)

  // The parent Work Item, for the "Work Product" sidebar link — a Test Case Detail page carries
  // only the parent's ID (workItemId), never its key, so the link is resolved from the loaded row.
  const { data: workItem } = useWorkItem(testCase?.workItemId ?? undefined)
  const testCaseProject = useRecordProject(testCase?.projectId)

  if (isLoading) return <PageSpinner />

  if (!testCase) {
    return (
      <TestCaseUnavailable
        reason={testCaseUnavailableReason(isError, error)}
        testCaseKey={testCaseKey}
        error={error}
        onBack={back}
      />
    )
  }

  return (
    <DetailLayout
      onBack={back}
      itemKey={testCase.testCaseKey}
      title={testCase.name}
      tabs={[{ key: 'details', label: t('detail.tabs.details'), icon: <FileText size={19} /> }]}
      activeTab="details"
      onTabChange={() => {}}
    >
      <DetailTwoPane
        sidebarTitle={t('detail.metadataTitle')}
        main={
          <>
            <RichTextEditor
              title={t('fields.description')}
              value={testCase.description}
              readOnly
              minHeight={100}
            />
            <RichTextEditor
              title={t('fields.objective')}
              value={testCase.objective}
              readOnly
              minHeight={80}
            />
            <RichTextEditor
              title={t('fields.preconditions')}
              value={testCase.preconditions}
              readOnly
              minHeight={80}
            />
            <RichTextEditor
              title={t('fields.validationInput')}
              value={testCase.validationInput}
              readOnly
              minHeight={80}
            />
            <RichTextEditor
              title={t('fields.validationExpectedResult')}
              value={testCase.validationExpectedResult}
              readOnly
              minHeight={80}
            />
            <RichTextEditor
              title={t('fields.postconditions')}
              value={testCase.postconditions}
              readOnly
              minHeight={80}
            />
            <RichTextEditor
              title={t('fields.notes')}
              value={testCase.notes}
              readOnly
              minHeight={80}
            />
          </>
        }
        sidebar={
          <div className="space-y-4">
            <DetailField label={t('fields.project')}>
              <ProjectCell
                projectKey={testCaseProject?.projectKey}
                projectName={testCaseProject?.projectName}
              />
            </DetailField>

            <DetailField label={t('fields.team')}>
              {/* NULL = "Project backlog" (SRS §5) — the same reading `work_items.team_id` uses. */}
              <DetailReadonlyValue>{t('fields.projectBacklog')}</DetailReadonlyValue>
            </DetailField>

            <DetailField label={t('fields.workProduct')}>
              {workItem ? (
                <Link
                  to="/item/$itemKey"
                  params={{ itemKey: workItem.itemKey }}
                  className="font-mono text-ui-md text-primary-light underline-offset-2 hover:underline"
                >
                  {workItem.itemKey}
                </Link>
              ) : (
                <DetailReadonlyValue>--</DetailReadonlyValue>
              )}
            </DetailField>

            <DetailFieldPair>
              <DetailField label={t('fields.type')}>
                <DetailReadonlyValue>{testCase.type}</DetailReadonlyValue>
              </DetailField>
              <DetailField label={t('fields.method')}>
                <DetailReadonlyValue>{testCase.method}</DetailReadonlyValue>
              </DetailField>
            </DetailFieldPair>

            <DetailFieldPair>
              <DetailField label={t('fields.priority')}>
                <DetailReadonlyValue>{testCase.priority}</DetailReadonlyValue>
              </DetailField>
              <DetailField label={t('fields.owner')}>
                <DetailReadonlyValue>{testCase.ownerName ?? '--'}</DetailReadonlyValue>
              </DetailField>
            </DetailFieldPair>

            <DetailField label={t('fields.assignedTo')}>
              <DetailReadonlyValue>{testCase.assigneeName ?? '--'}</DetailReadonlyValue>
            </DetailField>

            {/* BR9/BR10: Last Verdict / Last Run are read-only and maintained by the trigger — never
                `--`, `Not Run` / `Not run yet` are the absent-value sentences here. */}
            <DetailField label={t('fields.lastVerdict')}>
              <VerdictBadge verdict={testCase.lastVerdict} />
            </DetailField>
            <DetailField label={t('fields.lastRun')}>
              <DetailReadonlyValue>{testCase.lastRun ?? t('detail.notRunYet')}</DetailReadonlyValue>
            </DetailField>
          </div>
        }
      />
    </DetailLayout>
  )
}
