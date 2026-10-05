/**
 * The compact Carryover context on Iteration Burndown and Team Capacity (Phase 7 CO-08/09, BR-34).
 *
 * Carry In / Carry Out are shown only when non-zero, the transferred To Do beside them, and
 * "View report →" opens the dedicated Carryover report on the SAME Iteration. Nothing renders when
 * no Carryover touched the timebox (`summary === null`) — the chart and its Split markers are
 * untouched either way.
 */
import { ArrowRightLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { CarryoverSummary } from '@/features/reporting/api'
import { Button } from '@/shared/ui/button'

export function CarryoverBadge({
  summary,
  onOpenReport,
}: {
  summary: CarryoverSummary | null | undefined
  onOpenReport: () => void
}) {
  const { t } = useTranslation('carryover')
  if (!summary || (summary.carryIn === 0 && summary.carryOut === 0)) return null

  return (
    <div
      role="note"
      aria-label={t('badge.label')}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-border-subtle bg-surface-subtle px-3 py-1.5 text-ui-xs text-foreground"
    >
      <ArrowRightLeft size={13} className="text-muted-foreground" aria-hidden />
      {summary.carryIn > 0 && (
        <span className="font-semibold">{t('badge.carryIn', { count: summary.carryIn })}</span>
      )}
      {summary.carryOut > 0 && (
        <span className="font-semibold">{t('badge.carryOut', { count: summary.carryOut })}</span>
      )}
      <span className="text-foreground-subtle">
        · {t('badge.todo', { hours: summary.transferredTodoHours })}
      </span>
      <Button variant="link" size="sm" className="h-auto p-0 text-ui-xs" onClick={onOpenReport}>
        {t('badge.viewReport')}
      </Button>
    </div>
  )
}
