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
import type { ReactNode } from 'react'
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

// Static Tailwind classes rather than an inline grid template — the template is fixed per layout,
// so it is a utility, not data (the FE consistency ratchet counts every inline style object).
const GRID = 'grid-cols-[90px_1fr_190px_170px]'
const ACTION_GRID = 'grid-cols-[170px_180px_200px_1fr]'

export interface ActivityRow extends ActivityLike {
  id: string
  createdAt: string
  actorId: string | null
  actorName: string | null
}

/**
 * One row of the Time / Actor / Action / Details layout. `subjectKey` names the record the row is
 * about, printed ahead of the detail — a Test Case's history also carries its Results' rows.
 */
export interface ActivityActionRow {
  action: string
  detail: ReactNode
  subjectKey?: string | null
}

/**
 * The column labels for that layout, supplied by the caller in its own namespace — the shared
 * `common` namespace carries only the default layout's labels.
 */
export interface ActivityActionColumns {
  time: string
  actor: string
  action: string
  details: string
}

export function ActivityHistoryTab({
  logs: resource,
  title,
  subtitle,
  actionLayout,
}: {
  /** Wrap the page's own activity query with `listResource(...)`. */
  logs: ListResource<ActivityRow>
  title: string
  subtitle: string
  /**
   * Opt-in Time / Actor / Action / Details layout (Test Case SRS §6.4 and its mockup, US-93
   * TC-25). Opt-in rather than a new default because every other detail page is pinned to Rally's
   * Revision / Description grid; the loading, error and empty rules stay in ONE place either way.
   */
  actionLayout?: {
    columns: ActivityActionColumns
    describe: (log: ActivityRow) => ActivityActionRow
  }
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
      // A Carryover always records its date (the DB guard requires it), but a malformed entry must
      // read "None" rather than leave a gap in the sentence (PR 653 review). It is a `YYYY-MM-DD`
      // calendar day — the same text the Target End field shows — not a timestamp to localise.
      date: blank(values.date ?? '', none),
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

  const grid = actionLayout ? ACTION_GRID : GRID
  // Keyed by a stable column id, not the label: two translated labels may coincide.
  const headers: [id: string, label: string][] = actionLayout
    ? [
        ['time', actionLayout.columns.time],
        ['actor', actionLayout.columns.actor],
        ['action', actionLayout.columns.action],
        ['details', actionLayout.columns.details],
      ]
    : [
        ['revision', t('common:revision', 'Revision')],
        ['description', t('common:description', 'Description')],
        ['creationDate', t('common:creationDate', 'Creation Date')],
        ['user', t('common:user', 'User')],
      ]

  return (
    <div className="w-full space-y-5">
      <div>
        <h2 className="text-ui-xl font-semibold text-foreground">{title}</h2>
        <p className="mt-1 text-ui-md text-muted-foreground">{subtitle}</p>
      </div>

      <section className="overflow-hidden rounded border border-border-strong bg-card">
        <div
          className={`grid ${grid} border-b border-border-strong bg-surface-hover px-4 py-2 text-ui-xs font-semibold tracking-wider text-muted-foreground uppercase`}
        >
          {headers.map(([id, label]) => (
            <span key={id}>{label}</span>
          ))}
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
          const user = (
            <span className="flex min-w-0 items-center gap-2">
              <OwnerAvatar name={userName} />
              <span className="truncate">{userName}</span>
            </span>
          )
          const time = (
            <span className="font-mono text-ui-sm text-muted-foreground">
              {formatDateTime(log.createdAt)}
            </span>
          )
          if (actionLayout) {
            const row = actionLayout.describe(log)
            return (
              <div
                key={log.id}
                className={`grid ${grid} items-start border-b border-border-inner px-4 py-3 text-ui-md text-foreground`}
              >
                {time}
                {user}
                <span className="font-semibold text-foreground">{row.action}</span>
                <span className="min-w-0 break-words">
                  {row.subjectKey && (
                    <span className="mr-2 font-mono text-ui-sm text-primary-light">
                      {row.subjectKey}
                    </span>
                  )}
                  {row.detail}
                </span>
              </div>
            )
          }
          return (
            <div
              key={log.id}
              className={`grid ${grid} items-start border-b border-border-inner px-4 py-3 text-ui-md text-foreground`}
            >
              <span className="font-mono text-ui-sm text-primary-light tabular-nums">
                {revision}
              </span>
              <span className="text-foreground">{describe(log)}</span>
              {time}
              {user}
            </div>
          )
        })}
      </section>
    </div>
  )
}
