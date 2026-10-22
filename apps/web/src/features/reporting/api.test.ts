/**
 * Reporting api helpers (PR #653 review): the export filename parser, the Blob error path, the
 * typed per-report export dispatch, the Direction row filter, the badge rule, and the request
 * timeout (its deadline, cleanup, relay and retry rule).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/shared/api/http-client', () => ({ apiClient: { GET: vi.fn() } }))

import { apiClient } from '@/shared/api/http-client'
import {
  downloadReportCsv,
  filenameFrom,
  hasCarryoverActivity,
  retryReport,
  rowsForDirection,
  withTimeout,
  type CarryoverRow,
  type CarryoverSummary,
} from './api'

const GET = apiClient.GET as unknown as ReturnType<typeof vi.fn>

describe('filenameFrom', () => {
  it('prefers RFC 5987 filename* (non-ASCII names)', () => {
    expect(
      filenameFrom(`attachment; filename="x.csv"; filename*=UTF-8''b%C3%A1o-c%C3%A1o.csv`, 'f.csv'),
    ).toBe('báo-cáo.csv')
  })
  it('reads the quoted form', () => {
    expect(filenameFrom('attachment; filename="carryover-NXP.csv"', 'f.csv')).toBe(
      'carryover-NXP.csv',
    )
  })
  it('reads the bare form', () => {
    expect(filenameFrom('attachment; filename=carryover.csv', 'f.csv')).toBe('carryover.csv')
  })
  it('falls back when absent', () => {
    expect(filenameFrom(null, 'f.csv')).toBe('f.csv')
  })
  it('falls through to the quoted form on a malformed % escape', () => {
    expect(filenameFrom(`attachment; filename*=UTF-8''bad%E0%A4; filename="ok.csv"`, 'f.csv')).toBe(
      'ok.csv',
    )
  })
  it('falls back when the header names no filename', () => {
    expect(filenameFrom('attachment', 'f.csv')).toBe('f.csv')
  })
})

describe('hasCarryoverActivity', () => {
  const summary = (carryIn: number, carryOut: number) =>
    ({ carryIn, carryOut, transferredTodoHours: 0 }) as unknown as CarryoverSummary
  it.each([
    [null, false],
    [undefined, false],
    [summary(0, 0), false],
    [summary(1, 0), true],
    [summary(0, 2), true],
  ])('%o → %s', (input, expected) => {
    expect(hasCarryoverActivity(input)).toBe(expected)
  })
})

describe('withTimeout', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('aborts with a TimeoutError at the deadline', () => {
    const { signal } = withTimeout()
    vi.advanceTimersByTime(30_000)
    expect(signal.aborted).toBe(true)
    expect((signal.reason as DOMException).name).toBe('TimeoutError')
  })
  it('done() clears the timer, so a finished request never aborts later', () => {
    const { signal, done } = withTimeout()
    done()
    vi.advanceTimersByTime(60_000)
    expect(signal.aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('is born aborted, with the caller’s reason, when the caller’s signal already is', () => {
    const outer = new AbortController()
    outer.abort('gone')
    const { signal } = withTimeout(outer.signal)
    expect(signal.aborted).toBe(true)
    expect(signal.reason).toBe('gone')
    // The already-aborted path cleared the timer too.
    expect(vi.getTimerCount()).toBe(0)
  })
  it('relays a later abort of the caller’s signal with its reason', () => {
    const outer = new AbortController()
    const { signal } = withTimeout(outer.signal)
    outer.abort('cancelled')
    expect(signal.reason).toBe('cancelled')
  })
  it('done() detaches the relay from the caller’s signal', () => {
    const outer = new AbortController()
    const remove = vi.spyOn(outer.signal, 'removeEventListener')
    const { signal, done } = withTimeout(outer.signal)
    done()
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    outer.abort('late')
    expect(signal.aborted).toBe(false)
  })
})

describe('retryReport', () => {
  it('never retries a timeout', () => {
    expect(retryReport(0, new DOMException('t', 'TimeoutError'))).toBe(false)
  })
  it('never retries a 4xx', () => {
    expect(retryReport(0, Object.assign(new Error('x'), { status: 403 }))).toBe(false)
  })
  it('retries any other failure once', () => {
    expect(retryReport(0, new Error('boom'))).toBe(true)
    expect(retryReport(1, new Error('boom'))).toBe(false)
  })
})

describe('rowsForDirection', () => {
  const row = (id: string, direction: 'in' | 'out') =>
    ({ transitionId: id, direction }) as CarryoverRow
  const rows = [row('a', 'in'), row('b', 'out')]
  it('keeps every row for All', () => {
    expect(rowsForDirection(rows, 'all')).toHaveLength(2)
  })
  it('keeps only rows labelled with the chosen Direction', () => {
    expect(rowsForDirection(rows, 'out').map((r) => r.transitionId)).toEqual(['b'])
  })
})

describe('downloadReportCsv', () => {
  beforeEach(() => {
    GET.mockReset()
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
  })

  it('calls the literal generated path for each report with its own query', async () => {
    GET.mockResolvedValue({
      data: new Blob(['a']),
      response: new Response(null, {
        headers: { 'content-disposition': 'attachment; filename="v.csv"' },
      }),
    })
    await downloadReportCsv({ report: 'velocity', projectId: 'p1', window: 5 })
    expect(GET).toHaveBeenCalledWith(
      '/v1/reports/velocity/export',
      expect.objectContaining({
        parseAs: 'blob',
        params: { query: { projectId: 'p1', teamId: undefined, window: 5 } },
      }),
    )
  })

  it('surfaces the SERVER message from a Blob error body', async () => {
    const body = JSON.stringify({
      error: { code: 'PROJECT_PERMISSION_DENIED', message: 'No export' },
    })
    GET.mockResolvedValue({
      error: new Blob([body]),
      response: new Response(null, { status: 403 }),
    })
    await expect(
      downloadReportCsv({
        report: 'carryover',
        projectId: 'p1',
        iterationId: 'i1',
        direction: 'in',
      }),
    ).rejects.toThrow('No export')
  })

  it('defers revoking the object URL until after the click', async () => {
    vi.useFakeTimers()
    GET.mockResolvedValue({ data: new Blob(['a']), response: new Response(null) })
    await downloadReportCsv({ report: 'capacity', projectId: 'p1', iterationId: 'i1' })
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x')
    vi.useRealTimers()
  })
})
