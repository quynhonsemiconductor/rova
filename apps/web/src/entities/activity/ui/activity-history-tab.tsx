/**
 * ActivityHistoryTab — the shared "Revision History" table for EVERY entity
 * detail page (work item, iteration, project, milestone, release). A newest-first
 * grid (Revision # / Description / Creation Date / User). Each detail page passes
 * the logs from its own `useActivityLog`-style hook; humanisation is the single
 * shared `describeActivity`.
 *
 * The `logs` prop is a {@link ListResource}, not an array, and that is deliberate. It used to be
 * `logs: ActivityRow[]` plus `isLoading`, with no way to express failure — so all five entity
 * detail pages passed `data ?? []` and a 403 or a 500 rendered "No revisions yet.", a statement
 * about the entity's history drawn from a request that never landed. Widening this prop back to an
 * array re-opens that on every one of them at once; see `shared/lib/query/resource.ts`.
 */
import { useTranslation } from 'react-i18next'
import {
  carryoverActivityLabel,
  describeActivity,
  type ActivityLike,
} from '@/entities/work-item/model/activity'
import type { ListResource } from '@/shared/lib/query/resource'
import { formatDateTime } from '@/shared/lib/utils'
import { LoadErrorState } from '@/shared/ui/load-error-state'
import { OwnerAvatar } from '@/shared/ui/owner-cell'
import { Spinner } from '@/shared/ui/spinner'

const GRID = '90px 1fr 190px 170px'

interface ActivityRow extends ActivityLike {
  id: string
  createdAt: string
  actorId: string | null
  actorName: string | null
}

export function ActivityHistoryTab({
  logs: resource,
  title,
  subtitle,
}: {
  /** Wrap the page's own activity query with `listResource(...)`. */
  logs: ListResource<ActivityRow>
  title: string
  subtitle: string
}) {
  const { t } = useTranslation()
  const logs = resource.rows

  /** Carryover entries (CO-07) read through i18n; everything else keeps `describeActivity`. */
  function describe(log: ActivityRow): string {
    const carryover = carryoverActivityLabel(log)
    if (!carryover) return describeActivity(log)
    const blank = (value: string, fallback: string) => (value === '' ? fallback : value)
    const unscheduled = t('carryover:history.unscheduled')
    const none = t('carryover:history.none')
    const values = carryover.values
    return t(carryover.key, {
      ...values,
      source: blank(values.source ?? '', unscheduled),
      target: blank(values.target ?? '', unscheduled),
      old: blank(values.old ?? '', none),
      new: blank(values.new ?? '', none),
    })
  }

  if (resource.isLoading) {
    return (
      <div className="flex h-20 items-center justify-center">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="w-full space-y-5">
      <div>
        <h2 className="text-ui-xl font-semibold text-foreground">{title}</h2>
        <p className="mt-1 text-ui-md text-muted-foreground">{subtitle}</p>
      </div>

      <section className="overflow-hidden rounded border border-border-strong bg-card">
        <div
          className="grid border-b border-border-strong bg-surface-hover px-4 py-2 text-ui-xs font-semibold tracking-wider text-muted-foreground uppercase"
          style={{ gridTemplateColumns: GRID }}
        >
          <span>{t('common:revision', 'Revision')}</span>
          <span>{t('common:description', 'Description')}</span>
          <span>{t('common:creationDate', 'Creation Date')}</span>
          <span>{t('common:user', 'User')}</span>
        </div>

        {/*
          `error` before `empty`: "No revisions yet." is a claim about the entity, and a failed
          read is not evidence for it. The two branches are exclusive by construction because
          `phase` is a single discriminant, not two independent booleans.
        */}
        {resource.phase === 'error' && <LoadErrorState error={resource.error} size="sm" />}

        {resource.phase === 'empty' && (
          <div className="px-4 py-6 text-center text-ui-xl text-foreground-subtle">
            {t('common:noRevisions', 'No revisions yet.')}
          </div>
        )}

        {logs.map((log, i) => {
          const revision = logs.length - i
          const userName = log.actorName ?? log.actorId ?? 'System'
          return (
            <div
              key={log.id}
              className="grid items-start border-b border-border-inner px-4 py-3 text-ui-md text-foreground"
              style={{ gridTemplateColumns: GRID }}
            >
              <span className="font-mono text-ui-sm text-primary-light tabular-nums">
                {revision}
              </span>
              <span className="text-foreground">{describe(log)}</span>
              <span className="font-mono text-ui-sm text-muted-foreground">
                {formatDateTime(log.createdAt)}
              </span>
              <span className="flex min-w-0 items-center gap-2">
                <OwnerAvatar name={userName} />
                <span className="truncate">{userName}</span>
              </span>
            </div>
          )
        })}
      </section>
    </div>
  )
}
