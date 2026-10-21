/** `useRecordHref` reports a lost URL from an effect, once, and only for a cell that can open. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { resetReportedForTests } from '@/shared/lib/report-once'
import { useRecordHref } from './use-record-href'

beforeEach(() => {
  resetReportedForTests()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('useRecordHref', () => {
  it('returns the derived URL and reports nothing for a well-formed record', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { result } = renderHook(() =>
      useRecordHref({ href: undefined, type: 'story', itemKey: 'US-1', enabled: true }),
    )
    expect(result.current).toBe('/item/US-1')
    expect(warn).not.toHaveBeenCalled()
  })

  it('reports a cell that lost its URL once, however often it re-renders', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { result, rerender } = renderHook(() =>
      useRecordHref({ href: undefined, type: 'Story', itemKey: 'US-1', enabled: true }),
    )
    rerender()
    rerender()
    expect(result.current).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"Story"'))
  })

  it('stays silent for a read-only cell, which ignores the URL anyway', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { result } = renderHook(() =>
      useRecordHref({ href: undefined, type: 'Story', itemKey: 'US-1', enabled: false }),
    )
    expect(result.current).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not report when the caller passed its own URL', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { result } = renderHook(() =>
      useRecordHref({ href: '/timeboxes/it-1', type: 'iteration', itemKey: 'IT-1', enabled: true }),
    )
    expect(result.current).toBe('/timeboxes/it-1')
    expect(warn).not.toHaveBeenCalled()
  })
})
