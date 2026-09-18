/**
 * Iteration Burndown — a failed request must not read as a measured statement about the sprint.
 *
 * `isError` was never destructured here, so on failure `data` stayed undefined and the report fell
 * through to `burndown.empty.noHistory` — "no daily history has been recorded". That is a claim about
 * what was measured during the iteration, drawn from a network fault. §5 makes only MISSING SNAPSHOTS
 * unavailable, and a 500 is not a missing snapshot.
 *
 * Third instance of one shape: Velocity and Team Capacity had it and fixed it. This pins the contract
 * on the last report that still had it.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

vi.mock('@/shared/api/http-client', () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}))

import { apiClient } from '@/shared/api/http-client'
import { IterationBurndownReport } from './iteration-burndown-report'

const mockGET = apiClient.GET as ReturnType<typeof vi.fn>

const ITERATIONS = [
  { id: 'it-1', name: 'Sprint 26.1', state: 'committed', projectId: 'p-1', teamId: null },
]

const BURNDOWN = {
  context: { projectName: 'NXP', teamName: null },
  iterationId: 'it-1',
  historyState: 'complete',
  hasScheduledWork: true,
  totalTaskEstimateAtStart: 80,
  status: 'on-track',
  partialCaptureDates: [],
  days: [{ date: '2026-08-01', remainingToDo: 80, ideal: 80 }],
}

/**
 * Two endpoints answer here — the iteration list and the burndown itself — and only the second is
 * under test. Routed by URL so a failure can be injected into the report's query while the picker
 * still populates; otherwise "no iteration selected" would mask the state being asserted.
 */
function mockRoutes({
  burndownFails,
  iterationsFail = false,
}: {
  burndownFails: boolean
  /**
   * Fail the PICKER's endpoint instead of the report's.
   *
   * The two tests above keep this healthy, and that is precisely why they could not see the second
   * half of the same defect: with an empty picker the report short-circuits to
   * `burndown.empty.noIteration` — "Select an iteration to see its burndown" — which is an
   * AFFORDANCE INSTRUCTION standing in for a network fault, with no iteration available to obey it
   * with. This file's own subject docblock claimed the shape was closed while that path was live.
   */
  iterationsFail?: boolean
}) {
  const failure = {
    data: undefined,
    error: { message: 'boom' },
    response: { status: 500 },
  }
  mockGET.mockImplementation((url: string) => {
    if (url.includes('burndown')) {
      return burndownFails
        ? Promise.resolve(failure)
        : Promise.resolve({ data: BURNDOWN, error: undefined, response: { status: 200 } })
    }
    // `GET /iterations/options` — the REFERENCE feed, a bare array (not a page). The picker moved
    // off `GET /iterations` because that route is the timebox RECORD and carries `timebox:view`.
    return iterationsFail
      ? Promise.resolve(failure)
      : Promise.resolve({ data: ITERATIONS, error: undefined, response: { status: 200 } })
  })
}

function renderReport() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return render(<IterationBurndownReport projectId="p-1" teamId={undefined} />, {
    wrapper: Wrapper,
  })
}

