/**
 * Velocity — a failed request must not read as a measured statement about delivery history.
 *
 * `isError` was never destructured here, so on failure `bars` fell to `[]` and `ChartFrame` rendered
 * §6's own empty-state sentence — "No completed iteration with scheduled work exists in this project
 * and team scope". That is a conclusion about the project, drawn from a network fault. Team Capacity
 * had the same defect and fixed it; this pins the same contract on the sibling report.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

vi.mock('@/shared/api/http-client', () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}))

import { apiClient } from '@/shared/api/http-client'
import { VelocityReport } from './velocity-report'

const mockGET = apiClient.GET as ReturnType<typeof vi.fn>

const REPORT = {
  context: { projectName: 'NXP', teamName: 'All Teams' },
  window: 5,
  bars: [
    {
      iterationId: 'it-1',
      name: 'Sprint 26.1',
      acceptedDuring: 34,
      acceptedAfter: 4,
      notAccepted: 9,
      splitCarryover: 0,
      splitStoryIds: [],
    },
  ],
  averages: { last3: 34, best3: 34, worst3: 34, trend: 34, sampleSize: 1 },
  unclassifiedItems: 0,
}

/** The same window with one story carried forward by a Split — SU-09's fourth segment. */
const WITH_CARRYOVER = {
  ...REPORT,
  bars: [
    {
      ...REPORT.bars[0],
      splitCarryover: 13,
      splitStoryIds: ['11111111-1111-1111-1111-111111111111'],
    },
  ],
}

function renderReport() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return render(<VelocityReport projectId="p-1" teamId={undefined} />, { wrapper: Wrapper })
}

describe('VelocityReport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGET.mockResolvedValue({ data: REPORT, error: undefined, response: { status: 200 } })
  })

  it('renders the bars and the trend when the query succeeds', async () => {
    renderReport()
    // i18n is not initialised under test, so `t()` yields the raw key — asserting on English copy
    // would make this a translation-file change detector.
    await waitFor(() => expect(screen.getByText('velocity.last3')).toBeInTheDocument())
  })

  it('renders the ERROR state, not "no completed iterations", when the query fails', async () => {
    mockGET.mockResolvedValue({
      data: undefined,
      error: { message: 'boom' },
      response: { status: 500 },
    })
    renderReport()

    await waitFor(() => expect(screen.getByText('velocity.error.title')).toBeInTheDocument())
    // The bug: the SRS's own data sentence standing in for a network fault.
    expect(screen.queryByText('velocity.empty.title')).not.toBeInTheDocument()
    expect(screen.queryByText('velocity.empty.description')).not.toBeInTheDocument()
  })

  it('drops the averages strip on failure rather than showing fabricated numbers', async () => {
    // The strip is conditional on `averages.sampleSize > 0`, so it already vanishes — this pins that
    // it does not somehow survive beside the error, which is what happened on Team Capacity.
    mockGET.mockResolvedValue({
      data: undefined,
      error: { message: 'boom' },
      response: { status: 500 },
    })
    renderReport()

    await waitFor(() => expect(screen.getByText('velocity.error.title')).toBeInTheDocument())
    expect(screen.queryByText('velocity.last3')).not.toBeInTheDocument()
  })

  it('keeps the title and window control mounted while loading', async () => {
    mockGET.mockReturnValue(new Promise(() => {}))
    renderReport()
    expect(screen.getByText('velocity.title')).toBeInTheDocument()
  })

  // ── the excluded Split / Carryover segment (SU-09 9.4, AC1/AC5) ─────────────

  it('names the excluded segment in the legend whether or not the window has a Split', async () => {
    // Unconditional on purpose: it is a segment of a shared scale, so a key that appeared only in
    // windows containing a Split would change between two renders of the same report.
    renderReport()
    await waitFor(() =>
      expect(screen.getAllByText('velocity.series.splitCarryover').length).toBeGreaterThan(0),
    )
  })

  it('puts the carried-forward points in the hidden data table, so the amber is not colour-only', async () => {
    mockGET.mockResolvedValue({
      data: WITH_CARRYOVER,
      error: undefined,
      response: { status: 200 },
    })
    renderReport()

    // The fifth column heading, and the value under it. `getAllBy…` because the legend carries the
    // same label — that duplication is the point of having both.
    await waitFor(() =>
      expect(
        screen.getAllByRole('columnheader', { name: 'velocity.series.splitCarryover' }),
      ).toHaveLength(1),
    )
    const row = screen.getByRole('row', { name: /Sprint 26\.1/ })
    expect(row).toHaveTextContent('13')
  })

  it('states how many stories were carried forward, and says nothing when none were', async () => {
    /**
     * The footnote reads `splitStoryIds.length`, so this is also what pins that field having a
     * consumer. It is amber and iconless, unlike the `unclassified` line above it: a Split is a
     * recorded fact, not a fault.
     */
    mockGET.mockResolvedValue({
      data: WITH_CARRYOVER,
      error: undefined,
      response: { status: 200 },
    })
    const carried = renderReport()
    await waitFor(() => expect(screen.getByText('velocity.splitCarryoverNote')).toBeInTheDocument())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    carried.unmount()

    mockGET.mockResolvedValue({ data: REPORT, error: undefined, response: { status: 200 } })
    renderReport()
    await waitFor(() => expect(screen.getByText('velocity.title')).toBeInTheDocument())
    expect(screen.queryByText('velocity.splitCarryoverNote')).not.toBeInTheDocument()
  })
})
