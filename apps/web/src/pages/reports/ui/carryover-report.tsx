/**
 * Reports > Carryover (Phase 7 CO-10, plan Task 10.3).
 *
 * Four KPIs (Carry In, Carry Out, Transferred To Do, Carryover Rate), a per-Iteration trend and the
 * event rows in the SRS column order. Every number comes from the server; Direction narrows the ROWS
 * only and the KPIs and trend never move with it (CO-BR-41). Only Carryover events reach this report —
 * Splits and Manual Moves are excluded server-side (CO-BR-35).
 */
import { useTranslation } from 'react-i18next'
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts'

import { BRAND } from '@/shared/config/brand'
import { useIterationOptions } from '@/features/iterations/api'
import { listResource } from '@/shared/lib/query/resource'
import {
  rowsForDirection,
  useCarryoverReport,
  type CarryoverDirection,
} from '@/features/reporting/api'
import { iterationsInScope, reportScopeLabel } from '@/features/reporting/scope'
import { EMPTY_VALUE, NUMERIC_CELL_CLASS, formatDateIso } from '@/shared/lib/utils'
import {
  CHART_AXIS,
  CHART_GRID,
  CHART_TOOLTIP,
  ChartFrame,
  ChartLegendItem,
} from '@/shared/ui/chart'
import { EmptyState } from '@/shared/ui/empty-state'
import { MetricCard } from '@/shared/ui/metric-card'
import { MetricStrip } from '@/shared/ui/metric-strip'
import { CompactSelect } from '@/shared/ui/native-select'
import { IterationPicker } from '@/shared/ui/timebox-picker'

import { ReportExportButton } from './report-export-button'
import { ReportSurface } from './report-surface'
import { useSelectedIteration } from '../model/use-selected-iteration'

const CARRYOVER_DIRECTIONS = ['all', 'in', 'out'] as const satisfies readonly CarryoverDirection[]

const COLUMNS = [
  'direction',
  'workItem',
  'name',
  'from',
  'to',
  'movedOn',
  'startDate',
  'targetEnd',
  'estimate',
  'todo',
  'actualBefore',
  'actualAfter',
] as const
const NUMERIC = new Set<string>(['estimate', 'todo', 'actualBefore', 'actualAfter'])

const hours = (value: number | undefined) => (value === undefined ? EMPTY_VALUE : `${value}h`)

