/**
 * SPLIT OUT / CARRY IN annotations on the Iteration Burndown (SU-08 8.3, SRS §10.2/§10.3).
 *
 * Split across two techniques on purpose:
 *
 *  • `splitMarkerLines` is asserted on the ELEMENTS it returns, not on rendered SVG. It exists to be
 *    spread into a recharts chart, and recharts in jsdom has no layout — a `ReferenceLine` in a
 *    zero-width container paints nothing, so a DOM assertion here would be vacuous. The props ARE the
 *    contract: which date, which axis, which colour.
 *  • the context strip and the legend are asserted through the DOM with REAL i18n, because their whole
 *    job is the sentence a reader gets, and SRS §10.2/§10.3 enumerate the four values in it.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useTranslation } from 'react-i18next'
import type { ReactElement } from 'react'
import type { ReferenceLineProps } from 'recharts'

import '@/shared/i18n/i18n'
import { setFormatPrefs } from '@/shared/lib/format-prefs'
import type { SplitMarker } from '@/features/reporting/api'
import { ChartLegendBar, CHART_AXIS, CHART_GRID, CHART_MARKER } from '@/shared/ui/chart'
import { splitMarkerLines } from './split-marker-lines'
import { SplitMarkerContext, SplitMarkerLegend } from './split-markers'

const splitOut = (over: Partial<SplitMarker> = {}): SplitMarker => ({
  splitId: 'split-1',
  kind: 'split-out',
  date: '2026-06-27',
  storyId: 'wi-2',
  storyKey: 'US-9',
  points: 2,
  todoHours: 7,
  actualHours: 5,
  ...over,
})

const carryIn = (over: Partial<SplitMarker> = {}): SplitMarker => ({
  splitId: 'split-1',
  kind: 'carry-in',
  date: '2026-06-29',
  storyId: 'wi-1',
  storyKey: 'US-1',
  points: 3,
  todoHours: 7,
  actualHours: 0,
  ...over,
})

/** The `label.value` recharts renders, past a prop type that also admits a node and a function. */
function labelValue(line: ReactElement<ReferenceLineProps>): string {
  return (line.props.label as { value: string }).value
}

/** Same narrowing, for the label's own font size. */
function labelFontSize(line: ReactElement<ReferenceLineProps>): number {
  return (line.props.label as { fontSize: number }).fontSize
}

/** Renders the strip with the SAME wiring the report uses — the two keys, chosen by `kind`. */ function Strip({
  markers,
}: {
  markers: SplitMarker[]
}) {
  const { t } = useTranslation('split-story')
  return (
    <SplitMarkerContext
      markers={markers}
      lineFor={(marker, values) =>
        t(
          marker.kind === 'split-out' ? 'markers.splitOutContext' : 'markers.carryInContext',
          values,
        )
      }
    />
  )
}

describe('splitMarkerLines', () => {
  it('emits one reference line per marker, on its own clamped date and the HOURS axis', () => {
    const lines = splitMarkerLines(
      [splitOut(), splitOut({ splitId: 'split-2', date: '2026-06-20' })],
      'SPLIT OUT',
    )

    expect(lines).toHaveLength(2)
    expect(lines.map((line) => line.props.x)).toEqual(['2026-06-27', '2026-06-20'])
    // The Burndown has TWO y-axes; a Reference component must name one, and the hours axis is the
    // measure the marker explains. Naming the points axis would place the rule against a different scale.
    for (const line of lines) expect(line.props.yAxisId).toBe('hours')
  })

  it('labels the rules with the caller’s wording, so the two directions differ', () => {
    const [out] = splitMarkerLines([splitOut()], 'SPLIT OUT')
    const [into] = splitMarkerLines([carryIn()], 'CARRY IN')

    // recharts types `label` as a union that includes a render function and a React node, so reading
    // `.value` needs a narrowing the props type cannot give us. Asserted anyway: the LABEL is the only
    // thing that distinguishes the two directions on the chart.
    expect(labelValue(out)).toBe('SPLIT OUT')
    expect(labelValue(into)).toBe('CARRY IN')
  })

  it('keys each rule by kind AND split id, so one Split can annotate both charts', () => {
    const [out] = splitMarkerLines([splitOut()], 'SPLIT OUT')
    const [into] = splitMarkerLines([carryIn()], 'CARRY IN')

    // Same `splitId` on both sides — a key of the id alone would collide the moment a fused All-Teams
    // timebox is both a source and a target.
    expect(out.key).not.toBe(into.key)
  })

  it('draws the amber token, never a hex', () => {
    const [line] = splitMarkerLines([splitOut()], 'SPLIT OUT')
    expect(line.props.stroke).toBe('var(--warning)')
  })

  it('takes its dash, width and label size from CHART_MARKER, not from literals', () => {
    // DISCRIMINATING, not decorative: an inlined value would pass an equality check against itself.
    // These compare the rendered props to the SHARED constant, so re-inlining any of the three fails
    // here even if the number happens to match today.
    const [line] = splitMarkerLines([splitOut()], 'SPLIT OUT')

    expect(line.props.strokeDasharray).toBe(CHART_MARKER.strokeDasharray)
    expect(line.props.strokeWidth).toBe(CHART_MARKER.strokeWidth)
    expect(labelFontSize(line)).toBe(CHART_MARKER.labelFontSize)
  })

  it('sizes the marker label like an AXIS TICK, so a chart carries no third text size', () => {
    // The visible half of the review thread: chart text is 10 (ticks, axis labels) or 11 (tooltip),
    // and a marker label at 9 renders smaller than everything beside it — which reads as an accident.
    const [line] = splitMarkerLines([splitOut()], 'SPLIT OUT')

    expect(labelFontSize(line)).toBe(CHART_AXIS.tick.fontSize)
  })

  it('dashes DIFFERENTLY from the gridlines, so a marker is not read as one', () => {
    // The one-character difference from `CHART_GRID` is deliberate, and this is what says so in a form
    // that fails if someone "aligns" the two.
    expect(CHART_MARKER.strokeDasharray).not.toBe(CHART_GRID.strokeDasharray)
  })

  it('emits nothing when no Split touched the timebox', () => {
    expect(splitMarkerLines([], 'SPLIT OUT')).toEqual([])
  })
})

