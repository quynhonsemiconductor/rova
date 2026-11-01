import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'
import { getFormatPrefs } from './format-prefs'

/**
 * What an empty cell shows, app-wide.
 *
 * `--`, not an em-dash, because that is what real Rally renders for an unset value — its
 * Iteration Status and Portfolio Items grids both use it (its Timeboxes grid leaves the
 * cell blank instead, so Rally is not self-consistent; `--` is the majority and the only
 * one that is visible as a deliberate "nothing here").
 *
 * Named rather than inlined so the next person who wants to change it edits one line. The
 * ~146 literal call sites swept alongside this were already literals; they are left as
 * literals rather than importing this constant into 52 files for a two-character glyph.
 */
export const EMPTY_VALUE = '--'

/**
 * Date-only strings (`YYYY-MM-DD`, e.g. a project start/end date) carry NO time
 * or zone — they must render as that exact calendar day for everyone. Applying a
 * timezone would shift them (a negative-offset zone shows the day before), so
 * date-only values are parsed + formatted in UTC and never zone-converted. Only
 * real timestamps get the resolved timezone applied.
 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
function isDateOnly(iso: string): boolean {
  return DATE_ONLY.test(iso)
}

/**
 * tailwind-merge's default config buckets every `text-*` class (font size AND
 * color) into one conflict group, so `text-primary-foreground text-ui-sm`
 * silently dropped the color half — the last `text-*` class in the string
 * always won, regardless of whether it was actually a color or a size. This
 * broke any element combining a text-color utility with our custom `text-ui-*`
 * font-size scale (see globals.css `--text-ui-*`), e.g. every <Button> variant
 * — its color class was discarded, leaving default (dark) text color on a
 * navy background. Registering the custom scale as its own `font-size` group
 * tells tailwind-merge it does not conflict with color utilities.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        { text: ['ui-2xs', 'ui-xs', 'ui-sm', 'ui-md', 'ui-lg', 'ui-xl'] },
        // The User Guide's long-form reading scale (`--text-doc-*`): without it `text-doc-sm`
        // and a colour would conflict the same way. Kept in step with globals.css by utils.test.ts.
        {
          text: ['doc-sm', 'doc-body', 'doc-lead', 'doc-h3', 'doc-h2', 'doc-title', 'doc-display'],
        },
      ],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Format an ISO date string as a relative time (e.g. "5m ago", "2h ago", "3d ago"). */
export function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  // For older items, fall back to a short date in the resolved locale + timezone.
  const { locale, timeZone } = getFormatPrefs()
  return new Date(iso).toLocaleDateString(locale, { month: 'short', day: 'numeric', timeZone })
}

/**
 * Strip HTML tags to plain text for compact displays (e.g. a rich-text field
 * shown in a table cell). Collapses whitespace; decodes the few common
 * entities. For inline display only — not a sanitizer.
 */
export function stripHtml(html: string | null | undefined): string {
  if (!html) return ''
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Format an ISO date string as a short calendar date, e.g. "Jul 31, 2026", in
 *  the resolved locale. Timestamps use the resolved timezone; date-only values
 *  render as their literal calendar day (never zone-shifted). */
export function formatDate(iso: string | null | undefined, fallback = EMPTY_VALUE): string {
  if (!iso) return fallback
  const dateOnly = isDateOnly(iso)
  const d = new Date(dateOnly ? `${iso}T00:00:00Z` : iso)
  if (Number.isNaN(d.getTime())) return fallback
  const { locale, timeZone } = getFormatPrefs()
  return d.toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: dateOnly ? 'UTC' : timeZone,
  })
}

/** Format an ISO date/timestamp as `yyyy-MM-dd` — the shared grid date format
 *  (matches the DateField cell + every other grid's date column). Date-only
 *  strings pass through unchanged; timestamps resolve to their calendar day in
 *  the active timezone (en-CA gives the yyyy-MM-dd shape independent of locale). */
export function formatDateIso(iso: string | null | undefined, fallback = EMPTY_VALUE): string {
  if (!iso) return fallback
  if (isDateOnly(iso)) return iso
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return fallback
  const { timeZone } = getFormatPrefs()
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).format(d)
}

/** Format a timestamp with caller-supplied Intl options, honoring the resolved
 *  locale + timezone. The single escape hatch for the few displays that need a
 *  bespoke shape (comment feed, SCM connections, greetings) — they get the same
 *  user→workspace prefs as every other date without re-reading the singleton. */
export function formatWith(
  iso: string | null | undefined,
  options: Intl.DateTimeFormatOptions,
  fallback = EMPTY_VALUE,
): string {
  if (!iso) return fallback
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return fallback
  const { locale, timeZone } = getFormatPrefs()
  return d.toLocaleString(locale, { timeZone, ...options })
}

/** Format an ISO timestamp as a short date + time, e.g. "Jul 31, 2026, 2:30 PM",
 *  in the resolved locale + timezone. */
