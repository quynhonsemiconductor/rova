/**
 * The shared chart shell — one place that owns axis, grid, tooltip and legend styling for
 * every chart in the app.
 *
 * Before Phase 6 there was exactly one recharts consumer (the old Reports dashboard) and no
 * abstraction, so its tick sizes, grid stroke and tooltip border were written inline. Four
 * chart surfaces arrive with Phase 6 (Burndown, Velocity, the Release burnup, and whatever
 * follows), and four copies of `tick={{ fontSize: 9, fill: … }}` is exactly how the tables
 * drifted apart before `DataTableFrame` existed.
 *
 * Series colours are NOT defined here — a caller passes them from `BRAND.report*`, because
 * which measure is teal and which is green is a contract with the BA, not a chart default.
 */
import type { ReactElement, ReactNode } from 'react'
import { ResponsiveContainer } from 'recharts'

import { BRAND } from '@/shared/config/brand'
import { cn } from '@/shared/lib/utils'
import { EmptyState } from '@/shared/ui/empty-state'

/** Axis/tick defaults, spread onto `<XAxis>` / `<YAxis>` so every chart matches. */
export const CHART_AXIS = {
  tick: { fontSize: 10, fill: BRAND.textSecondary },
  axisLine: { stroke: BRAND.border },
  tickLine: false,
} as const

/** Grid defaults. */
export const CHART_GRID = { stroke: BRAND.reportGrid, strokeDasharray: '3 3' } as const

/** Tooltip container, matching the app's popovers rather than recharts' default. */
export const CHART_TOOLTIP = {
  fontSize: 11,
  border: `1px solid ${BRAND.border}`,
  borderRadius: 3,
  backgroundColor: BRAND.surface,
  color: BRAND.textPrimary,
} as const

/**
 * ANNOTATION rules — a `ReferenceLine` marking an EVENT on the axis, not a series.
 *
 * Here rather than at the call site for the reason this module exists: `fontSize: 9` inlined beside a
 * chart is the exact example the docblock above holds up, and the first copy of a style value is what
 * makes the second one look normal. The Split markers (`pages/reports/ui/split-marker-lines.tsx`) are
 * the first annotation in the app; anything that marks a second kind of event reads these.
 *
 * `labelFontSize` matches `CHART_AXIS.tick` (10) DELIBERATELY: a marker label sits among the axis
 * ticks and the tooltip (11), so a third size would make it read as an accident rather than as a
 * decision. It is named separately from a `tick` because a label is not a tick — nothing else about an
 * annotation belongs on an axis.
 *
 * `strokeDasharray` DIFFERS FROM {@link CHART_GRID}'s `'3 3'` ON PURPOSE, and that is the whole reason
 * it is a named constant: a marker must be distinguishable from a gridline at a glance, and a
 * one-character difference between two literals is indistinguishable from a typo to the next reader.
 */
export const CHART_MARKER = {
  strokeDasharray: '4 3',
  strokeWidth: 1.5,
  labelFontSize: 10,
} as const

/** An axis label, positioned the way the mockup's rotated captions are. */
export function axisLabel(value: string, side: 'left' | 'right' | 'bottom') {
  const style = { fontSize: 10, fill: BRAND.textSecondary } as const
  if (side === 'bottom') return { value, position: 'insideBottom' as const, offset: -4, style }
  return {
    value,
    angle: side === 'left' ? (-90 as const) : (90 as const),
    position: side === 'left' ? ('insideLeft' as const) : ('insideRight' as const),
    style,
  }
}

/**
 * The equivalent of the chart, as data.
 *
 * A recharts chart is an inline SVG of paths and `<text>` nodes: a screen reader is read a pile of
 * disconnected numbers in painting order, with nothing to say which series or which day any of them
 * belongs to. Alt text alone cannot fix that — "Iteration Burndown chart" conveys none of the
 * values, and these reports ARE their values.
 *
 * So the caller hands over the same rows it plotted and the frame renders them once as a real
 * `<table>`, visually hidden. Same source array, so the two cannot disagree.
 */
