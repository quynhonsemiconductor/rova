/**
 * Reports > Team Capacity (Team Capacity SRS §6).
 *
 * A read-only projection of the Team Status hours: four indicators, then a Team → Member table
 * where each Team row expands. Deliberately built from the same primitives as Team Status
 * (`useDataTable` for the header + column widths, `RowExpandToggle`, `NESTED_ROW_INDENT`) so the
 * two screens read as one system — they show the same numbers and must not look like different
 * products.
 *
 * No editable capacity control, no utilisation card, no progress bar, no totals row and no status
 * colours on the indicators: §6 lists what the approved report contains, and none of those are in
 * it. Capacity is still edited on Team Status, which owns `team_status:edit`.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EMPTY_VALUE } from '@/shared/lib/utils'
import { useTableSort } from '@/shared/lib/hooks/use-table-sort'
import { NESTED_ROW_INDENT } from '@/shared/config/layout'
import { useIterationOptions } from '@/features/iterations/api'
import { listResource } from '@/shared/lib/query/resource'
import { useTeamCapacityReport, type TeamCapacityTeam } from '@/features/reporting/api'
import { iterationsInScope, teamScopeLabel } from '@/features/reporting/scope'
import { TEAM_STATUS_STYLE } from '@/features/teams/status-colors'
import { Avatar } from '@/shared/ui/avatar'
import { ColumnFieldsMenu } from '@/shared/ui/column-fields-menu'
import { EmptyState } from '@/shared/ui/empty-state'
import { MetricCard } from '@/shared/ui/metric-card'
import { MetricStrip } from '@/shared/ui/metric-strip'
import { RowExpandToggle } from '@/shared/ui/row-expand-toggle'
import { StatusBadge } from '@/shared/ui/status-badge'
import { IterationPicker } from '@/shared/ui/timebox-picker'
import { DataTableFrame, useDataTable, type ColumnSpec } from '@/shared/ui/table'
import { NUMERIC_CELL_CLASS } from '@/shared/lib/utils'

import { CarryoverBadge } from './carryover-badge'
import { ReportExportButton } from './report-export-button'
import { ReportSurface } from './report-surface'
import { useSelectedIteration } from '../model/use-selected-iteration'

type ColKey = 'member' | 'capacity' | 'estimate' | 'todo' | 'actual'

/** The four hour measures, in the fixed order SRS §3 lists them. */
const HOUR_KEYS = ['capacity', 'estimate', 'todo', 'actual'] as const
type HourKey = (typeof HOUR_KEYS)[number]

/**
 * `132h`, or `--` when there is no number yet.
 *
 * `undefined` reaches here while the request is in flight and after it fails, and it used to be
 * coerced with `?? 0` — so a failed load printed four measured-looking `0h` cards above an error
 * message. `EMPTY_VALUE` is what the rest of the app renders for an absent value, and the KPI row
 * stays mounted so the layout does not jump.
 */
const formatHours = (value: number | undefined) => (value === undefined ? EMPTY_VALUE : `${value}h`)

/**
 * Hours off a totals/member record by column key. One mapping, used by the group row, the
 * member row and the sort comparator, so a renamed field cannot make two of them disagree.
 */
const hoursFor = (values: TeamCapacityTeam['totals'], key: HourKey): number =>
  key === 'capacity'
    ? values.capacityHours
    : key === 'estimate'
      ? values.estimateHours
      : key === 'todo'
        ? values.todoHours
        : values.actualHours

