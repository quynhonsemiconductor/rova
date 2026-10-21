/**
 * SearchableSelect — the single, shared dropdown for enum attributes (flow
 * state, schedule state, status, priority, severity …) AND entity references
 * (iteration, release, feature, milestone …), matching Broadcom's Rally field
 * dropdown exactly:
 *   - editable  → a bordered select box (value + chevron); on click a popover
 *                 opens with a bordered search box and a plain-text option list
 *                 (the selected row highlighted).
 *   - read-only → the value as plain text, no border / no affordance.
 *
 * Supports single-select (default) and `multiple` select (checkbox-style: rows
 * toggle without closing, the trigger shows `first (+N)`). Deliberately plain
 * (no colour badges) so every dropdown reads identically. Pairs with
 * {@link InlineEditableCell} (text/number) and {@link DateField} (dates).
 */
import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { Popover as PopoverPrimitive } from 'radix-ui'

import { BRAND } from '@/shared/config/brand'
import { cn } from '@/shared/lib/utils'
import { registerOpenPopover, unregisterOpenPopover } from '@/shared/ui/popover-coordinator'
import { AppPopoverContent } from '@/shared/ui/app-popover'
import { FIELD_FOCUS_VISIBLE } from '@/shared/ui/field-focus'

export interface SelectOption {
  value: string
  /** Display text for the trigger + option row. */
  label: string
  /** Extra text to match against when filtering (defaults to `label`). */
  searchText?: string
  /** Optional leading glyph (avatar / team chip / type badge) shown before the
   *  label in the trigger and each option row. Keep it small (~16px). */
  icon?: React.ReactNode
  /** Optional group header this option sits under (e.g. "Quick Picks",
   *  "Team Members"). Options are grouped in declared order; omit for no header. */
  group?: string
}

interface BaseProps {
  options: SelectOption[]
  readOnly?: boolean
  ariaLabel?: string
  placeholder?: string
  /** Placeholder shown in the search box. */
  searchPlaceholder?: string
  /**
   * `cell` (default) — grid-cell look: plain text at rest, border + chevron on
   * hover (the shared inline-edit affordance).
   * `field` — form look: a permanently bordered box + chevron, sized like other
   * form inputs (detail panels, create/edit modals).
   */
  variant?: 'cell' | 'field'
  /**
   * Shrinks the `field` variant to inline-strip proportions: `text-ui-xs` and tight padding
   * instead of the full form-input box.
   *
   * For a select that sits INSIDE another control's frame rather than in a form column —
   * Rally's "Total Accepted Children" unit picker is the case. Without it the select is
   * taller than the strip that contains it and drags the whole row's height with it.
   */
  dense?: boolean
  /**
   * Let the selected label WRAP instead of truncating.
   *
   * Off by default, because most cell selects hold a short bounded value (a state, a
   * team, a person) where one line is the right answer and a growing row is noise. Opt in
   * for a column whose value is a name that can genuinely be long — Project is the case
   * this exists for, and Rally wraps that column too.
   */
  wrapLabel?: boolean
  /**
   * Optional custom content for the trigger, rendered in place of the default
   * icon + label (the chevron and popover behaviour are preserved). Use for
   * fields that need a special at-rest display — e.g. Schedule State's
   * segmented stepper — while still opening the shared searchable list.
   */
  triggerContent?: React.ReactNode
  className?: string
}

interface SingleProps extends BaseProps {
  multiple?: false
  value: string
  onChange: (value: string) => void
}

interface MultiProps extends BaseProps {
  /** Multi-select: rows toggle without closing; `value`/`onChange` use arrays. */
  multiple: true
  value: readonly string[]
  onChange: (value: string[]) => void
}

export type SearchableSelectProps = SingleProps | MultiProps

/** Grid CELL chips: show up to this many, the rest collapse into a "+K". */
const MAX_CELL_CHIPS = 3

function Chip({ icon, label }: { icon?: ReactNode; label: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-input bg-surface-subtle px-2 py-0.5 text-ui-xs text-foreground">
      {icon}
      <span className="truncate">{label}</span>
    </span>
  )
}

/**
 * Grid-cell chip container: chips sit on a SINGLE line (no wrap) so the cell
 * never grows past the fixed row height and clips against the row divider,
 * capped at MAX_CELL_CHIPS with a trailing "+K" for the rest (full list on
 * hover; click still opens the picker). A fixed cap — not a live line
 * measurement — so it is reliable regardless of the cell's mount/resize timing.
 */