export interface ChartDataTable {
  /** Column headings, first one being the axis category (`Date`, `Iteration`). */
  columns: string[]
  /** One row per axis point, already formatted. `null` renders as "no data" — never as 0. */
  rows: (string | number | null)[][]
  /** Sentence describing what the chart shows, used as the table's caption. */
  caption: string
  /** Translated wording for a `null` cell — a gap, which must not read as zero. */
  noDataLabel: string
}

/**
 * A titled chart card with a fixed height and an explicit empty state.
 *
 * `isEmpty` is a required decision rather than a derived one: every Phase 6 report has to
 * distinguish "no data" from "zero", and the cross-report contract forbids rendering the
 * second as the first. The caller knows which of its several empty reasons applies, so it
 * supplies the message.
 */
export function ChartFrame({
  title,
  subtitle,
  actions,
  height = 360,
  isEmpty = false,
  emptyTitle,
  emptyDescription,
  legend,
  underAxis,
  dataTable,
  footer,
  children,
  bare = false,
}: {
  title?: ReactNode
  /** The centred, bold context line — `{Project} - {Team|All Teams}` on Burndown (IB §7). */
  subtitle?: ReactNode
  actions?: ReactNode
  height?: number
  isEmpty?: boolean
  emptyTitle?: string
  emptyDescription?: string
  legend?: ReactNode
  /**
   * A secondary row belonging to the X-AXIS, rendered immediately under it and above the legend.
   *
   * The Release burnup's iteration band is this: RT-AC-09 and §7 put "a secondary iteration-name row"
   * on the x-axis, so a reader can map a date onto the sprint it fell in. Rendered from `footer` it
   * sat below the legend and the history notes — around 90px under the dates it labels, with two
   * unrelated blocks in between, which is far enough to stop being a second axis at all.
   */
  underAxis?: ReactNode
  /** The chart's data as a visually hidden table. See {@link ChartDataTable}. */
  dataTable?: ChartDataTable
  footer?: ReactNode
  /** A single recharts chart element. */
  children: ReactElement
  /**
   * Drop the card border/background/padding, for a chart already inside a surface that owns
   * them (`ReportSurface`). Without this the Reports card nested a second bordered card and
   * every chart sat in a double frame.
   */
  bare?: boolean
}) {
  return (
    <div className={bare ? '' : 'rounded border border-border-strong bg-card p-4'}>
      {(title != null || actions != null) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title != null && <p className="text-ui-sm font-semibold text-foreground">{title}</p>}
          {actions}
        </div>
      )}
      {subtitle != null && (
        <div className="mb-3 text-center text-ui-lg font-semibold text-foreground">{subtitle}</div>
      )}
      {isEmpty ? (
        <div className="flex items-center justify-center" style={{ height }}>
          <EmptyState title={emptyTitle ?? ''} description={emptyDescription} />
        </div>
      ) : (
        <>
          {/* `aria-hidden` on the plot, the table below carrying the content. Hiding the SVG is the
              point: left visible to assistive tech it duplicates every number in an order that
              means nothing, and a reader would have to hear it twice. */}
          <div style={{ height }} aria-hidden="true">
            <ResponsiveContainer width="100%" height="100%">
              {children}
            </ResponsiveContainer>
          </div>
          {underAxis}
          {dataTable != null && <ChartDataTableFallback {...dataTable} />}
        </>
      )}
      {!isEmpty && legend != null && <ChartLegendBar>{legend}</ChartLegendBar>}
      {footer}
    </div>
  )
}

