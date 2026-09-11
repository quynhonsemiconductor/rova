import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

vi.mock('@/shared/api/http-client', () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}))

import { apiClient } from '@/shared/api/http-client'
import { testCaseKeys, useUpdateTestCase, type TestCase } from './api'

const mockPATCH = apiClient.PATCH as ReturnType<typeof vi.fn>

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
}

function makeWrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

const testCase = (over: Partial<TestCase> = {}): TestCase =>
  ({
    id: 'tc-1',
    testCaseKey: 'TC-1',
    name: 'User can log in',
    workItemId: 'wi-1',
    projectId: 'proj-1',
    teamId: null,
    ...over,
  }) as unknown as TestCase

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useUpdateTestCase', () => {
  /**
   * The bug: inline edits on the Test Cases TAB (Name/Type/Method/Priority/Owner — all call this
   * same mutation) correctly patched the server and the Detail page's own two caches
   * (`testCaseKeys.detail`/`byKey`), but never touched `testCaseKeys.list(workItemId)` — the THIRD
   * query the tab's grid actually reads — so the grid kept showing the stale row until a full
   * page refresh re-fetched everything from scratch.
   */
  it("invalidates the Test Cases TAB's list query, not just the Detail page's own caches", async () => {
    const updated = testCase({ name: 'User can log in securely' })
    mockPATCH.mockResolvedValue({ data: updated, error: undefined, response: { status: 200 } })
    const qc = makeClient()

    // Seed the list query exactly as `useTestCases('wi-1')` would have on the tab, with the OLD
    // row — the state the grid was stuck showing.
    qc.setQueryData(testCaseKeys.list('wi-1'), [testCase({ name: 'User can log in' })])
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')

    const { result } = renderHook(() => useUpdateTestCase('tc-1'), { wrapper: makeWrapper(qc) })
    result.current.mutate({ name: 'User can log in securely' })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: testCaseKeys.list('wi-1') })
    // The invalidation actually marks the cached list stale (not merely called-with, which would
    // pass even if the key shape silently drifted from what `useTestCases` reads).
    expect(qc.getQueryState(testCaseKeys.list('wi-1'))?.isInvalidated).toBe(true)
  })

  it("still writes the Detail page's own two caches (unchanged behaviour)", async () => {
    const updated = testCase({ name: 'Renamed' })
    mockPATCH.mockResolvedValue({ data: updated, error: undefined, response: { status: 200 } })
    const qc = makeClient()

    // `setQueriesData` only writes queries that already EXIST in the cache (it does not create
    // one), so this seeds both the way `useTestCaseByKey`/`useTestCase` would have if the Detail
    // page were mounted — the scenario this write actually serves.
    qc.setQueryData(testCaseKeys.detail('tc-1'), testCase())
    qc.setQueryData(testCaseKeys.byKey('TC-1'), testCase())

    const { result } = renderHook(() => useUpdateTestCase('tc-1'), { wrapper: makeWrapper(qc) })
    result.current.mutate({ name: 'Renamed' })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(qc.getQueryData(testCaseKeys.detail('tc-1'))).toEqual(updated)
    expect(qc.getQueryData(testCaseKeys.byKey('TC-1'))).toEqual(updated)
  })
})
