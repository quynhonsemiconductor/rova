import { afterEach, describe, expect, it, vi } from 'vitest'
import { setFormatPrefs } from './format-prefs'
import { addIsoDays, cn, relativeTime, todayIsoDate, DEFAULT_TIMEBOX_DAYS } from './utils'

describe('cn (class name merge)', () => {
  it('joins class names', () => {
    expect(cn('a', 'b')).toBe('a b')
  })

  it('drops falsy values', () => {
    expect(cn('a', false, null, undefined, '', 'b')).toBe('a b')
  })

  it('keeps a text colour beside a custom font size, from either scale', () => {
    expect(cn('text-ui-sm', 'text-primary')).toBe('text-ui-sm text-primary')
    expect(cn('text-doc-title', 'text-foreground')).toBe('text-doc-title text-foreground')
    expect(cn('[&_h2]:text-doc-h2', '[&_h2]:text-foreground')).toBe(
      '[&_h2]:text-doc-h2 [&_h2]:text-foreground',
    )
    // Two sizes still conflict: the later one wins.
    expect(cn('text-doc-body', 'text-doc-lead')).toBe('text-doc-lead')
  })

  it('applies conditional object syntax', () => {
    expect(cn('base', { active: true, hidden: false })).toBe('base active')
  })

  it('dedupes conflicting tailwind utilities (last wins)', () => {
    // tailwind-merge keeps the later of two conflicting utilities.
    expect(cn('p-2', 'p-4')).toBe('p-4')
    expect(cn('text-sm', 'text-lg')).toBe('text-lg')
  })
})

describe('relativeTime', () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

  it('returns "just now" under a minute', () => {
    expect(relativeTime(ago(30_000))).toBe('just now')
  })

  it('returns minutes for under an hour', () => {
    expect(relativeTime(ago(5 * 60_000))).toBe('5m ago')
  })

  it('returns hours for under a day', () => {
    expect(relativeTime(ago(3 * 60 * 60_000))).toBe('3h ago')
  })

  it('returns days for under a month', () => {
    expect(relativeTime(ago(4 * 24 * 60 * 60_000))).toBe('4d ago')
  })

  it('falls back to a short date for older items', () => {
    // 60 days ago → "Mon D" style, never the relative suffix.
    const result = relativeTime(ago(60 * 24 * 60 * 60_000))
    expect(result).not.toMatch(/ago|just now/)
    expect(result).toMatch(/[A-Z][a-z]{2} \d{1,2}/)
  })
})

describe('todayIsoDate / addIsoDays — the create-modal date prefill', () => {
  const restore = () => setFormatPrefs({ locale: 'en', timeZone: 'UTC' })
  afterEach(restore)

  it("reads TODAY in the reader's own zone, not UTC", () => {
    // 2026-08-23T22:00Z is already the 24th in Bangkok (UTC+7) and still the 23rd in New York.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-23T22:00:00Z'))
    try {
      setFormatPrefs({ timeZone: 'Asia/Bangkok' })
      expect(todayIsoDate()).toBe('2026-08-24')

      setFormatPrefs({ timeZone: 'America/New_York' })
      expect(todayIsoDate()).toBe('2026-08-23')
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns yyyy-MM-dd regardless of the LOCALE', () => {
    // `en-CA` is pinned inside the helper precisely so the SHAPE cannot follow the reader's locale
    // while the DAY does — a `de` reader must not get `24.8.2026` into a date field.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-23T12:00:00Z'))
    try {
      setFormatPrefs({ locale: 'de', timeZone: 'UTC' })
      expect(todayIsoDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('adds whole calendar days, including across a month and a year end', () => {
    expect(addIsoDays('2026-08-23', DEFAULT_TIMEBOX_DAYS)).toBe('2026-09-06')
    expect(addIsoDays('2026-12-28', 7)).toBe('2027-01-04')
    expect(addIsoDays('2026-08-23', 0)).toBe('2026-08-23')
  })

  it('survives a DST boundary — the reason the arithmetic anchors at noon', () => {
    // US DST springs forward on 2027-03-14. Anchored at midnight this lands an hour from the shift
    // and the calendar day can move; at noon it cannot.
    expect(addIsoDays('2027-03-07', 14)).toBe('2027-03-21')
    // EU clocks change 2026-10-25.
    expect(addIsoDays('2026-10-18', 14)).toBe('2026-11-01')
  })

  it('returns the input unchanged for an unparseable date rather than throwing', () => {
    expect(addIsoDays('', 14)).toBe('')
    expect(addIsoDays('not-a-date', 14)).toBe('not-a-date')
  })
})