function CellChips({ opts }: { opts: SelectOption[] }) {
  const visible = opts.slice(0, MAX_CELL_CHIPS)
  const overflow = opts.length - visible.length
  return (
    <span
      className="flex min-w-0 flex-1 flex-nowrap items-center gap-1 overflow-hidden"
      title={opts.map((o) => o.label).join(', ')}
    >
      {visible.map((o) => (
        <Chip key={o.value} icon={o.icon} label={o.label} />
      ))}
      {overflow > 0 && (
        <span className="shrink-0 text-ui-xs text-foreground-subtle">+{overflow}</span>
      )}
    </span>
  )
}

export function SearchableSelect(props: SearchableSelectProps) {
  const {
    options,
    readOnly = false,
    ariaLabel = 'Select',
    placeholder = '--',
    searchPlaceholder = 'Search',
    variant = 'cell',
    dense = false,
    wrapLabel = false,
    triggerContent,
    className,
  } = props
  const multiple = props.multiple === true

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const close = useCallback(() => setOpen(false), [])

  // Normalise the current selection to an id list regardless of mode.
  const selectedValues = useMemo(
    () => (multiple ? [...props.value] : props.value ? [props.value] : []),
    [multiple, props.value],
  )
  const isSelected = useCallback(
    (v: string) => (multiple ? props.value.includes(v) : props.value === v),
    [multiple, props.value],
  )

  // Trigger display: single → the selected label; multi → `first (+N)`.
  const selectedOpts = useMemo(
    () => options.filter((o) => selectedValues.includes(o.value)),
    [options, selectedValues],
  )
  const first = multiple ? selectedOpts[0] : options.find((o) => o.value === props.value)
  const extraCount = multiple ? Math.max(0, selectedOpts.length - 1) : 0
  const display = first?.label ?? placeholder
  const hasSelection = selectedValues.length > 0

  // Multi-select chips — one per line (stacked), each truncating to the column
  // width. The FIELD variant (forms) shows every selected value. The CELL
  // variant (data grids) caps at MAX_CELL_CHIPS and collapses the rest into a
  // trailing "+K" (full list on hover), so a large team/label set can't grow a
  // row unbounded; clicking still opens the picker to see/edit all.
  const showChips = multiple && hasSelection
  const isCell = variant === 'cell'
  // Cell (grid): wrap + clamp to MAX_CELL_LINES + "+K". Field (form): stack all.
  const chips = isCell ? (
    <CellChips opts={selectedOpts} />
  ) : (
    <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
      {selectedOpts.map((o) => (
        <Chip key={o.value} icon={o.icon} label={o.label} />
      ))}
    </span>
  )

  const handlePick = useCallback(
    (v: string) => {
      if (multiple) {
        const set = new Set(props.value)
        if (set.has(v)) set.delete(v)
        else set.add(v)
        props.onChange([...set])
        // keep the popover open so several toggles commit in one session
      } else {
        props.onChange(v)
        setOpen(false)
        setQuery('')
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [multiple, props.value, props.onChange],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? options.filter((o) => (o.searchText ?? o.label).toLowerCase().includes(q)) : options
  }, [options, query])

  // Grouping. Multi-select with NO explicit per-option groups → auto-split into
  // "Selected" / "Available" (Broadcom Rally parity): checked items float to a
  // Selected bucket on top, the rest under Available; rows move live as you
  // toggle. Otherwise group in declared order (options without `group` fall in
  // one leading bucket).
  const grouped = useMemo(() => {
    if (multiple && !filtered.some((o) => o.group)) {
      const sel: SelectOption[] = []
      const avail: SelectOption[] = []
      for (const o of filtered) (selectedValues.includes(o.value) ? sel : avail).push(o)
      const auto: { name?: string; items: SelectOption[] }[] = []
      if (sel.length) auto.push({ name: 'Selected', items: sel })
      if (avail.length) auto.push({ name: 'Available', items: avail })
      return auto
    }
    const buckets: { name?: string; items: SelectOption[] }[] = []
    for (const o of filtered) {
      let b = buckets.find((x) => x.name === o.group)
      if (!b) {
        b = { name: o.group, items: [] }
        buckets.push(b)
      }
      b.items.push(o)
    }
    return buckets
  }, [filtered, multiple, selectedValues])

  if (readOnly) {
    if (showChips) {
      return <span className={cn('flex', isCell && 'px-2 py-1.5', className)}>{chips}</span>
    }
    return (
      <span
        className={cn(
          'flex items-center gap-1.5 text-ui-sm text-foreground',
          // Match the editable cell trigger's padding so a read-only inline cell
          // lines up with the editable ones in the same column.
          variant === 'cell' && 'px-2 py-1.5',
          className,
        )}
      >
        {first?.icon}
        <span className={cn('truncate', !hasSelection && 'text-foreground-subtle')}>{display}</span>
        {extraCount > 0 && (
          <span className="shrink-0 text-ui-xs text-foreground-subtle">+{extraCount}</span>
        )}
      </span>
    )
  }

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) registerOpenPopover(close)
        else {
          unregisterOpenPopover(close)
          setQuery('')
        }
      }}
    >
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className={cn(
            'group w-full text-left text-foreground',
            variant === 'field'
              ? cn(
                  `rounded border border-input bg-white transition-colors hover:border-accent-border-active focus:outline-none ${FIELD_FOCUS_VISIBLE}`,
                  dense ? 'px-1.5 py-0.5 text-ui-xs' : 'px-3 py-2 text-ui-md',
                )
              : 'inline-edit-cell px-2 py-1.5 text-ui-sm',
            className,
          )}
        >
          <span className="flex w-full items-center justify-between gap-1">
            {triggerContent ? (
              <span className="flex min-w-0 flex-1 items-center">{triggerContent}</span>
            ) : showChips ? (
              chips
            ) : (
              <span
                className={cn('flex min-w-0 gap-1.5', wrapLabel ? 'items-start' : 'items-center')}
              >
                {first?.icon}
                <span
                  className={cn(
                    wrapLabel ? 'break-words whitespace-normal' : 'truncate',
                    !hasSelection && 'text-foreground-subtle',
                  )}
                >
                  {display}
                </span>
                {extraCount > 0 && (
                  <span className="shrink-0 text-ui-xs text-foreground-subtle">+{extraCount}</span>
                )}
              </span>
            )}
            {/* Chevron: always shown in `field`; hover/open only in `cell` (plain text at rest). */}
            <ChevronDown
              size={variant === 'field' && !dense ? 14 : 13}
              className={cn(
                'shrink-0 text-muted-foreground',
                variant === 'cell' &&
                  'opacity-0 transition-opacity group-hover:opacity-100 group-data-[state=open]:opacity-100',
              )}
            />
          </span>
        </button>
      </PopoverPrimitive.Trigger>
      <AppPopoverContent
        align="start"
        sideOffset={3}
        className="w-[var(--radix-popover-trigger-width)] min-w-48 overflow-hidden rounded-md p-1 shadow-lg ring-1 ring-black/5"
        style={{ backgroundColor: BRAND.surface }}
      >
        {/* Search box — one full border, blue while focused (Rally parity). */}
        <div className="flex items-center gap-2 rounded-md border border-input px-2 py-1.5 transition-colors focus-within:border-primary">
          <Search size={13} className="shrink-0 text-primary" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            // Inline `outline: none` overrides the global `:focus-visible`
            // outline (globals.css) that would otherwise draw a 2px offset
            // ring inside the search box's own border → a doubled border.
            style={{ outline: 'none' }}
            className="w-full bg-transparent text-ui-sm text-foreground placeholder-foreground-subtle"
          />
        </div>

        {/* Options — scroll guard is handled centrally by AppPopoverContent. */}
        <div className="mt-1 max-h-60 overflow-y-auto">
          {filtered.length === 0 && (
            <div className="px-3 py-2 text-ui-sm text-foreground-subtle">No matches</div>
          )}
          {grouped.map((bucket) => (
            <div key={bucket.name ?? '__ungrouped'}>
              {bucket.name && (
                <div className="px-3 pt-2 pb-1 text-ui-xs font-semibold tracking-wider text-foreground-subtle uppercase">
                  {bucket.name}
                </div>
              )}
              {bucket.items.map((o) => {
                const sel = isSelected(o.value)
                return (
                  <button
                    key={`${bucket.name ?? ''}:${o.value}`}
                    type="button"
                    onClick={() => handlePick(o.value)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-ui-sm text-foreground transition-colors hover:bg-surface-hover',
                      // Single-select highlights the chosen row; multi-select shows
                      // its state via the leading checkbox, so no row highlight.
                      !multiple && sel && 'bg-primary-lighter',
                    )}
                  >
                    {/* Multi-select: leading checkbox (presentational — the row
                          button owns the toggle, so no nested interactive input). */}
                    {multiple && (
                      <span
                        className={cn(
                          'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border',
                          sel ? 'border-primary bg-primary text-white' : 'border-input bg-white',
                        )}
                      >
                        {sel && <Check size={11} strokeWidth={3} />}
                      </span>
                    )}
                    {o.icon}
                    <span className="truncate">{o.label}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </AppPopoverContent>
    </PopoverPrimitive.Root>
  )
}
