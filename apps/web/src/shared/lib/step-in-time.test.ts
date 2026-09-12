import { describe, expect, it } from 'vitest'

import { feedDirection, stepIndexInTime, type TimeboxLike } from './step-in-time'

const box = (startDate: string | null): TimeboxLike => ({ startDate })

describe('feedDirection', () => {
  it('reads oldest-to-newest as +1', () => {
    expect(feedDirection([box('2026-01-01'), box('2026-02-01'), box('2026-03-01')])).toBe(1)
  })

  it('reads newest-to-oldest as -1', () => {
    expect(feedDirection([box('2026-08-27'), box('2026-08-19')])).toBe(-1)
  })

  it('ignores undated rows at either end, reading direction from the dated ones', () => {
    // A "None" sentinel or an unscheduled release sorts to an end but is not the feed's direction.
    expect(feedDirection([box(null), box('2026-01-01'), box('2026-02-01')])).toBe(1)
    expect(feedDirection([box('2026-08-27'), box('2026-08-19'), box(null)])).toBe(-1)
  })

  it('defaults to +1 with fewer than two dated rows', () => {
    expect(feedDirection([])).toBe(1)
    expect(feedDirection([box('2026-01-01')])).toBe(1)
    expect(feedDirection([box(null), box(null)])).toBe(1)
  })
})

describe('stepIndexInTime — the shared chevron rule', () => {
  describe('on a newest-first feed (iterations, desc(startDate))', () => {
    const items = [box('2026-08-27'), box('2026-08-19'), box('2026-08-12')]
    const LATEST = 0
    const MIDDLE = 1
    const EARLIEST = 2

    it('steps EARLIER by moving FORWARD through the array', () => {
      expect(stepIndexInTime(items, LATEST, 'earlier')).toBe(MIDDLE)
      expect(stepIndexInTime(items, MIDDLE, 'earlier')).toBe(EARLIEST)
    })

    it('steps LATER by moving BACK through the array', () => {
      expect(stepIndexInTime(items, EARLIEST, 'later')).toBe(MIDDLE)
      expect(stepIndexInTime(items, MIDDLE, 'later')).toBe(LATEST)
    })

    it('stops at each end, matching the direction that end is', () => {
      expect(stepIndexInTime(items, EARLIEST, 'earlier')).toBeNull()
      expect(stepIndexInTime(items, LATEST, 'later')).toBeNull()
    })

    it('answers null for no selection and for an empty feed', () => {
      expect(stepIndexInTime(items, -1, 'earlier')).toBeNull()
      expect(stepIndexInTime(items, -1, 'later')).toBeNull()
      expect(stepIndexInTime([], 0, 'earlier')).toBeNull()
    })
  })

  describe('on an oldest-first feed (releases, asc(startDate))', () => {
    const items = [box('2026-04-01'), box('2026-07-01'), box('2026-10-01')]
    const EARLIEST = 0
    const MIDDLE = 1
    const LATEST = 2

    it('steps EARLIER by moving BACK through the array', () => {
      expect(stepIndexInTime(items, LATEST, 'earlier')).toBe(MIDDLE)
      expect(stepIndexInTime(items, MIDDLE, 'earlier')).toBe(EARLIEST)
    })

    it('steps LATER by moving FORWARD through the array', () => {
      expect(stepIndexInTime(items, EARLIEST, 'later')).toBe(MIDDLE)
      expect(stepIndexInTime(items, MIDDLE, 'later')).toBe(LATEST)
    })
  })

  describe('undated rows', () => {
    // capacity-plans-page.tsx prepends a `None` option with `startDate: null`, and a real release
    // may itself carry no start date (releasesOldestFirst sorts those last, on purpose) — both are
    // reachable, not hypothetical.
    it('is never landed on', () => {
      const items = [box(null), box('2026-01-01'), box('2026-02-01')]
      // Stepping "earlier" from the earliest DATED row must skip the undated one at index 0, not
      // land on it as if it were a real position in time.
      expect(stepIndexInTime(items, 1, 'earlier')).toBeNull()
    })

    it('is skipped over when it sits between two dated rows', () => {
      const items = [box('2026-01-01'), box(null), box('2026-03-01')]
      expect(stepIndexInTime(items, 0, 'later')).toBe(2)
      expect(stepIndexInTime(items, 2, 'earlier')).toBe(0)
    })

    it('can still be the STARTING index — only the destination must be dated', () => {
      const items = [box(null), box('2026-01-01'), box('2026-02-01')]
      expect(stepIndexInTime(items, 0, 'later')).toBe(1)
    })
  })
})
