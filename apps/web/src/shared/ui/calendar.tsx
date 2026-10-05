/**
 * Calendar — a single-month day picker grid (month title + prev/next, weekday
 * header, day cells), matching Broadcom Rally's date popover. Built on
 * `date-fns`; presentational only — the parent owns the selected value and
 * handles `onSelect`. Used inside {@link DateField}'s popover.
 */
import { useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  parseISO,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns'

import { cn } from '@/shared/lib/utils'

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

/** Parse an ISO date-only / timestamp string to a Date, or null if invalid. */
function parse(value: string | null | undefined): Date | null {
  if (!value) return null
  const d = value.length <= 10 ? parseISO(value) : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export function Calendar({
  value,
  onSelect,
  isDateDisabled,
  defaultMonth,
}: {
  value?: string | null
  /** Fires with the picked day as an ISO date-only string (yyyy-MM-dd). */
  onSelect: (iso: string) => void
  /**
   * Optional, additive: a day this returns `true` for is rendered disabled (`disabled` +
   * `aria-disabled`) and cannot be picked. Receives the day as `yyyy-MM-dd`.
   */
  isDateDisabled?: (iso: string) => boolean
  /** Month to open on when there is no `value` (`yyyy-MM-dd`); never rendered as selected. */
  defaultMonth?: string | null
}) {
  const selected = parse(value)
  const [month, setMonth] = useState(() =>
    startOfMonth(selected ?? parse(defaultMonth) ?? new Date()),
  )
  const today = new Date()

  const days = eachDayOfInterval({
    start: startOfWeek(startOfMonth(month)),
    end: endOfWeek(endOfMonth(month)),
  })

  return (
    <div className="w-64 p-2 select-none">
      {/* Month title + nav */}
      <div className="flex items-center justify-between px-1 py-1">
        <span className="text-ui-md font-semibold text-primary">{format(month, 'MMMM yyyy')}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => setMonth((m) => subMonths(m, 1))}
            className="rounded p-1 text-muted-foreground hover:bg-surface-hover"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => setMonth((m) => addMonths(m, 1))}
            className="rounded p-1 text-muted-foreground hover:bg-surface-hover"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 text-center text-ui-xs font-semibold text-foreground-subtle">
        {WEEKDAYS.map((w) => (
          <div key={w} className="py-1">
            {w}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7">
        {days.map((day) => {
          const inMonth = isSameMonth(day, month)
          const isSelected = selected != null && isSameDay(day, selected)
          const isToday = isSameDay(day, today)
          const iso = format(day, 'yyyy-MM-dd')
          const disabled = isDateDisabled?.(iso) ?? false
          return (
            <button
              key={day.toISOString()}
              type="button"
              disabled={disabled}
              aria-disabled={disabled || undefined}
              data-date={iso}
              onClick={() => {
                if (!disabled) onSelect(iso)
              }}
              className={cn(
                'mx-auto flex h-8 w-8 items-center justify-center rounded-full text-ui-sm tabular-nums transition-colors',
                !inMonth && 'text-foreground-faint',
                inMonth && !isSelected && !disabled && 'text-foreground hover:bg-surface-hover',
                isToday && !isSelected && 'font-semibold text-primary',
                isSelected && 'bg-primary font-semibold text-white',
                disabled && 'cursor-not-allowed text-foreground-faint line-through opacity-60',
              )}
            >
              {format(day, 'd')}
            </button>
          )
        })}
      </div>
    </div>
  )
}
