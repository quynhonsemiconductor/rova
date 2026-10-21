/** A silent-degradation defect is reported once per key for the whole page, not once per cell. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reportOnce } from './report-once'

describe('reportOnce', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // The Set is module-level, so every key here is unique to this test: order-independent.
  it('reports a key once, however many callers hit it (warning in development)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (let i = 0; i < 50; i += 1) reportOnce('report-once-test:a', 'broken path builder')
    reportOnce('report-once-test:b', 'another defect')
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenNthCalledWith(1, 'broken path builder')
  })
})
