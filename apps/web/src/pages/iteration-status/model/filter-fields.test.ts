/**
 * `toIterationStatusQuery` — the applied filter values as the status query (PR #653 review, round 3:
 * the date-text filters must never exceed the server's `max(10)` and 400 the whole grid).
 */
import { describe, expect, it } from 'vitest'

import { DATE_FILTER_MAX, toIterationStatusQuery } from './filter-fields'

describe('toIterationStatusQuery', () => {
  it('passes the other filters through unchanged', () => {
    expect(toIterationStatusQuery({ itemKey: 'US-1', isBlocked: 'false' })).toEqual({
      itemKey: 'US-1',
      isBlocked: 'false',
    })
  })

  it('keeps a month fragment and a full date as typed', () => {
    expect(toIterationStatusQuery({ startDate: '2026-10', targetEndDate: '2026-10-05' })).toEqual({
      startDate: '2026-10',
      targetEndDate: '2026-10-05',
    })
  })

  it('clips an over-long date filter to the server bound, keeping the date part', () => {
    const query = toIterationStatusQuery({
      startDate: '2026-09-01T10:00',
      targetEndDate: '  2026-09-011 ',
    })
    expect(query).toEqual({ startDate: '2026-09-01', targetEndDate: '2026-09-01' })
    expect(query.startDate!.length).toBeLessThanOrEqual(DATE_FILTER_MAX)
  })

  it('does not invent an absent date filter', () => {
    expect(toIterationStatusQuery({})).toEqual({})
  })
})
