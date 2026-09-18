/**
 * Reports > Iteration Burndown (IB §7).
 *
 * Two measures on two axes: Task To Do in HOURS on the left (teal bars), cumulative Accepted
 * POINTS on the right (green bars), and the frozen Ideal line in hours on the left. The three
 * come from the server exactly as plotted — this component adds no arithmetic, because the
 * history is immutable and the Ideal line is a stored baseline.
 *
 * A day with no snapshot arrives as `null` and recharts leaves a gap. That is deliberate: a
 * zero would read as "no work remained".
 */
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { Bar, CartesianGrid, ComposedChart, Line, Tooltip, XAxis, YAxis } from 'recharts'

import { BRAND } from '@/shared/config/brand'
import { useIterationOptions } from '@/features/iterations/api'
import { listResource } from '@/shared/lib/query/resource'
import { useIterationBurndown } from '@/features/reporting/api'
import { iterationsInScope, reportScopeLabel } from '@/features/reporting/scope'
import { IterationPicker } from '@/shared/ui/timebox-picker'
import {
  CHART_AXIS,
  CHART_GRID,
  CHART_TOOLTIP,
  ChartFrame,
  ChartLegendItem,
  axisLabel,
} from '@/shared/ui/chart'

import { ReportSurface } from './report-surface'
import { splitMarkerLines } from './split-marker-lines'
import { SplitMarkerContext, SplitMarkerLegend } from './split-markers'
import { useSelectedIteration } from '../model/use-selected-iteration'
import { EmptyState } from '@/shared/ui/empty-state'

