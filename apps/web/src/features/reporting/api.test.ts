/**
 * Reporting api helpers (PR #653 review): the export filename parser, the Blob error path, the
 * typed per-report export dispatch and the Direction row filter.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/shared/api/http-client', () => ({ apiClient: { GET: vi.fn() } }))

import { apiClient } from '@/shared/api/http-client'
import { downloadReportCsv, filenameFrom, rowsForDirection, type CarryoverRow } from './api'

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