/**
 * The hidden table.
 *
 * `sr-only` rather than `display: none`: the latter is skipped by assistive tech too, which would
 * make this an accessibility feature that helps nobody.
 *
 * THE CLASS GOES ON A WRAPPER `div`, NEVER ON THE `<table>` ITSELF.
 * ----------------------------------------------------------------
 * `sr-only` hides by shrinking to `1px × 1px` and clipping. A `<table>` sets `display: table`, which
 * SIZES TO ITS CONTENT and so overrides both dimensions — the element stays `position: absolute` and
 * clipped, and therefore invisible, but it still lays out at its full size. Measured here: 906.9 ×
 * 693px of invisible table inside the Release Tracking burnup card.
 *
 * That is not a cosmetic detail. The card is a flex child, so those 693px inflated the column, which
 * pushed the page past the viewport and gave `Portfolio > Release Tracking` a scrollbar and a screen
 * of empty space under a chart that fits — reported 2026-08-24. A `div` has no such behaviour, so the
 * class does what it says and the table inside it is measured at zero.
 */
function ChartDataTableFallback({ columns, rows, caption, noDataLabel }: ChartDataTable) {
  return (
    <div className="sr-only">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) =>
                cellIndex === 0 ? (
                  <th key={cellIndex} scope="row">
                    {cell}
                  </th>
                ) : (
                  // A gap is spoken as a gap. "0" here would be the same fabrication the charts
                  // refuse to draw.
                  <td key={cellIndex}>{cell ?? noDataLabel}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The bordered strip the mockup puts the burndown legend in. */
export function ChartLegendBar({ children }: { children: ReactNode }) {
  return (
    <div className="mt-3 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 rounded border border-border-subtle bg-background px-3 py-2.5 text-ui-xs text-muted-foreground">
      {children}
    </div>
  )
}

/**
 * One legend entry: a swatch (bar), a rule (line) or a marker (dot), plus its series name.
 *
 * `dot` matches how Rally marks a FILLED series — its burnup legends the shaded Accepted band with a
 * dot and the three plain trajectories with rules, so the swatch says which series has an area under it
 * before the reader looks at the chart.
 */
export function ChartLegendItem({
  color,
  label,
  shape = 'bar',
  hidden = false,
  dimmed = false,
  onToggle,
  onHover,
  toggleLabel,
}: {
  color: string
  label: ReactNode
  shape?: 'bar' | 'line' | 'dot'
  /** The series is switched OFF: swatch and text go grey, as Rally greys a disabled legend entry. */
  hidden?: boolean
  /** Another entry is being hovered, so this one recedes. */
  dimmed?: boolean
  /**
   * Makes the entry a real button that shows/hides its series — Rally's behaviour: click an entry and
   * the series leaves the chart, click again and it returns.
   *
   * The `<button>` lives HERE rather than in the page because `shared/ui` is where a control belongs
   * (the FE ratchet counts raw `<button>` in consumer layers, and for this reason).
   */
  onToggle?: () => void
  /** Hover in/out, for the "highlight one series, recede the rest" pass Rally does. */
  onHover?: (hovering: boolean) => void
  /** Accessible name for the toggle, e.g. `Hide Accepted Points`. Required when `onToggle` is given. */
  toggleLabel?: string
}) {
  const swatch =
    shape === 'bar'
      ? 'h-2.5 w-2.5 rounded-sm'
      : shape === 'dot'
        ? 'h-2 w-2 rounded-full'
        : 'h-0.5 w-4'
  const body = (
    <>
      <span
        className={swatch}
        // A hidden series keeps its SHAPE and loses its colour: the entry still has to be findable to
        // be clicked again, so it greys rather than disappearing.
        style={{ backgroundColor: hidden ? BRAND.textDisabled : color }}
      />
      {label}
    </>
  )
  const tone = hidden ? 'text-foreground-disabled' : dimmed ? 'opacity-40' : ''

  if (!onToggle) return <span className={cn('flex items-center gap-1.5', tone)}>{body}</span>

  return (
    <button
      type="button"
      aria-pressed={!hidden}
      aria-label={toggleLabel}
      onClick={onToggle}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
      onFocus={() => onHover?.(true)}
      onBlur={() => onHover?.(false)}
      className={cn(
        'flex cursor-pointer items-center gap-1.5 rounded px-1 transition-opacity',
        'hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary',
        tone,
      )}
    >
      {body}
    </button>
  )
}
