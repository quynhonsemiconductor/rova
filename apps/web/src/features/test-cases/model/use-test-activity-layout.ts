import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { describeTestActivity } from './test-activity'

/** The `actionLayout` both Test Case and Test Result Revision History tabs pass — one wording. */
export function useTestActivityLayout() {
  const { t } = useTranslation('test-cases')
  return useMemo(
    () => ({
      columns: {
        time: t('history.columns.time'),
        actor: t('history.columns.actor'),
        action: t('history.columns.action'),
        details: t('history.columns.details'),
      },
      describe: (log: Parameters<typeof describeTestActivity>[1]) => describeTestActivity(t, log),
    }),
    [t],
  )
}
