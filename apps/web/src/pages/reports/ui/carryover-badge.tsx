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

import { hasCarryoverActivity, type CarryoverSummary } from '@/features/reporting/api'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'

export function CarryoverBadge({
  summary,
  onOpenReport,
  className,
}: {
  summary: CarryoverSummary | null | undefined
  onOpenReport: () => void
  /**
   * Placement only (margins / alignment). The badge OWNS the hide decision and its own chrome, so a
   * caller never wraps it in a box that would stay behind, empty, when it hides (PR 653 review).
   */
  className?: string
}) {
  const { t } = useTranslation('carryover')
  if (!hasCarryoverActivity(summary)) return null

  return (
    <div
      role="note"
      aria-label={t('badge.label')}
      className={cn(
        'flex w-fit flex-wrap items-center gap-x-3 gap-y-1 rounded border border-border-subtle bg-surface-subtle px-3 py-1.5 text-ui-xs text-foreground',
        className,
      )}
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
