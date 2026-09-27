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
      // DE-18: its OWN subtitle. Both history tabs read the `test-cases` namespace, and this one
      // used `history.subtitle` — the Test CASE sentence — so a Test Result's revision log
      // announced itself as "…on this Test Case", naming the wrong record on the one surface whose
      // whole purpose is to say what happened to THIS one.
      subtitle={t('results.history.subtitle')}
    />
  )
}
