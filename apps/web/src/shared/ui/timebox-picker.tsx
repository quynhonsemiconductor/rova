/**
 * TimeboxPicker — the compact prev / dropdown / next timebox selector used by the tracking
 * surfaces (Team Board, Reports) and by the Capacity Planning list's release range. Single source
 * of truth so the control can't drift between pages.
 *
 * Named for the timebox it selects rather than for iterations: a release is the same shape (a name
 * plus a date range) and Capacity Planning needs the same box. `IterationPicker` is kept as a thin
 * alias so the tracking pages keep reading in their own vocabulary.
 *
 * Selection persistence (last-viewed per project) is owned by the caller via `selectedId` /
 * `onSelect`; this component is purely presentational.
 */
import { useState } from 'react'
import { ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react'

import { useClickOutside } from '@/shared/lib/hooks/use-click-outside'

export interface PickerTimebox {
  id: string
  name: string
  startDate: string | null
  endDate: string | null
}

/** @deprecated Use {@link PickerTimebox} — kept so existing iteration call sites still read well. */
export type PickerIteration = PickerTimebox

/**
 * `null` when the timebox has NO dates at all — the caller then renders no range.
 *
 * A dateless row (the `None` option, or a release nobody has scheduled) used to print `— - —`,
 * which reads as two missing values rather than as "there is no range here".
 */
function fmtRange(it: Pick<PickerTimebox, 'startDate' | 'endDate'>): string | null {
  if (it.startDate === null && it.endDate === null) return null
  return `${it.startDate ?? '--'} - ${it.endDate ?? '--'}`
}

/**
 * `1` if `items` runs oldest-to-newest, `-1` if newest-to-oldest — read from the first and last
 * dated rows so the prev/next arrows step the right way for whichever feed the caller passed
 * (iterations arrive `desc(startDate)`, releases `asc(startDate)`). Defaults to `1` when there are
 * fewer than two dated rows to compare, which makes `move` a no-op-safe plain array step.
 */
function feedStepDirection(items: readonly PickerTimebox[]): 1 | -1 {
  const dated = items.filter((it) => it.startDate !== null)
  if (dated.length < 2) return 1
  const first = dated[0].startDate as string
  const last = dated[dated.length - 1].startDate as string
  return first <= last ? 1 : -1
}

export function TimeboxPicker({
  items,
  selectedId,
  onSelect,
  emptyLabel = 'No iteration',
  noneLabel = 'No iterations',
  prevLabel = 'Previous iteration',
  nextLabel = 'Next iteration',
  minWidth = 280,
}: {
  items: PickerTimebox[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** Shown on the button when nothing is selected. */
  emptyLabel?: string
  /** Shown inside the menu when there is nothing to choose. */
  noneLabel?: string
  prevLabel?: string
  nextLabel?: string
  /** The button's minimum width — a release range needs less room than an iteration. */
  minWidth?: number
}) {
  const iterations = items
  const [open, setOpen] = useState(false)
  const pickerRef = useClickOutside<HTMLDivElement>(open, () => setOpen(false))
  const selectedIndex = iterations.findIndex((i) => i.id === selectedId)
  const selected = iterations[selectedIndex]
  const feedDirection = feedStepDirection(iterations)

  function stepTarget(direction: 'earlier' | 'later'): number {
    const step = direction === 'earlier' ? -feedDirection : feedDirection
    return selectedIndex + step
  }
  function canMove(direction: 'earlier' | 'later'): boolean {
    if (selectedIndex < 0) return false
    const next = stepTarget(direction)
    return next >= 0 && next < iterations.length
  }
  function move(direction: 'earlier' | 'later') {
    const next = stepTarget(direction)
    if (next >= 0 && next < iterations.length) onSelect(iterations[next].id)
  }

  return (
    <div
      className="flex items-center border border-border-strong"
      style={{ borderRadius: 2, height: 28 }}
    >
      <button
        type="button"
        disabled={!canMove('earlier')}
        onClick={() => move('earlier')}
        className="flex h-full items-center border-r border-border-strong px-1.5 text-muted-foreground disabled:opacity-40"
        aria-label={prevLabel}
      >
        <ChevronLeft size={14} />
      </button>
      <div ref={pickerRef} className="relative h-full">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex h-full items-center gap-2.5 px-2.5 text-left text-foreground"
          style={{ minWidth }}
        >
          <span className="text-ui-md font-semibold whitespace-nowrap">
            {selected?.name ?? emptyLabel}
          </span>
          {selected && fmtRange(selected) !== null && (
            <span className="text-ui-sm whitespace-nowrap text-muted-foreground">
              {fmtRange(selected)}
            </span>
          )}
          <ChevronDown
            size={12}
            className="text-foreground-subtle"
            style={{ marginLeft: 'auto' }}
          />
        </button>
        {open && (
          <>
            <div
              className="absolute top-full left-0 z-50 mt-1 overflow-y-auto border border-border-strong bg-card py-1"
              style={{
                width: 360,
                maxHeight: 300,
                borderRadius: 2,
                boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
              }}
            >
              {iterations.length === 0 && (
                <div className="px-3 py-2 text-ui-sm text-foreground-subtle">{noneLabel}</div>
              )}
              {iterations.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => {
                    onSelect(it.id)
                    setOpen(false)
                  }}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-background ${it.id === selectedId ? 'bg-primary-lighter' : ''}`}
                >
                  <span className="text-ui-md font-medium text-foreground">{it.name}</span>
                  {fmtRange(it) !== null && (
                    <span className="text-ui-sm text-foreground-subtle">{fmtRange(it)}</span>
                  )}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <button
        type="button"
        disabled={!canMove('later')}
        onClick={() => move('later')}
        className="flex h-full items-center border-l border-border-strong px-1.5 text-muted-foreground disabled:opacity-40"
        aria-label={nextLabel}
      >
        <ChevronRight size={14} />
      </button>
    </div>
  )
}

/**
 * The tracking surfaces' name for the same control.
 *
 * An alias rather than a copy: Team Board and Reports select an iteration and read better saying
 * so, but there is exactly one implementation to change.
 */
export function IterationPicker({
  iterations,
  selectedId,
  onSelect,
}: {
  iterations: PickerTimebox[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  return <TimeboxPicker items={iterations} selectedId={selectedId} onSelect={onSelect} />
}
