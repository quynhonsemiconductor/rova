/**
 * The Release-mismatch Issues panel (RT §5, RT-AC-10, RT-AC-11).
 *
 * Hangs off the row's warning badge as a Radix popover, which is what gives it the two
 * behaviours the acceptance checklist names: it is portalled to `<body>`, so it CANNOT be
 * clipped by the grid's scroll container (the approved mockup's own panel is cut off at the
 * bottom), and clicking outside closes it while clicking inside does not.
 *
 * A popover rather than a modal for the same reason Capacity Planning's Breakdown is one: it
 * annotates the row it hangs from, and a dialog would cover the grid the reader is comparing
 * against.
 */
import { useTranslation } from 'react-i18next'
import { AlertTriangle, X } from 'lucide-react'
import { Popover as PopoverPrimitive } from 'radix-ui'

import type { ReleaseTrackingRow } from '@/features/reporting/api'
import { AppPopoverContent } from '@/shared/ui/app-popover'
import { useNavigate } from '@tanstack/react-router'
import { IconButton } from '@/shared/ui/icon-button'
import { RatioMeter } from '@/shared/ui/ratio-meter'
import { WarningCountBadge } from '@/shared/ui/warning-count-badge'
import { EMPTY_VALUE, formatDate } from '@/shared/lib/utils'
import { CellLink } from '@/shared/ui/cell-link'
import { entityDetailPath } from '@/shared/lib/entity-link'

export function IssuesPanel({
  row,
  releaseName,
  releaseStart,
  releaseEnd,
}: {
  row: ReleaseTrackingRow
  releaseName: string
  releaseStart: string | null
  releaseEnd: string | null
}) {
  const { t } = useTranslation(['release-tracking', 'common'])
  const navigate = useNavigate()
  if (row.mismatches.length === 0) return null

  // The comparison window is the SELECTED release's, never the mismatched item's own (§5) —
  // the reader is asking "against what am I mismatched", and that is this release.
  const comparison = t('issues.comparison', {
    release: releaseName,
    from: formatDate(releaseStart),
    to: formatDate(releaseEnd),
  })

  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <button type="button" className="cursor-pointer border-none bg-transparent p-0">
          <WarningCountBadge
            count={row.mismatches.length}
            heading={t('issues.badgeHeading', { count: row.mismatches.length })}
            label={t('issues.badgeLabel')}
          />
        </button>
      </PopoverPrimitive.Trigger>
      <AppPopoverContent
        align="start"
        sideOffset={6}
        className="z-50 w-[420px] rounded-sm border border-border-strong bg-card shadow-xl"
      >
        <div className="max-h-[70vh] overflow-y-auto p-4">
          <div className="mb-3 flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-ui-lg font-semibold text-foreground">{row.name}</p>
              <p className="text-ui-xs text-foreground-subtle">{comparison}</p>
            </div>
            {/* RT-AC-10 is satisfied by outside-click, and that stays the behaviour — but it is not
                DISCOVERABLE, and it is not reachable at all for someone who opened this from the
                keyboard. Radix's `Close` returns focus to the trigger, which a click on the backdrop
                does not. */}
            <PopoverPrimitive.Close asChild>
              <IconButton aria-label={t('common:close')} size="sm">
                <X size={14} />
              </IconButton>
            </PopoverPrimitive.Close>
          </div>

          <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ui-sm">
            <dt className="text-muted-foreground">{t('issues.plannedStart')}</dt>
            <dd className="text-foreground">{formatDate(row.plannedStartDate)}</dd>
            <dt className="text-muted-foreground">{t('issues.plannedEnd')}</dt>
            <dd className="text-foreground">{formatDate(row.plannedEndDate)}</dd>
            <dt className="text-muted-foreground">{t('issues.teams')}</dt>
            <dd className="text-foreground">
              {row.teams.length > 0
                ? row.teams.map((team) => team.name).join(', ')
                : t('common:unassigned')}
            </dd>
          </dl>

          {/* Progress is calculated from ALL direct children and stays independent of mismatch
              classification (§5): a Feature can be 100% done and fully mismatched. */}
          {row.progress && (
            <div className="mb-3 space-y-2">
              <ProgressLine
                label={t('issues.progress.points')}
                accepted={row.progress.points.accepted}
                total={row.progress.points.total}
                percent={row.progress.points.percent}
              />
              <ProgressLine
                label={t('issues.progress.stories')}
                accepted={row.progress.stories.accepted}
                total={row.progress.stories.total}
                percent={row.progress.stories.percent}
              />
              <ProgressLine
                label={t('issues.progress.defects')}
                accepted={row.progress.defects.accepted}
                total={row.progress.defects.total}
                percent={row.progress.defects.percent}
              />
            </div>
          )}

          {row.fullMismatch && (
            <p className="mb-3 rounded border border-destructive-border bg-destructive-bg px-2.5 py-2 text-ui-xs text-destructive">
              {t('issues.fullMismatch')}
            </p>
          )}

          {/* Grouped by issue type. `Release mismatch` is the only approved type in this slice;
              adding another needs a BA rule, so the grouping is a heading rather than a map. */}
          <p className="mb-1.5 text-ui-sm font-semibold text-foreground">
            {t('issues.count', { count: row.mismatches.length })}
          </p>
          <p className="mb-1 rounded bg-background px-2 py-1 text-ui-xs font-semibold text-muted-foreground">
            {t('issues.typeReleaseMismatch')}
          </p>
          <ul className="space-y-2">
            {row.mismatches.map((issue) => (
              <li key={issue.childId} className="border-t border-border-inner pt-2">
                <p className="text-ui-sm text-foreground">
                  <CellLink
                    href={entityDetailPath.workItem(issue.childKey)}
                    onClick={() =>
                      void navigate({ to: '/item/$itemKey', params: { itemKey: issue.childKey } })
                    }
                  >
                    {issue.childKey}
                  </CellLink>{' '}
                  {issue.childTitle}
                </p>
                <p className="mt-0.5 text-ui-xs text-destructive">{comparison}</p>
                <p className="text-ui-xs text-foreground-subtle">
                  {t('issues.itemRelease', { release: issue.itemReleaseName ?? EMPTY_VALUE })}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </AppPopoverContent>
    </PopoverPrimitive.Root>
  )
}

/**
 * One progress line, from the shared meter.
 *
 * This was a second hand-rolled copy of `RatioMeter` inside the same feature as the first — same
 * percentage-and-ratio row over a thin bar, and the same always-blue percentage, so a Feature at 0%
 * was printed in the colour reserved for finished work.
 *
 * `percent` is the server's floored value and is passed through rather than re-derived (RT-BR-05).
 */
function ProgressLine({
  label,
  accepted,
  total,
  percent,
}: {
  label: string
  accepted: number
  total: number
  percent: number | null
}) {
  const { t } = useTranslation('release-tracking')
  return (
    <RatioMeter
      ratio={total > 0 ? accepted / total : null}
      percent={percent}
      accepted={accepted}
      total={total}
      label={t('issues.progress.ratio', { accepted, total, label })}
    />
  )
}