describe('SplitMarkerContext (SRS §10.2 / §10.3)', () => {
  beforeEach(() => {
    // `format-prefs` is a module singleton, so a locale set by another spec would leak in here.
    setFormatPrefs({ locale: 'en', timeZone: 'UTC' })
  })

  it('names the [Unfinished] ID, its points, the moved To Do and the retained Actual', () => {
    render(<Strip markers={[splitOut()]} />)

    expect(
      screen.getByText(
        '2026-06-27 SPLIT OUT US-9 · 2 pts · 7h To Do moved out · 5h Actual retained',
      ),
    ).toBeInTheDocument()
  })

  it('names the [Continued] ID, its points, the incoming To Do and a 0h opening Actual (AC8)', () => {
    render(<Strip markers={[carryIn()]} />)

    // `0h`, and it must be printed rather than dropped: "the carried-in Actual starts at 0h" is the
    // claim, and an absent figure would read as "not measured".
    expect(
      screen.getByText(
        '2026-06-29 CARRY IN US-1 · 3 pts · 7h To Do carried in · 0h opening Actual',
      ),
    ).toBeInTheDocument()
  })

  it('renders both directions when one timebox is a source AND a target', () => {
    render(<Strip markers={[splitOut(), carryIn()]} />)

    expect(screen.getByText(/SPLIT OUT US-9/)).toBeInTheDocument()
    expect(screen.getByText(/CARRY IN US-1/)).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('prints `--` for an unpointed Story, never 0', () => {
    // `null` is "never estimated" and `0` is "estimated at nothing". The strip has to be able to say
    // which, because the points it names are the ones missing from the Accepted series.
    render(<Strip markers={[splitOut({ points: null })]} />)

    expect(screen.getByText(/US-9 · -- pts/)).toBeInTheDocument()
  })

  it('formats every number through Intl, matching the axes beside it', () => {
    setFormatPrefs({ locale: 'de', timeZone: 'UTC' })
    render(<Strip markers={[splitOut({ points: 1234.5, todoHours: 2000, actualHours: 1500 })]} />)

    // The DISCRIMINATING assertion: a raw interpolation prints `1234.5` / `2000` here while the To Do
    // bars beside it print `1.234,5` / `2.000`, which is one quantity rendered two ways in one card.
    expect(
      screen.getByText(/1\.234,5 pts · 2\.000h To Do moved out · 1\.500h Actual retained/),
    ).toBeInTheDocument()
  })

  it('renders nothing at all when there are no markers', () => {
    const { container } = render(<Strip markers={[]} />)

    // Not an empty list, not a "no splits" note: a timebox no Split touched has nothing to say, and
    // that is every timebox before Phase 7.
    expect(container).toBeEmptyDOMElement()
  })

  it('is not a warning: no alert, no status, no live announcement', () => {
    render(<Strip markers={[splitOut(), carryIn()]} />)

    expect(document.body.querySelector('[role="alert"]')).toBeNull()
    expect(document.body.querySelector('[role="status"]')).toBeNull()
    expect(document.body.textContent).not.toMatch(/warning/i)
  })
})

describe('SplitMarkerLegend', () => {
  it('adds an entry only for the direction that is actually drawn', () => {
    render(
      <ChartLegendBar>
        <SplitMarkerLegend
          splitOutLabel="Split out"
          carryInLabel="Carry in"
          hasSplitOut
          hasCarryIn={false}
        />
      </ChartLegendBar>,
    )

    expect(screen.getByText('Split out')).toBeInTheDocument()
    // A legend entry for an annotation the chart does not draw is a claim the chart does not make.
    expect(screen.queryByText('Carry in')).not.toBeInTheDocument()
  })

  it('adds nothing when the timebox has no Split at all', () => {
    const { container } = render(
      <SplitMarkerLegend
        splitOutLabel="Split out"
        carryInLabel="Carry in"
        hasSplitOut={false}
        hasCarryIn={false}
      />,
    )

    expect(container).toBeEmptyDOMElement()
  })
})
