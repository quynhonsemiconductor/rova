/** Test Result Revision History tab (Phase E) — reuses the shared `ActivityHistoryTab`. */
import { useTranslation } from 'react-i18next'
import { useTestResultActivity } from '@/features/test-cases/api'
import { ActivityHistoryTab } from '@/entities/activity/ui/activity-history-tab'
import { listResource } from '@/shared/lib/query/resource'

export function HistoryTab({ testResultId }: { testResultId: string }) {
  const { t } = useTranslation('test-cases')
  const activityQuery = useTestResultActivity(testResultId)
  const logs = listResource(activityQuery)
  return (
    <ActivityHistoryTab
      logs={logs}
      title={t('detail.tabs.history')}
      subtitle={t('history.subtitle')}
    />
  )
}