export function TeamCapacityReport({
  projectId,
  teamId,
  onOpenCarryover,
}: {
  projectId: string
  teamId: string | undefined
  /** Phase 7 CO-09 — the badge's View report opens the Carryover report on this Iteration. */
  onOpenCarryover?: (iterationId: string) => void
}) {
  const { t } = useTranslation(['reports', 'common'])
  /**
   * The PICKER's feed is a resource for the same reason the report's own query is one.
   *
   * `const { data: allIterations = [] } = useIterations` — the timebox RECORD — made a failing
   * `/v1/iterations` indistinguishable from a project with no timeboxes: the picker emptied,
   * `selectedId` stayed null, and the surface rendered `capacity.empty.noIteration` **plus four
   * `--` KPI cards** — which is precisely the "measured absence for a request that never ran"
   * this file's own docblock claims to have fixed on the report query alone.
   *
   * The REFERENCE feed, not `useIterations`: this picker needs a NAME and a window for every state
   * (a finished sprint is the one a capacity report is usually read about), and it must not read the
   * timebox record, which is `timebox:view`.
   */
  const iterationsQuery = useIterationOptions(projectId)
  const iterationFeed = listResource(iterationsQuery)
  // Same scope rule as the report itself: the team's own timeboxes plus the project's shared ones.
  const iterations = iterationsInScope(iterationFeed.rows, teamId)
  const { selectedId, select } = useSelectedIteration(projectId, iterations)
  const { data, isLoading, isError } = useTeamCapacityReport({
    projectId,
    teamId,
    // `null` (nothing selected) means the same thing to this hook as `undefined`, and it takes
    // the latter — translate at the boundary rather than widening the hook's contract.
    iterationId: selectedId ?? undefined,
  })

  /**
   * Sort the TEAM rows by an hour aggregate. Members keep their server order inside a team: the SRS
   * orders them by the roster, and re-sorting a two-level table on one key reads as flat.
   *
   * `useTableSort`, not a local pair of `useState`s — this was a verbatim reimplementation of it, the
   * fifth copy of "same column flips direction, a new column starts ascending" that the hook exists to
   * end. Eight other grids already call it.
   */
  const { sortField: sortCol, sortDir, toggle: toggleSort } = useTableSort<string>()

  const columns: ColumnSpec<TeamCapacityTeam, unknown, ColKey>[] = [
    {
      key: 'member',
      label: t('capacity.columns.member'),
      defaultWidth: 320,
      minWidth: 200,
      grow: true,
      locked: true,
    },
    ...HOUR_KEYS.map((key) => ({
      key,
      label: t(`capacity.columns.${key}`),
      defaultWidth: 120,
      minWidth: 90,
      align: 'right' as const,
      sortCol: key,
    })),
  ]
  const table = useDataTable<TeamCapacityTeam, unknown, ColKey>(columns, {
    storageKey: 'reports:team-capacity',
    // `?? 'asc'`: the hook reports a null direction while nothing is sorted, and the header wants a
    // concrete one to draw its caret with.
    sort: { col: sortCol, dir: sortDir ?? 'asc', onSort: toggleSort },
    leadingWidth: 24,
  })

  const totals = data?.totals
  const teams = data?.teams ?? []
  const sortedTeams =
    sortCol && HOUR_KEYS.includes(sortCol as HourKey)
      ? [...teams].sort(
          (a, b) =>
            (hoursFor(a.totals, sortCol as HourKey) - hoursFor(b.totals, sortCol as HourKey)) *
            (sortDir === 'desc' ? -1 : 1),
        )
      : teams

  // §6: the empty state has to say WHICH absence this is — no capacity planned, no scoped task
  // data, or neither — because they are different problems for the reader to act on.
  const emptyDescription =
    selectedId === null
      ? t('capacity.empty.noIteration')
      : data && !data.hasCapacity && !data.hasTaskHours
        ? t('capacity.empty.neither')
        : data && !data.hasCapacity
          ? t('capacity.empty.noCapacity')
          : data && !data.hasTaskHours
            ? t('capacity.empty.noTasks')
            : undefined

  return (
    <ReportSurface
      title={t('capacity.title', {
        scope: teamScopeLabel(data?.context.teamName, t('common:allTeams')),
      })}
      caption={t('capacity.source')}
      controls={
        <>
          <span className="text-ui-xs font-semibold text-foreground-subtle">{t('iteration')}</span>
          <IterationPicker iterations={iterations} selectedId={selectedId} onSelect={select} />
          <ReportExportButton
            projectId={projectId}
            request={
              selectedId ? { report: 'capacity', projectId, teamId, iterationId: selectedId } : null
            }
          />
          <ColumnFieldsMenu {...table.fieldsMenuProps} />
        </>
      }
      strip={
        <MetricStrip>
          <MetricCard
            label={t('capacity.indicators.capacity')}
            value={formatHours(totals?.capacityHours)}
            minWidth={120}
          />
          <MetricCard
            label={t('capacity.indicators.estimate')}
            value={formatHours(totals?.estimateHours)}
            minWidth={120}
          />
          {/* No `valueColor` on any of the four. ToDo was amber and Actual green, which reads as a
              verdict — amber says "look at this" about a number that is simply the remaining work,
              and §6 gives these indicators no status meaning to report. Capacity and Estimate were
              already neutral, so three of the four values also disagreed about what a colour meant. */}
          <MetricCard
            label={t('capacity.indicators.todo')}
            value={formatHours(totals?.todoHours)}
            minWidth={120}
          />
          <MetricCard
            label={t('capacity.indicators.actual')}
            value={formatHours(totals?.actualHours)}
            minWidth={120}
          />
        </MetricStrip>
      }
      /**
       * A failed load is NOT an empty scope — that told the reader "no capacity has been planned", a
       * data conclusion drawn from a network fault. It sits on the SHELL rather than on the table so
       * the four indicators go absent with it; on the table it rendered below a strip still showing
       * `0h`.
       */
      error={
        iterationFeed.isError ? (
          <EmptyState
            title={t('timeboxFeedError.title')}
            description={t('timeboxFeedError.body')}
          />
        ) : isError ? (
          <EmptyState title={t('capacity.error.title')} description={t('capacity.error.body')} />
        ) : undefined
      }
    >
      {/* Phase 7 CO-09 — the same compact Carryover badge as Burndown, owning its own chrome. */}
      <CarryoverBadge
        summary={data?.carryover}
        onOpenReport={() => selectedId && onOpenCarryover?.(selectedId)}
        className="mx-3 my-2"
      />
      <DataTableFrame<ColKey>
        header={table.headerProps}
        leading={<div className="w-6 shrink-0" />}
        loading={isLoading && !data}
        skeleton={{ rows: 8, cols: 5 }}
        /* No totals row. It printed `capacityHours / estimateHours / todoHours / actualHours` — the
           same four numbers from the same `totals` object as the four indicator cards directly above
           it, on the same screen. §6 lists what the approved report contains and a table footer is
           not in it; the indicators ARE the totals. */
        empty={
          teams.length === 0 ? (
            <EmptyState
              title={t('capacity.empty.title')}
              description={emptyDescription ?? t('capacity.empty.neither')}
            />
          ) : undefined
        }
      >
        {sortedTeams.map((team) => (
          <TeamGroup key={team.id ?? team.name} team={team} colStyles={table.colStyles} />
        ))}
      </DataTableFrame>
    </ReportSurface>
  )
}

