/**
 * The chart half of the Split annotation — the amber token and the reference lines (SU-08 8.3).
 *
 * ITS OWN FILE, and not because the code is long. `react-refresh/only-export-components` refuses a
 * module that exports both a component and a plain function, and `splitMarkerLines` has to be a plain
 * function: it returns an ARRAY of `ReferenceLine` elements so they can be spread straight into
 * `<ComposedChart>`. A Reference component belongs inside the chart, and wrapping the set in a
 * component of our own would put one more thing between it and the axis it reads.
 *
 * The strip that carries the four values SRS §10.2/§10.3 enumerate is in `split-markers.tsx`.
 */
import type { ReactElement } from 'react'
import { ReferenceLine, type ReferenceLineProps } from 'recharts'

import type { SplitMarker } from '@/features/reporting/api'
import { BRAND } from '@/shared/config/brand'
import { CHART_MARKER } from '@/shared/ui/chart'

/** Amber, per SRS §10.2/§10.3 — the warning token, never a raw hex (`no-raw-hex` is 0). */
export const MARKER_COLOR = BRAND.warning

/**
 * One dashed vertical rule per marker, positioned on its own clamped date.
 *
 * THE DASH, THE WIDTH AND THE LABEL SIZE COME FROM `CHART_MARKER`, not from literals here.
 * `shared/ui/chart` owns chart styling for the reason its own docblock gives — four copies of
 * `tick={{ fontSize: 9, … }}` is how the tables drifted apart — and this is the app's FIRST
 * annotation, so the constant had to be added there rather than reused from there. Two of the three
 * values carry an argument that belongs with the other chart constants and not with this feature: the
 * label size matches `CHART_AXIS.tick` so a marker label is not a third text size on one chart, and
 * the dash pattern deliberately differs from `CHART_GRID`'s so a marker is not read as a gridline.
 *
 * `yAxisId="hours"` because the Burndown has TWO y-axes and a Reference component must name one; the
 * hours axis is the left-hand one the To Do bars use, which is the measure the marker explains.
 *
 * `ifOverflow="extendDomain"` is deliberately NOT set: a marker date is already clamped into the
 * iteration window server-side (`sourceMarkerDate` / `targetMarkerDate`), so a date off this axis means
 * the day is not a working day and is genuinely not plotted — extending the domain would add an x
 * position the series has no value for.
 *
 * `key` is the split id plus the kind: one Split produces a marker on BOTH charts, and a fused
 * All-Teams timebox can legitimately be a source and a target at once.
 *
 * The return type names `ReferenceLineProps` rather than a bare `ReactElement`, because React 19's
 * types make `element.props` `unknown` otherwise — which would leave the spec unable to assert the one
 * thing that matters here (which date, which axis, which colour) without a cast.
 */
export function splitMarkerLines(
  markers: readonly SplitMarker[],
  label: string,
): ReactElement<ReferenceLineProps>[] {
  return markers.map((marker) => (
    <ReferenceLine
      key={`${marker.kind}-${marker.splitId}`}
      yAxisId="hours"
      x={marker.date}
      stroke={MARKER_COLOR}
      strokeDasharray={CHART_MARKER.strokeDasharray}
      strokeWidth={CHART_MARKER.strokeWidth}
      label={{
        value: label,
        position: 'top',
        fill: MARKER_COLOR,
        fontSize: CHART_MARKER.labelFontSize,
      }}
    />
  ))
}
