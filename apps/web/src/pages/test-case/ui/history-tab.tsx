/** Test Case Revision History tab (C6) — reuses the shared `ActivityHistoryTab`. */
import { useTranslation } from 'react-i18next'
import { useTestCaseActivity } from '@/features/test-cases/api'
import { useTestActivityLayout } from '@/features/test-cases/model/use-test-activity-layout'
import { ActivityHistoryTab } from '@/entities/activity/ui/activity-history-tab'
import { listResource } from '@/shared/lib/query/resource'

export function HistoryTab({ testCaseId }: { testCaseId: string }) {
  const { t } = useTranslation('test-cases')
  const activityQuery = useTestCaseActivity(testCaseId)
  const logs = listResource(activityQuery)
  const actionLayout = useTestActivityLayout()
  return (
    <ActivityHistoryTab
      logs={logs}
      title={t('detail.tabs.history')}
      subtitle={t('history.subtitle')}
      // SRS §6.4: Time / Actor / Action / Details, each row keyed by its own record (US-93 TC-25).
      actionLayout={actionLayout}
    />
  )
}