export function formatDateTime(iso: string | null | undefined, fallback = EMPTY_VALUE): string {
  if (!iso) return fallback
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return fallback
  const { locale, timeZone } = getFormatPrefs()
  return d.toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  })
}

// ── Numbers ─────────────────────────────────────────────────────────────────
//
// The numeric counterpart to `formatDate` above, and it exists for the same reason:
// before this, ~40 grid columns each decided independently what a missing number looks
// like. The audit that prompted it counted `?? 0` on display values 71 times across 16
// files against `?? '—'` 66 times across 32 — the same value rendering as `0` on one
// screen and `—` on another.
//
// The default is an EM-DASH, matching the shared table cell (`renderTypedCell`'s
// `type: 'number'` branch) and `formatDate`. Pass `fallback: '0'` only where a zero is
// genuinely the truth rather than a stand-in for "unknown" — the distinction the schema
// keeps deliberately ("Null = capacity not yet entered, which is different from zero
// capacity"). Coercing an unknown to 0 is how a grid ends up stating a confident 0%.

/** Class contract for a numeric cell. Pair with `formatNumber` so digits align. */
export const NUMERIC_CELL_CLASS = 'text-right font-mono tabular-nums'

/**
 * Render a number for display, or `fallback` when there is nothing to show.
 *
 * Treats non-finite values as missing too: `NaN` and `Infinity` both come out of
 * ordinary arithmetic on absent inputs, and printing either is worse than printing
 * nothing.
 */
export function formatNumber(
  value: number | string | null | undefined,
  {
    fallback = EMPTY_VALUE,
    maximumFractionDigits = 2,
  }: { fallback?: string; maximumFractionDigits?: number } = {},
): string {
  if (value === null || value === undefined || value === '') return fallback
  const n = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(n)) return fallback
  return n.toLocaleString(getFormatPrefs().locale, { maximumFractionDigits })
}

/**
 * Story points and hours. Same as {@link formatNumber} but never shows a trailing
 * `.00`, because `numeric(6,2)` columns arrive as `"5.00"` and "5 pts" is what a
 * planner wrote.
 */
export function formatPoints(
  value: number | string | null | undefined,
  fallback = EMPTY_VALUE,
): string {
  return formatNumber(value, { fallback, maximumFractionDigits: 2 })
}

/**
 * A 0–1 ratio as a whole percent.
 *
 * `null` means "not computable" — no denominator, nothing estimated — and must NOT
 * become 0%: "none of the work is done" and "we cannot tell" look identical as 0% and
 * are completely different facts. Every ratio producer in this app already returns null
 * for a non-positive denominator; this keeps that honesty at the last step.
 */
export function formatPercent(ratio: number | null | undefined, fallback = EMPTY_VALUE): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return fallback
  return `${Math.round(ratio * 100)}%`
}

/**
 * A value ALREADY expressed in whole percent (0–100), as most of this app's API fields
 * are — `progressPercent`, `plannedVelocityPercent`, `acceptedPercent`.
 *
 * Separate from {@link formatPercent} rather than a flag, because the two input scales are
 * impossible to tell apart at a call site: `1` is a complete ratio and also one percent.
 * Passing a whole percent to the ratio version renders `10000%`, which is exactly the bug
 * this pair exists to prevent.
 */
export function formatWholePercent(
  percent: number | null | undefined,
  fallback = EMPTY_VALUE,
): string {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return fallback
  return `${Math.round(percent)}%`
}

/**
 * TODAY as `yyyy-MM-dd`, in the reader's own timezone.
 *
 * `new Date().toISOString().slice(0, 10)` is the obvious spelling and is WRONG for half the
 * world: it converts to UTC first, so a planner in UTC+7 opening a modal before 07:00 local
 * would be handed yesterday's date, and one in UTC-5 after 19:00 would be handed tomorrow's.
 * `en-CA` is used for the same reason `formatDateIso` uses it — it is the locale whose short
 * date format IS `yyyy-MM-dd`, so the shape does not depend on the reader's locale while the
 * DAY does.
 */
export function todayIsoDate(): string {
  const { timeZone } = getFormatPrefs()
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).format(new Date())
}

/**
 * `days` after an ISO date-only string, as another ISO date-only string.
 *
 * Arithmetic is done at UTC NOON, not midnight: a date-only value has no zone, and anchoring
 * it at midnight puts it within an hour of a DST boundary in the zones that observe one — so
 * "+14 days" could land on the 13th or the 15th twice a year. Noon is far enough from either
 * shift that the calendar day cannot move.
 */
export function addIsoDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * The default length of a newly created timebox, in days — two weeks, the commonest sprint.
 *
 * A create modal prefills `startDate = todayIsoDate()` and `endDate = addIsoDays(start,
 * DEFAULT_TIMEBOX_DAYS)` so the reader confirms a plausible window instead of typing both from
 * an empty field. Both stay fully editable, and the required-field validation is unchanged —
 * this defaults the value, it does not decide it.
 */
export const DEFAULT_TIMEBOX_DAYS = 14
