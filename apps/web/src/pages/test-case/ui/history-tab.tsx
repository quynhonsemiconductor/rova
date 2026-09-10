/** Test Case Revision History tab (C6) — reuses the shared `ActivityHistoryTab`. */
import { useTranslation } from 'react-i18next'
import { useTestCaseActivity } from '@/features/test-cases/api'
import { ActivityHistoryTab } from '@/entities/activity/ui/activity-history-tab'
import { listResource } from '@/shared/lib/query/resource'

export function HistoryTab({ testCaseId }: { testCaseId: string }) {
  const { t } = useTranslation('test-cases')
  const activityQuery = useTestCaseActivity(testCaseId)
  const logs = listResource(activityQuery)
  return (
    <ActivityHistoryTab
      logs={logs}
      title={t('detail.tabs.history')}
      subtitle={t('history.subtitle')}
    />
  )
}
