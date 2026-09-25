/**
 * `useDetailTab` — the tab lives in the URL, because Back can only return the reader to a place the
 * history entry describes (DE-19 / US-93 TC-23 AC1).
 *
 * The router is mocked at the boundary this hook actually uses: the parsed location for reading and
 * `router.history.replace` for writing. What the assertions care about is the HREF written, since
 * that href IS the history entry Back will restore — a test that only checked internal state would
 * pass for the implementation this replaces.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const replace = vi.fn()
let location = {
  pathname: '/item/US-39',
  searchStr: '',
  search: {} as Record<string, unknown>,
}

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ history: { replace } }),
  useRouterState: ({ select }: { select: (s: { location: typeof location }) => unknown }) =>
    select({ location }),
}))

import { useDetailTab } from './use-detail-tab'

const TABS = ['details', 'tasks', 'test-cases', 'history'] as const

beforeEach(() => {
  vi.clearAllMocks()
  location = { pathname: '/item/US-39', searchStr: '', search: {} }
})

describe('useDetailTab', () => {
  it('falls back to the default when the URL names no tab', () => {
    const { result } = renderHook(() => useDetailTab(TABS, 'details'))

    expect(result.current[0]).toBe('details')
  })

  it('reads the tab the URL names — the whole point: a restored entry restores the tab', () => {
    location = {
      pathname: '/item/US-39',
      searchStr: '?tab=test-cases',
      search: { tab: 'test-cases' },
    }
    const { result } = renderHook(() => useDetailTab(TABS, 'details'))

    expect(result.current[0]).toBe('test-cases')
  })

  it('ignores a tab this page does not have, rather than rendering nothing', () => {
    location = { pathname: '/item/US-39', searchStr: '?tab=nonsense', search: { tab: 'nonsense' } }
    const { result } = renderHook(() => useDetailTab(TABS, 'details'))

    expect(result.current[0]).toBe('details')
  })

  it('REPLACES the current entry when a tab is selected, so Back stays one page away', () => {
    const { result } = renderHook(() => useDetailTab(TABS, 'details'))

    result.current[1]('test-cases')

    expect(replace).toHaveBeenCalledWith('/item/US-39?tab=test-cases')
  })

  it('drops the parameter for the default tab, so a record has one canonical URL', () => {
    location = {
      pathname: '/item/US-39',
      searchStr: '?tab=test-cases',
      search: { tab: 'test-cases' },
    }
    const { result } = renderHook(() => useDetailTab(TABS, 'details'))

    result.current[1]('details')

    expect(replace).toHaveBeenCalledWith('/item/US-39')
  })

  it('keeps any other search parameter the URL carries', () => {
    location = { pathname: '/item/US-39', searchStr: '?from=iteration', search: {} }
    const { result } = renderHook(() => useDetailTab(TABS, 'details'))

    result.current[1]('history')

    expect(replace).toHaveBeenCalledWith('/item/US-39?from=iteration&tab=history')
  })
})