/**
 * One Team row plus its members.
 *
 * Expanded by default, matching the mockup: the member rows are the report's substance, and a
 * reader who opened Team Capacity is looking for them.
 */
function TeamGroup({
  team,
  colStyles,
}: {
  team: TeamCapacityTeam
  colStyles: Record<string, React.CSSProperties>
}) {
  const { t } = useTranslation('reports')
  const [expanded, setExpanded] = useState(true)

  return (
    <div>
      {/* Group row — the same anatomy as a Team Status member group (caret, avatar, name, a
          muted child count) so the two grouped tables read as one component, not two. */}
      <div className="flex h-9 items-center border-b border-border-inner bg-surface-hover px-3">
        <div className="w-6 shrink-0" />
        <div className="flex min-w-0 items-center gap-2 px-2" style={colStyles.member}>
          <RowExpandToggle
            expanded={expanded}
            onToggle={() => setExpanded((value) => !value)}
            label={t('capacity.expandTeam', { team: team.name })}
          />
          <Avatar name={team.name} size={20} />
          <span className="truncate text-ui-sm font-semibold text-foreground">{team.name}</span>
          <span className="shrink-0 text-ui-xs text-foreground-subtle">
            {t('capacity.memberCount', { count: team.members.length })}
          </span>
          {/* An archived Team keeps its hours — archiving a Team does not delete its linked
              Work Item/Sprint history (DB design §488), and a total that shrinks for an invisible
              reason is worse than one that explains itself. But the global Team picker hides
              archived teams, so without this badge the row is indistinguishable from a live team's
              and a reader would compare a disbanded team's numbers to current ones. */}
          {team.archived && <StatusBadge style={TEAM_STATUS_STYLE.archived} className="shrink-0" />}
        </div>
        <HoursCells values={team.totals} colStyles={colStyles} bold />
      </div>

      {expanded &&
        team.members.map((member) => (
          <div
            key={member.id ?? member.name}
            className="flex h-8 items-center border-b border-border-inner px-3"
          >
            <div className="w-6 shrink-0" />
            <div className={`truncate px-2 ${NESTED_ROW_INDENT}`} style={colStyles.member}>
              <span className="text-ui-sm text-muted-foreground">{member.name}</span>
            </div>
            <HoursCells values={member.hours} colStyles={colStyles} />
          </div>
        ))}
    </div>
  )
}

function HoursCells({
  values,
  colStyles,
  bold = false,
}: {
  values: TeamCapacityTeam['totals']
  colStyles: Record<string, React.CSSProperties>
  bold?: boolean
}) {
  const weight = bold ? 'font-semibold text-foreground' : 'text-muted-foreground'
  return (
    <>
      {HOUR_KEYS.map((key) => (
        // `px-2` is the shared header's per-column padding and the totals row's; without it the
        // body digits sat ~8px right of both. `NUMERIC_CELL_CLASS` is the app-wide contract for
        // a numeric cell (right + font-mono + tabular-nums) — the totals row already applies
        // font-mono to right-aligned columns, so anything else made one column three fonts.
        <div
          key={key}
          className={`shrink-0 truncate px-2 ${NUMERIC_CELL_CLASS}`}
          style={colStyles[key]}
        >
          <span className={`text-ui-sm ${weight}`}>{formatHours(hoursFor(values, key))}</span>
        </div>
      ))}
    </>
  )
}