export function CarryoverReport({
  projectId,
  teamId,
  direction,
  onDirectionChange,
}: {
  projectId: string
  teamId: string | undefined
  direction: CarryoverDirection
  onDirectionChange: (next: CarryoverDirection) => void
}) {
  const { t } = useTranslation(['carryover', 'reports', 'common'])
  const iterationsQuery = useIterationOptions(projectId)
  const iterationFeed = listResource(iterationsQuery)
  const iterations = iterationsInScope(iterationFeed.rows, teamId)
  const { selectedId, select } = useSelectedIteration(projectId, iterations)
  const { data, isLoading, isError } = useCarryoverReport({
    projectId,
    teamId,
    iterationId: selectedId ?? undefined,
  })

  // KPIs and trend come from ONE response per Iteration; Direction only narrows the rows below
  // (CO-BR-41), so switching it can never move a KPI.
  const kpis = data?.kpis
  const rows = rowsForDirection(data?.rows ?? [], direction)
  const trend = data?.trend ?? []

  return (
    <ReportSurface
      title={t('report.title')}
      caption={
        data
          ? reportScopeLabel(data.context.projectName, data.context.teamName, t('common:allTeams'))
          : undefined
      }
      controls={
        <>
          <span className="text-ui-xs font-semibold text-foreground-subtle">
            {t('reports:iteration')}
          </span>
          <IterationPicker iterations={iterations} selectedId={selectedId} onSelect={select} />
          <label className="flex items-center gap-2 text-ui-xs font-semibold text-foreground-subtle">
            {t('report.direction')}
            <CompactSelect
              value={direction}
              aria-label={t('report.direction')}
              onChange={(event) => onDirectionChange(event.target.value as CarryoverDirection)}
            >
              {CARRYOVER_DIRECTIONS.map((value) => (
                <option key={value} value={value}>
                  {t(`report.directions.${value}`)}
                </option>
              ))}
            </CompactSelect>
          </label>
          <ReportExportButton
            projectId={projectId}
            request={
              selectedId
                ? { report: 'carryover', projectId, teamId, iterationId: selectedId, direction }
                : null
            }
          />
        </>
      }
      strip={
        <MetricStrip>
          <MetricCard
            label={t('report.kpis.carryIn')}
            value={kpis ? String(kpis.carryIn) : EMPTY_VALUE}
            minWidth={120}
          />
          <MetricCard
            label={t('report.kpis.carryOut')}
            value={kpis ? String(kpis.carryOut) : EMPTY_VALUE}
            minWidth={120}
          />
          <MetricCard
            label={t('report.kpis.transferredTodo')}
            value={hours(kpis?.transferredTodoHours)}
            minWidth={120}
          />
          <MetricCard
            label={t('report.kpis.rate')}
            value={kpis ? `${kpis.carryoverRate}%` : EMPTY_VALUE}
            minWidth={120}
          />
        </MetricStrip>
      }
      padBody
      error={
        iterationFeed.isError ? (
          <EmptyState
            title={t('reports:timeboxFeedError.title')}
            description={t('reports:timeboxFeedError.body')}
          />
        ) : isError ? (
          <EmptyState title={t('report.error.title')} description={t('report.error.body')} />
        ) : undefined
      }
      loading={(isLoading && !data) || iterationFeed.isLoading}
    >
      {selectedId === null ? (
        <EmptyState title={t('report.noIteration')} />
      ) : (
        <div className="flex flex-col gap-4">
          <ChartFrame
            bare
            dataTable={{
              caption: t('report.trend'),
              noDataLabel: t('common:noData'),
              columns: [
                t('reports:iteration'),
                t('report.kpis.carryIn'),
                t('report.kpis.carryOut'),
              ],
              rows: trend.map((point) => [point.name, point.carryIn, point.carryOut]),
            }}
            isEmpty={trend.length === 0}
            emptyTitle={t('report.empty')}
            legend={
              <>
                <ChartLegendItem color={BRAND.reportTodo} label={t('report.kpis.carryIn')} />
                <ChartLegendItem color={BRAND.reportAfter} label={t('report.kpis.carryOut')} />
              </>
            }
          >
            <BarChart data={trend} margin={{ top: 8, right: 16, left: 4, bottom: 8 }}>
              <CartesianGrid {...CHART_GRID} vertical={false} />
              <XAxis dataKey="name" {...CHART_AXIS} />
              <YAxis allowDecimals={false} {...CHART_AXIS} />
              <Tooltip contentStyle={CHART_TOOLTIP} />
              <Bar dataKey="carryIn" name={t('report.kpis.carryIn')} fill={BRAND.reportTodo} />
              <Bar dataKey="carryOut" name={t('report.kpis.carryOut')} fill={BRAND.reportAfter} />
            </BarChart>
          </ChartFrame>

          {rows.length === 0 ? (
            <EmptyState title={t('report.empty')} />
          ) : (
            <div className="overflow-x-auto rounded border border-border-strong">
              <table className="w-full text-ui-sm">
                <thead className="bg-surface-hover text-ui-xs font-semibold text-muted-foreground uppercase">
                  <tr>
                    {COLUMNS.map((col) => (
                      <th
                        key={col}
                        scope="col"
                        className={`px-2 py-2 whitespace-nowrap ${NUMERIC.has(col) ? 'text-right' : 'text-left'}`}
                      >
                        {t(`report.columns.${col}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.transitionId} className="border-t border-border-inner">
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        {t(`report.directions.${row.direction}`)}
                      </td>
                      <td className="px-2 py-1.5 font-mono whitespace-nowrap">{row.storyKey}</td>
                      <td className="max-w-64 truncate px-2 py-1.5">{row.storyTitle}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        {row.fromIterationName ?? EMPTY_VALUE}
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        {row.toIterationName ?? EMPTY_VALUE}
                      </td>
                      <td className="px-2 py-1.5 font-mono whitespace-nowrap">
                        {formatDateIso(row.movedAt, EMPTY_VALUE)}
                      </td>
                      <td className="px-2 py-1.5 font-mono whitespace-nowrap">
                        {formatDateIso(row.startDate, EMPTY_VALUE)}
                      </td>
                      <td className="px-2 py-1.5 font-mono whitespace-nowrap">
                        {formatDateIso(row.targetEndDate, EMPTY_VALUE)}
                      </td>
                      <td className={`px-2 py-1.5 ${NUMERIC_CELL_CLASS}`}>
                        {hours(row.estimateHours)}
                      </td>
                      <td className={`px-2 py-1.5 ${NUMERIC_CELL_CLASS}`}>
                        {hours(row.todoHours)}
                      </td>
                      <td className={`px-2 py-1.5 ${NUMERIC_CELL_CLASS}`}>
                        {hours(row.actualBefore)}
                      </td>
                      <td className={`px-2 py-1.5 ${NUMERIC_CELL_CLASS}`}>
                        {hours(row.actualAfter)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </ReportSurface>
  )
}
