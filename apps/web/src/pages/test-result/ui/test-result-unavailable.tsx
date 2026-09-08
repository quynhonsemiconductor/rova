/**
 * The three ways `/test-result/$testResultId` can fail to show a record — as three different
 * sentences. Same shape as `pages/test-case/ui/test-case-unavailable.tsx`.
 */
import { SearchX } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { AccessDenied } from '@/shared/ui/access-denied'
import { Button } from '@/shared/ui/button'
import { EmptyState } from '@/shared/ui/empty-state'
import { LoadErrorState } from '@/shared/ui/load-error-state'
import type { TestResultUnavailableReason } from '../model/unavailable-reason'

export function TestResultUnavailable({
  reason,
  error,
  onBack,
}: {
  reason: TestResultUnavailableReason
  error?: unknown
  onBack: () => void
}) {
  const { t } = useTranslation('test-cases')

  const back = (
    <Button variant="secondary" size="sm" onClick={onBack}>
      {t('detail.back')}
    </Button>
  )

  if (reason === 'denied') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <AccessDenied />
        {back}
      </div>
    )
  }

  if (reason === 'loadFailed') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <LoadErrorState error={error} />
        {back}
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center">
      <EmptyState
        icon={<SearchX size={28} className="text-foreground-subtle" />}
        title={t('results.detail.notFound')}
        description={t('results.detail.notFoundHint')}
        action={back}
      />
    </div>
  )
}
