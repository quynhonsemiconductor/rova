/**
 * Reports > Velocity (Velocity SRS §6, Phase 7 SU-09 for the fourth segment).
 *
 * A stacked bar per completed timebox — Accepted During / Accepted After / Not Accepted / Split ·
 * Carryover — with a flat Trend line at the window average, and the Last 3 / Best 3 / Worst 3 summary
 * above it. Only During feeds the trend and the averages; everything else is context.
 *
 * Points belonging to an accepted item with no acceptance timestamp are in no segment at all.
 * They arrive as `unclassified` and are reported as a data-quality gap, because the SRS forbids
 * guessing whether such an item was accepted during or after the iteration.
 *
 * The Split/Carryover segment is the points a Split left behind as its `[Unfinished]` placeholder. It
 * is amber and its legend says `(excluded)` out loud: the placeholder is stored `accepted` with a real
 * acceptance date, so a reader who knows the Phase 6 rule would otherwise expect those points in
 * During, and a silently shorter bar is the one outcome SU-09 exists to prevent.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { Bar, CartesianGrid, ComposedChart, Line, Tooltip, XAxis, YAxis } from 'recharts'

import { BRAND } from '@/shared/config/brand'
import { STORAGE_KEYS } from '@/shared/config/storage-keys'
import { useVelocity, DEFAULT_VELOCITY_WINDOW, type VelocityWindow } from '@/features/reporting/api'
import { teamScopeLabel } from '@/features/reporting/scope'
import { MetricCard } from '@/shared/ui/metric-card'
import { MetricStrip } from '@/shared/ui/metric-strip'
import { CompactSelect } from '@/shared/ui/native-select'
import {
  CHART_AXIS,
  CHART_GRID,
  CHART_TOOLTIP,
  ChartFrame,
  ChartLegendItem,
  axisLabel,
} from '@/shared/ui/chart'

import { EmptyState } from '@/shared/ui/empty-state'

import { ReportSurface } from './report-surface'

const fmt = (value: number | null | undefined) => (value == null ? '--' : value.toFixed(2))

export function VelocityReport({
  projectId,
  teamId,
}: {
  projectId: string
  teamId: string | undefined
}) {
  const { t } = useTranslation(['reports', 'common'])
  // Persist the chosen window across reload (BA C7). Default is Last 10 (Rally parity).
  const [window, setWindow] = useState<VelocityWindow>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.VELOCITY_WINDOW)
    return saved === '5' || saved === '10'
      ? (Number(saved) as VelocityWindow)
      : DEFAULT_VELOCITY_WINDOW
  })
  function changeWindow(next: VelocityWindow) {
    setWindow(next)
    localStorage.setItem(STORAGE_KEYS.VELOCITY_WINDOW, String(next))
  }
  // `isError` was never read here, so a 500 or a dropped connection left `bars` empty and the chart
  // rendered §6's own sentence — "No completed iteration with scheduled work exists in this project and
  // team scope" — as a measured statement about delivery history. Team Capacity already fixed exactly
  // this; the comment on its own error branch says so.
  const { data, isLoading, isError } = useVelocity({ projectId, teamId, window })

  const bars = data?.bars ?? []
  const averages = data?.averages
  /**
   * How many `[Unfinished]` placeholders the window excludes, from the ids the bars carry.
   *
   * `splitStoryIds.length` rather than a second server field: one list means the count and the
   * summed points can never disagree. A Story belongs to exactly one iteration, so no id is reached
   * twice across bars and this needs no de-duplication of its own.
   */
  const carriedOverStories = bars.reduce((sum, bar) => sum + bar.splitStoryIds.length, 0)
  // A flat line at the window average: the SRS's Trend is one value repeated across the bars,
  // not a per-bar figure.
  const chartData = bars.map((bar) => ({ ...bar, trend: averages?.trend }))

  return (
    <ReportSurface
      title={t('velocity.title')}
      caption={t('velocity.teamContext', {
        team: teamScopeLabel(data?.context.teamName, t('common:allTeams')),
      })}
      controls={
        <label className="flex items-center gap-2 text-ui-xs font-semibold text-foreground-subtle">
          {t('velocity.window')}
          <CompactSelect
            value={String(window)}
            onChange={(event) => changeWindow(Number(event.target.value) as VelocityWindow)}
            aria-label={t('velocity.window')}
          >
            <option value="5">{t('velocity.windowLast', { count: 5 })}</option>
            <option value="10">{t('velocity.windowLast', { count: 10 })}</option>
          </CompactSelect>
        </label>
      }
      // The three averages were a centred block above the chart; every other summary in the app
      // is a left-aligned MetricStrip under the header. Same numbers, same place as Team
      // Capacity's four indicators.
      strip={
        averages && averages.sampleSize > 0 ? (
          <MetricStrip
            actions={
              <span className="text-ui-xs font-semibold text-muted-foreground">
                {t('velocity.averagesOver', { count: window })}
                {/* The SRS requires the real sample size be exposed below three values, rather
                    than two of them being averaged under a "Last 3" heading. */}
                {averages.sampleSize < 3 &&
                  ` · ${t('velocity.sampleSize', { count: averages.sampleSize })}`}
              </span>
            }
          >
            <MetricCard
              label={t('velocity.last3')}
              value={fmt(averages.last3)}
              caption={t('units.points')}
              valueColor={BRAND.reportDuring}
              minWidth={90}
            />
            <MetricCard
              label={t('velocity.best3')}
              value={fmt(averages.best3)}
              caption={t('units.points')}
              valueColor={BRAND.reportDuring}
              minWidth={90}
            />
            <MetricCard
              label={t('velocity.worst3')}
              value={fmt(averages.worst3)}
              caption={t('units.points')}
              valueColor={BRAND.reportDuring}
              minWidth={90}
            />
          </MetricStrip>
        ) : undefined
      }
      padBody
      /**
       * A failed request is not "no completed iterations".
       *
       * On the shell rather than inside `ChartFrame`, so the averages strip goes absent with the chart
       * instead of a fabricated set of numbers sitting above an error.
       */
      error={
        isError ? (
          <EmptyState title={t('velocity.error.title')} description={t('velocity.error.body')} />
        ) : undefined
      }
      loading={isLoading && !data}
    >
      <ChartFrame
        bare
        dataTable={{
          caption: t('velocity.tableCaption'),
          noDataLabel: t('common:noData'),
          columns: [
            t('velocity.tableIteration'),
            t('velocity.series.during'),
            t('velocity.series.after'),
            t('velocity.series.notAccepted'),
            // The amber segment is not colour-only: a screen reader gets the same fourth number a
            // sighted reader sees in the stack (plan 9.4).
            t('velocity.series.splitCarryover'),
          ],
          // The Trend is deliberately absent: it is one repeated value, already stated in the
          // legend, and a column of the same number on every row is noise to read aloud.
          rows: bars.map((bar) => [
            bar.name,
            bar.acceptedDuring,
            bar.acceptedAfter,
            bar.notAccepted,
            bar.splitCarryover,
          ]),
        }}
        isEmpty={bars.length === 0}
        emptyTitle={t('velocity.empty.title')}
        emptyDescription={t('velocity.empty.description')}
        legend={
          <>
            <ChartLegendItem color={BRAND.reportDuring} label={t('velocity.series.during')} />
            <ChartLegendItem color={BRAND.reportAfter} label={t('velocity.series.after')} />
            <ChartLegendItem
              color={BRAND.reportNotAccepted}
              label={t('velocity.series.notAccepted')}
            />
            {/* AC5 — the label says `(excluded)` in words, because the colour alone cannot say why
                these points are outside the trend. Rendered unconditionally, unlike the burndown's
                marker legend: this is a SEGMENT of a stack whose scale every bar shares, so a legend
                that appeared only in windows containing a Split would change the chart's key between
                two renders of the same report. */}
            <ChartLegendItem color={BRAND.warning} label={t('velocity.series.splitCarryover')} />
            <ChartLegendItem
              color={BRAND.reportTrend}
              shape="line"
              label={t('velocity.series.trend', { value: fmt(averages?.trend) })}
            />
          </>
        }
        footer={
          <>
            {data && data.unclassifiedItems > 0 ? (
              <p className="mt-2 flex items-center justify-center gap-1.5 text-ui-xs text-destructive">
                <AlertTriangle size={12} />
                {t('velocity.unclassified', { count: data.unclassifiedItems })}
              </p>
            ) : null}
            {/* Amber and plain text, with NO icon and no `role="alert"`: a Split is a recorded fact,
                not a data-quality fault, and the destructive line above it is the one thing on this
                chart a reader must act on. Present only when a Split actually touched the window. */}
            {carriedOverStories > 0 ? (
              <p className="mt-2 text-center text-ui-xs text-warning">
                {t('velocity.splitCarryoverNote', { count: carriedOverStories })}
              </p>
            ) : null}
          </>
        }
      >
        <ComposedChart data={chartData} margin={{ top: 8, right: 18, left: 8, bottom: 14 }}>
          <CartesianGrid {...CHART_GRID} vertical={false} />
          <XAxis dataKey="name" {...CHART_AXIS} />
          <YAxis {...CHART_AXIS} label={axisLabel(t('velocity.axis.points'), 'left')} />
          <Tooltip contentStyle={CHART_TOOLTIP} />
          <Bar
            dataKey="acceptedDuring"
            stackId="velocity"
            name={t('velocity.series.during')}
            fill={BRAND.reportDuring}
            barSize={52}
          />
          <Bar
            dataKey="acceptedAfter"
            stackId="velocity"
            name={t('velocity.series.after')}
            fill={BRAND.reportAfter}
            barSize={52}
          />
          {/**
           * The excluded segment sits BELOW `notAccepted` in the stack, which is deliberate and is
           * about the rounded cap rather than about meaning: `radius` lives on whichever segment is
           * drawn topmost, and a zero-height `splitCarryover` rect — which is every bar in a window
           * no Split touched — would leave the stack square-topped. Placing it here keeps
           * `notAccepted` as the cap for every bar, and it is the honest neighbour anyway: both are
           * points this iteration did not deliver.
           */}
          <Bar
            dataKey="splitCarryover"
            stackId="velocity"
            name={t('velocity.series.splitCarryover')}
            fill={BRAND.warning}
            barSize={52}
          />
          <Bar
            dataKey="notAccepted"
            stackId="velocity"
            name={t('velocity.series.notAccepted')}
            fill={BRAND.reportNotAccepted}
            barSize={52}
            radius={[2, 2, 0, 0]}
          />
          <Line
            type="monotone"
            dataKey="trend"
            name={t('velocity.series.trend', { value: fmt(averages?.trend) })}
            stroke={BRAND.reportTrend}
            strokeWidth={2}
            dot={false}
          />
        </ComposedChart>
      </ChartFrame>
    </ReportSurface>
  )
}