export function IterationBurndownReport({
  projectId,
  teamId,
}: {
  projectId: string
  teamId: string | undefined
}) {
  const { t } = useTranslation(['reports', 'common', 'split-story'])
  /**
   * The PICKER's feed, and it is a resource for the same reason the report's own query is.
   *
   * This was `const { data: allIterations = [] } = useIterations`, i.e. the timebox RECORD. A failing
   * `/v1/iterations` therefore produced an empty picker, `selectedId === null`, and the body
   * rendered `burndown.empty.noIteration` — "Select an iteration to see its burndown" — an
   * AFFORDANCE INSTRUCTION standing in for a network fault, with no iteration available to obey
   * it with. Worse than the defect this file's docblock already claims to have closed, because
   * that one at least named the report; this one blames the reader. The injected-failure test
   * below keeps the report endpoint healthy and fails the PICKER endpoint, which is exactly the
   * case the original test could not see.
   */
  // The REFERENCE feed: every state, so a closed sprint's burndown is still reachable, and none of
  // the timebox record — `GET /iterations` is `timebox:view` and would 403 a project Editor here.
  const iterationsQuery = useIterationOptions(projectId)
  const iterationFeed = listResource(iterationsQuery)
  // The picker offers what the report can serve — the team's own timeboxes plus the shared ones.
  const iterations = iterationsInScope(iterationFeed.rows, teamId)
  const { selectedId, select } = useSelectedIteration(projectId, iterations)
  /**
   * `isError` was never read here, so a failed request left `data` undefined and this report fell
   * through to `burndown.empty.noHistory` — "no daily history has been recorded" — which is a
   * MEASURED CLAIM about the sprint, not a description of a network fault. §5 makes only missing
   * SNAPSHOTS unavailable; a 500 is not a missing snapshot.
   *
   * Velocity and Team Capacity already fixed exactly this, and this is the third instance of the
   * same shape: `data` is undefined both while a request is in flight and after it fails, so any
   * report that branches on `data` alone will state something false about delivery on failure.
   */
  const { data, isLoading, isError } = useIterationBurndown({
    projectId,
    teamId,
    // `null` (nothing selected) means the same thing to this hook as `undefined`, and it takes
    // the latter — translate at the boundary rather than widening the hook's contract.
    iterationId: selectedId ?? undefined,
  })

  const points = data?.points ?? []
  /**
   * The empty states IB §7 requires be distinguishable, in the order they can occur.
   *
   * A missing Ideal BASELINE is deliberately not one of them. IB §3 scopes the baseline to the
   * Ideal line, so blanking the chart for it threw away Task-To-Do and Accepted-Points bars that
   * were genuinely measured — the reader saw "no burndown to show" for an iteration with a week
   * of real history. It is a note under the chart now (`noBaselineNote`), not an empty state.
   */
  /**
   * MEASURED HISTORY OUTRANKS "no scheduled work".
   *
   * `hasScheduledWork` is a LIVE count, and the series is FROZEN — so an iteration whose items were
   * reassigned after the sprint (the normal roll-over) reported `historyState: 'complete'` with a full
   * recorded series, and this branch replaced it with "no scheduled work". That is the same mistake as
   * the missing-baseline one above: a live fact discarding days that were genuinely measured. §5 makes
   * only MISSING SNAPSHOTS unavailable.
   *
   * So the live emptiness is now the LAST resort, consulted only once the snapshots have said they
   * have nothing either.
   */
  const emptyDescription =
    selectedId === null
      ? t('burndown.empty.noIteration')
      : data?.historyState === 'no-window'
        ? t('burndown.empty.noWindow')
        : data?.historyState === 'missing'
          ? data?.hasScheduledWork === false
            ? t('burndown.empty.noScheduledWork')
            : t('burndown.empty.noHistory')
          : undefined

  // Null baseline = no Ideal trajectory, reported beside the measured series rather than instead
  // of them. `totalTaskEstimateAtStart` is the wire's answer now that `historyState` is snapshot-only.
  const noBaseline = data !== undefined && data.totalTaskEstimateAtStart === null

  /**
   * Everything qualifying the chart, in one line under it.
   *
   * `partialCaptureDates` is the third kind of caveat and the least obvious: those days have REAL
   * numbers that were frozen before the day closed, because the hourly job stopped early. IB-BR-01
   * calls the source an end-of-day snapshot, so a reader comparing two days deserves to know which one
   * is not. The dates are named — "which day do I distrust" is the only actionable form.
   */
  const partialCaptures = data?.partialCaptureDates ?? []
  const notes = [
    data?.historyState === 'partial' ? t('burndown.partialHistory') : null,
    noBaseline ? t('burndown.noBaselineNote') : null,
    partialCaptures.length > 0
      ? t('burndown.partialCapture', {
          count: partialCaptures.length,
          dates: partialCaptures.join(', '),
        })
      : null,
  ].filter((line): line is string => line !== null)

  const behind = data?.status === 'behind-plan'

  /**
   * The Split annotations (SU-08 8.3). Empty arrays for every timebox no Split touched, which is every
   * timebox before Phase 7 — so nothing below needs a "has splits" branch, only a length check where a
   * legend entry would otherwise claim a series that is not drawn.
   */
  const splitOut = data?.splitOut ?? []
  const carryIn = data?.carryIn ?? []
  const splitMarkers = [...splitOut, ...carryIn]

  return (
    <ReportSurface
      title={t('burndown.title')}
      // Project/Team context was a centred 18px line above the chart — larger than the report's
      // own title and in a place no other page puts context. It is the same scope caption
      // Velocity and Team Capacity now carry beside their titles, and it goes through
      // `reportScopeLabel` so All Teams is NAMED rather than rendering as a trailing dash.
      caption={
        data
          ? reportScopeLabel(data.context.projectName, data.context.teamName, t('common:allTeams'))
          : undefined
      }
      controls={
        <>
          <span className="text-ui-xs font-semibold text-foreground-subtle">{t('iteration')}</span>
          <IterationPicker iterations={iterations} selectedId={selectedId} onSelect={select} />
          {/**
           * `data !== undefined` FIRST, and that is the whole point of the guard.
           *
           * This read `data?.status !== 'unknown'`, and on a failed or in-flight request `data` is
           * undefined — so the comparison is `undefined !== 'unknown'`, which is TRUE. The pill
           * rendered, `behind` was false, and the report announced "On track" for an iteration it had
           * no data about. A verdict is the worst thing to synthesise: it is a conclusion, not a
           * number, so there is nothing for a reader to notice as missing.
           *
           * Same family as the `?? 0` rule — an absent value must not be rendered as a measured one.
           */}
          {data !== undefined && data.status !== 'unknown' && (
            <span
              className={`flex items-center gap-1 text-ui-xs font-semibold ${
                behind ? 'text-destructive' : 'text-success'
              }`}
            >
              {behind ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />}
              {behind ? t('burndown.behindPlan') : t('burndown.onTrack')}
            </span>
          )}
        </>
      }
      padBody
      /**
       * On the SHELL, not inside `ChartFrame` — so the status pill in `controls` and the notes go
       * absent with the chart rather than a "Behind plan"/"On track" verdict sitting above an error.
       */
      error={
        iterationFeed.isError ? (
          <EmptyState
            title={t('timeboxFeedError.title')}
            description={t('timeboxFeedError.body')}
          />
        ) : isError ? (
          <EmptyState title={t('burndown.error.title')} description={t('burndown.error.body')} />
        ) : undefined
      }
      loading={(isLoading && !data) || iterationFeed.isLoading}
    >
      <ChartFrame
        bare
        dataTable={{
          caption: t('burndown.tableCaption'),
          noDataLabel: t('common:noData'),
          columns: [
            t('burndown.axis.date'),
            t('burndown.series.todo'),
            t('burndown.series.ideal'),
            t('burndown.series.accepted'),
          ],
          // The SAME array recharts plots, so the table cannot drift from the chart — and the
          // nulls travel through untouched, which is how a gap stays a gap here too.
          rows: points.map((point) => [
            point.date,
            point.remainingToDo,
            point.ideal,
            point.acceptedPoints,
          ]),
        }}
        isEmpty={points.length === 0 || emptyDescription !== undefined}
        emptyTitle={t('burndown.empty.title')}
        emptyDescription={emptyDescription ?? t('burndown.empty.noHistory')}
        legend={
          <>
            <ChartLegendItem color={BRAND.reportTodo} label={t('burndown.series.todo')} />
            <ChartLegendItem
              color={BRAND.reportIdeal}
              label={t('burndown.series.ideal')}
              shape="line"
            />
            <ChartLegendItem color={BRAND.reportAccepted} label={t('burndown.series.accepted')} />
            {/* Only the directions this timebox actually has: a legend entry for an annotation that
                is not drawn is a claim about the chart that the chart does not make. */}
            <SplitMarkerLegend
              splitOutLabel={t('split-story:markers.legendSplitOut')}
              carryInLabel={t('split-story:markers.legendCarryIn')}
              hasSplitOut={splitOut.length > 0}
              hasCarryIn={carryIn.length > 0}
            />
          </>
        }
        /**
         * The compact SPLIT OUT / CARRY IN context (SRS §10.2/§10.3), in `underAxis` — which
         * `ChartFrame` renders OUTSIDE the `aria-hidden` plot, so this text is read by assistive tech
         * as well as seen. That is what stops the amber rules on the chart from being colour-only.
         */
        underAxis={
          <SplitMarkerContext
            markers={splitMarkers}
            lineFor={(marker, values) =>
              t(
                marker.kind === 'split-out'
                  ? 'split-story:markers.splitOutContext'
                  : 'split-story:markers.carryInContext',
                values,
              )
            }
          />
        }
        footer={
          notes.length > 0 ? (
            <p className="mt-2 text-center text-ui-xs text-foreground-subtle">{notes.join(' ')}</p>
          ) : null
        }
      >
        <ComposedChart data={points} margin={{ top: 12, right: 16, left: 4, bottom: 12 }}>
          <CartesianGrid {...CHART_GRID} />
          <XAxis
            dataKey="date"
            {...CHART_AXIS}
            label={axisLabel(t('burndown.axis.date'), 'bottom')}
          />
          <YAxis
            yAxisId="hours"
            {...CHART_AXIS}
            label={axisLabel(t('burndown.axis.hours'), 'left')}
          />
          <YAxis
            yAxisId="points"
            orientation="right"
            {...CHART_AXIS}
            label={axisLabel(t('burndown.axis.points'), 'right')}
          />
          <Tooltip contentStyle={CHART_TOOLTIP} />
          <Bar
            yAxisId="hours"
            dataKey="remainingToDo"
            name={t('burndown.series.todo')}
            fill={BRAND.reportTodo}
            barSize={34}
          />
          <Line
            yAxisId="hours"
            type="linear"
            dataKey="ideal"
            name={t('burndown.series.ideal')}
            stroke={BRAND.reportIdeal}
            strokeWidth={2.5}
            dot={{ r: 3, fill: BRAND.reportIdeal }}
            // `false` keeps the line broken across a day with no baseline rather than bridging it.
            connectNulls={false}
          />
          <Bar
            yAxisId="points"
            dataKey="acceptedPoints"
            name={t('burndown.series.accepted')}
            fill={BRAND.reportAccepted}
            barSize={18}
          />
          {/*
            LAST among the chart's children, so the rules paint over the bars rather than under them —
            and spread as two arrays rather than one, because the label differs by direction and a
            single pass would have to re-decide it per element anyway.

            The x-positions are the SERVER's clamped marker dates: a Split confirmed after the source
            sprint closed still lands on the last day of that sprint (SRS §10.3), which is a decision
            made once at write time with the workspace calendar in hand.
          */}
          {splitMarkerLines(splitOut, t('split-story:markers.splitOut'))}
          {splitMarkerLines(carryIn, t('split-story:markers.carryIn'))}
        </ComposedChart>
      </ChartFrame>
    </ReportSurface>
  )
}