describe('IterationBurndownReport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the ERROR state, not "no daily history", when the burndown query fails', async () => {
    mockRoutes({ burndownFails: true })
    renderReport()

    // i18n is not initialised under test, so `t()` yields the raw key — asserting on English copy
    // would make this a translation-file change detector.
    await waitFor(() => expect(screen.getByText('burndown.error.title')).toBeInTheDocument())

    // The bug: §5's own data sentences standing in for a network fault.
    expect(screen.queryByText('burndown.empty.noHistory')).not.toBeInTheDocument()
    expect(screen.queryByText('burndown.empty.noScheduledWork')).not.toBeInTheDocument()
  })

  it('drops the on-track verdict on failure rather than judging the sprint anyway', async () => {
    // The status pill lives in `controls`, which `ReportSurface` renders ABOVE the error slot — the
    // shape that once left four `0h` cards sitting over an error message on Team Capacity. A verdict
    // is the worst thing to keep: it is a conclusion, and there is no data behind it.
    mockRoutes({ burndownFails: true })
    renderReport()

    await waitFor(() => expect(screen.getByText('burndown.error.title')).toBeInTheDocument())
    expect(screen.queryByText('burndown.onTrack')).not.toBeInTheDocument()
    expect(screen.queryByText('burndown.behindPlan')).not.toBeInTheDocument()
  })

  it('keeps the title mounted while loading', () => {
    mockGET.mockReturnValue(new Promise(() => {}))
    renderReport()
    expect(screen.getByText('burndown.title')).toBeInTheDocument()
  })

  it('reports a failed ITERATION LIST as a failure, not as "select an iteration"', async () => {
    // The picker's own feed. `const { data: allIterations = [] } = useIterations(projectId)` made a
    // 500 on the iteration feed indistinguishable from a project with no timeboxes, and the body
    // then instructed the reader to pick one from an empty picker.
    mockRoutes({ burndownFails: false, iterationsFail: true })
    renderReport()

    await waitFor(() => expect(screen.getByText('timeboxFeedError.title')).toBeInTheDocument())
    expect(screen.queryByText('burndown.empty.noIteration')).not.toBeInTheDocument()
    // And no verdict about a sprint that was never read.
    expect(screen.queryByText('burndown.onTrack')).not.toBeInTheDocument()
    expect(screen.queryByText('burndown.behindPlan')).not.toBeInTheDocument()
  })

  it('still shows "select an iteration" when the project genuinely has none', async () => {
    // The other half of the contract: separating error from empty must not delete the empty state.
    mockGET.mockImplementation((url: string) =>
      url.includes('burndown')
        ? Promise.resolve({ data: BURNDOWN, error: undefined, response: { status: 200 } })
        : Promise.resolve({ data: [], error: undefined, response: { status: 200 } }),
    )
    renderReport()

    await waitFor(() => expect(screen.getByText('burndown.empty.noIteration')).toBeInTheDocument())
    expect(screen.queryByText('timeboxFeedError.title')).not.toBeInTheDocument()
  })

  // ── Split annotations (SU-08 8.3) ──────────────────────────────────────────

  /**
   * A burndown with a PLOTTED series, which the fixture above deliberately lacks.
   *
   * `ChartFrame` renders `underAxis` only when the chart is not empty, so the marker strip cannot be
   * asserted against an empty series — and that is correct behaviour rather than a test workaround: an
   * annotation on a chart with no days would point at nothing.
   */
  const WITH_SERIES = {
    ...BURNDOWN,
    points: [
      { date: '2026-08-01', remainingToDo: 80, ideal: 80, acceptedPoints: 0 },
      { date: '2026-08-02', remainingToDo: 60, ideal: 60, acceptedPoints: 3 },
    ],
    splitOut: [
      {
        splitId: 'split-1',
        kind: 'split-out',
        date: '2026-08-02',
        storyId: 'wi-2',
        storyKey: 'US-9',
        points: 2,
        todoHours: 7,
        actualHours: 5,
      },
    ],
    carryIn: [],
  }

  function mockBurndown(body: unknown) {
    mockGET.mockImplementation((url: string) =>
      url.includes('burndown')
        ? Promise.resolve({ data: body, error: undefined, response: { status: 200 } })
        : Promise.resolve({ data: ITERATIONS, error: undefined, response: { status: 200 } }),
    )
  }

  it('renders the SPLIT OUT context and its legend entry from the response', async () => {
    // i18n is not initialised in this file, so `t()` yields raw keys — which is all this test needs:
    // the SENTENCE is pinned in `split-markers.test.tsx` with real copy. What is asserted here is the
    // WIRING, i.e. that the response's arrays reach the chart frame at all.
    mockBurndown(WITH_SERIES)
    renderReport()

    await waitFor(() => expect(screen.getByText(/markers.splitOutContext/)).toBeInTheDocument())
    expect(screen.getByText(/markers\.legendSplitOut/)).toBeInTheDocument()
    // Only the direction present: the response carries no carry-in.
    expect(screen.queryByText(/markers\.legendCarryIn/)).not.toBeInTheDocument()
    expect(screen.queryByText(/markers\.carryInContext/)).not.toBeInTheDocument()
  })

  it('adds nothing for a timebox no Split touched', async () => {
    // Every timebox before Phase 7, and the response omits the arrays entirely here — so this also
    // pins that an older cached body cannot take the chart down.
    mockBurndown({ ...BURNDOWN, points: WITH_SERIES.points })
    renderReport()

    await waitFor(() => expect(screen.getByText('burndown.title')).toBeInTheDocument())
    expect(screen.queryByText(/markers\.legendSplitOut/)).not.toBeInTheDocument()
    expect(screen.queryByText(/markers\.legendCarryIn/)).not.toBeInTheDocument()
    expect(screen.queryByText(/markers\./)).not.toBeInTheDocument()
  })
})
