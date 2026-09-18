/**
 * The reader-facing half of the Split annotation on the Iteration Burndown (SU-08 8.3).
 *
 * `SPLIT OUT` / `CARRY IN` has two parts and they mount in two different slots:
 *
 *  • {@link SplitMarkerContext} — the COMPACT AMBER CONTEXT the SRS actually specifies. §10.2 asks for
 *    the `[Unfinished]` ID, its points, the moved To Do and the retained Actual; §10.3 for the
 *    `[Continued]` ID, points, incoming To Do and a `0h` opening Actual. A chart annotation cannot
 *    carry four values, so the rule marks WHEN and this strip says WHAT.
 *  • {@link SplitMarkerLegend} — one legend entry per direction that is actually present.
 *
 * The rules themselves are `splitMarkerLines` in `split-marker-lines.tsx`, which is a separate module
 * because it exports a plain function rather than a component.
 *
 * **WHY THE STRIP AND NOT ROWS IN `ChartFrame`'s HIDDEN TABLE.** Plan 8.3 says to add the markers to
 * the hidden `dataTable` "so the annotation is not colour-only", and that requirement is met more
 * strongly here: this strip is REAL, VISIBLE TEXT outside the `aria-hidden` plot (it goes in
 * `ChartFrame`'s `underAxis` slot), so a screen reader and a sighted reader get the same sentence. The
 * hidden table's four columns are `Date · To Do · Ideal · Accepted`, one row per plotted day of the
 * SERIES — and a marker's moved-To Do dropped into the `To Do` column would read as a measured series
 * value for that day, which is the fabrication IB §5 forbids. A departure from the plan's wording in
 * service of its reason; recorded rather than silently taken.
 *
 * Every number goes through `formatPoints` (the SU-02 footer / SU-03 row rule): these are the same
 * quantities the chart's own axes show, and one surface printing `1234.5` beside another printing
 * `1,234.5` is the defect that rule exists to prevent. `points: null` is an UNPOINTED Story and prints
 * as `--`, never `0`.
 */
import type { SplitMarker } from '@/features/reporting/api'
import { formatPoints } from '@/shared/lib/utils'
import { ChartLegendItem } from '@/shared/ui/chart'

import { MARKER_COLOR } from './split-marker-lines'

/** The formatted figures a context line interpolates. */
export type MarkerValues = {
  date: string
  key: string
  points: string
  todo: string
  actual: string
}

/**
 * Every number formatted once, here, so the two context sentences cannot format the same quantity
 * differently. `points` falls back to `--` for an unpointed Story; the two hour figures are real
 * measurements and a `0` among them is meaningful (`0h` opening Actual is the whole of AC8).
 */
function markerValues(marker: SplitMarker): MarkerValues {
  return {
    date: marker.date,
    key: marker.storyKey,
    points: formatPoints(marker.points),
    todo: formatPoints(marker.todoHours),
    actual: formatPoints(marker.actualHours),
  }
}

/**
 * The compact context strip, one line per marker.
 *
 * A list, so the count is announced and each event is one item. Nothing here is a warning or a
 * validation message — a Split is a recorded fact, not a problem — so there is no `role="alert"` and no
 * icon; the amber is the SRS's own colour for this annotation and the text stands on its own without it.
 */
export function SplitMarkerContext({
  markers,
  lineFor,
}: {
  markers: readonly SplitMarker[]
  /** `t('markers.splitOutContext' | 'markers.carryInContext', …)` — the caller owns the wording. */
  lineFor: (marker: SplitMarker, values: MarkerValues) => string
}) {
  if (markers.length === 0) return null

  return (
    <ul className="mt-2 space-y-0.5 text-center text-ui-xs text-warning">
      {markers.map((marker) => (
        <li key={`${marker.kind}-${marker.splitId}`}>{lineFor(marker, markerValues(marker))}</li>
      ))}
    </ul>
  )
}

/** Legend entries, only for the directions this timebox actually has. */
export function SplitMarkerLegend({
  splitOutLabel,
  carryInLabel,
  hasSplitOut,
  hasCarryIn,
}: {
  splitOutLabel: string
  carryInLabel: string
  hasSplitOut: boolean
  hasCarryIn: boolean
}) {
  return (
    <>
      {hasSplitOut && <ChartLegendItem color={MARKER_COLOR} label={splitOutLabel} shape="line" />}
      {hasCarryIn && <ChartLegendItem color={MARKER_COLOR} label={carryInLabel} shape="line" />}
    </>
  )
}
