/**
 * Team Status — what is editable, the state control, and the one load formula.
 *
 * US-145 (BA) reverses two earlier readings that this file used to pin:
 * - Estimate / To Do / Actuals are inline editable on the task rows (were reads per FR-026 / §11).
 *   They write through `PATCH /v1/work-items/:id`, never the Team Status task route. Owner stays a
 *   read (FR-027): the rows are grouped by it.
 * - The member bar is LOAD — Estimate / Capacity — not hours burned (SRS §10's actual / estimate),
 *   which read 0% for every member with planned work and no Actuals logged.
 * And the bar must keep ONE formula under the State filter: it once switched to a completed-task
 * COUNT when filtered.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

vi.mock('@/shared/api/http-client', () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))

vi.mock('@/shared/lib/stores/app-context.store', () => ({
  useAppContext: () => ({ project: { projectId: 'p-1' }, team: { teamId: 't-1' } }),
}))

/**
 * Edit rights, mutable per test.
 *
 * Full rights are the DEFAULT deliberately: a read-only field must be read-only for the MOST
 * privileged caller, or the assertion only proves the permission gate works. `grantedCodes` is for
 * the opposite case — `P3-TS-FR-039`'s Editor, who holds `team_status:view` and not
 * `team_status:edit`.
 */
const grantedCodes: { deny?: string } = {}
vi.mock('@/features/access/api', () => ({
  useProjectPermissions: () => ({ can: (code: string) => code !== grantedCodes.deny }),
}))

/**
 * The iteration feed, mutable per test.
 *
 * Fixed-healthy is why this file could not see the third defect on this page: the guard
 * `if (!iterations.length)` printed "No iterations in this project/team yet." **plus a
 * "Go to Timeboxes →" button**, so a failed `/v1/iterations` sent the reader off to create a sprint
 * that already exists — a fabricated fact AND a wrong call to action, the same pair Release
 * Tracking shipped.
 */
const ITERATION = {
  id: 'it-1',
  name: 'Sprint 26.1',
  teamId: 't-1',
  startDate: '2026-07-01',
  endDate: '2026-07-14',
  state: 'committed',
}
const iterationFeed: {
  data?: (typeof ITERATION)[]
  isError?: boolean
  error?: unknown
  isLoading?: boolean
} = { data: [ITERATION] }
vi.mock('@/features/iterations/api', () => ({
  // The REFERENCE feed, not the timebox record — §5 grants an Editor Team Status, and
  // `GET /iterations` is `timebox:view`.
  useIterationOptions: () => iterationFeed,
}))

import { apiClient } from '@/shared/api/http-client'
import { TeamStatusPage } from './team-status-page'

const mockGET = apiClient.GET as ReturnType<typeof vi.fn>
const mockPATCH = apiClient.PATCH as ReturnType<typeof vi.fn>

/**
 * Alice owns two tasks against 40h of capacity. The numbers are chosen so every candidate formula
 * DISAGREES under the filter: over the Completed task alone, load is 6/40 = 15%, the old
 * actual / estimate is 3/6 = 50% and the completed-count ratio 1/1 = 100%. Unfiltered, the
 * server's load is 10/40 = 25%.
 */
const TEAM_STATUS = {
  projectId: 'p-1',
  teamId: 't-1',
  iteration: { id: 'it-1', name: 'Sprint 26.1', startDate: '2026-07-01', endDate: '2026-07-14' },
  totals: { capacityHours: 40, estimateHours: 10, todoHours: 7, actualHours: 3 },
  groups: [
    {
      owner: { id: 'u-1', displayName: 'Alice Smith', avatarUrl: null },
      capacityHours: 40,
      taskCount: 2,
      estimateHours: 10,
      todoHours: 7,
      actualHours: 3,
      progressPercent: 25,
      tasks: [
        {
          id: 'ta-1',
          taskKey: 'TA-1',
          title: 'DEV - wire SSO',
          displayName: 'DEV - wire SSO',
          workProduct: { id: 's-1', key: 'US-1', type: 'Story', title: 'Auth', status: 'accepted' },
          release: null,
          state: 'Completed',
          estimateHours: 6,
          todoHours: 5,
          actualHours: 3,
          owner: { id: 'u-1', displayName: 'Alice Smith', avatarUrl: null },
          rank: 'a1',
        },
        {
          id: 'ta-2',
          taskKey: 'TA-2',
          title: 'QA - regression pass',
          displayName: 'QA - regression pass',
          workProduct: { id: 's-1', key: 'US-1', type: 'Story', title: 'Auth', status: 'accepted' },
          release: null,
          state: 'Defined',
          estimateHours: 4,
          todoHours: 2,
          actualHours: 0,
          owner: { id: 'u-1', displayName: 'Alice Smith', avatarUrl: null },
          rank: 'a2',
        },
      ],
    },
  ],
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return render(<TeamStatusPage />, { wrapper })
}

/** Expand Alice's member group so her task rows render. */
async function expandAlice() {
  const member = await screen.findByText('Alice Smith')
  fireEvent.click(member)
}

beforeEach(() => {
  grantedCodes.deny = undefined
  vi.clearAllMocks()
  localStorage.clear()
  iterationFeed.data = [ITERATION]
  iterationFeed.isError = false
  iterationFeed.error = undefined
  iterationFeed.isLoading = false
  mockGET.mockResolvedValue({ data: TEAM_STATUS, error: undefined, response: { status: 200 } })
})

describe('Team Status — a failed iteration feed is not an empty project', () => {
  it('reports the failure and does NOT claim there are no iterations, nor send the reader to Timeboxes', async () => {
    iterationFeed.data = undefined
    iterationFeed.isError = true
    iterationFeed.error = new Error('boom')
    renderPage()

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    // The fabricated fact and its wrong call to action must both be ABSENT, not accompanied.
    expect(screen.queryByText('No iterations in this project/team yet.')).not.toBeInTheDocument()
    expect(screen.queryByText(/Go to Timeboxes/)).not.toBeInTheDocument()
  })

  it('still says there are no iterations when the server really answered with none', async () => {
    iterationFeed.data = []
    renderPage()

    expect(await screen.findByText('No iterations in this project/team yet.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('Team Status task hours are inline editable (US-145)', () => {
  it('opens an editor for Task Name AND for Estimate, To Do and Actuals; Owner stays a read', async () => {
    const { container } = renderPage()
    await expandAlice()
    await screen.findByText('DEV - wire SSO')

    /**
     * `.inline-edit-cell` is the hover affordance `InlineEditableCell` adds only when the cell is
     * editable, so counting it counts the editors on screen: the member group's Capacity, then per
     * task row Task Name + Estimate + To Do + Actuals — 1 + 2 × 4 = 9. It was 3 while the BA's
     * earlier reading kept the hours read-only on this surface.
     */
    expect(container.querySelectorAll('.inline-edit-cell')).toHaveLength(9)
    // Owner is still a read: the rows are GROUPED by owner (FR-027).
    expect(screen.queryByRole('combobox', { name: /owner/i })).toBeNull()
  })

  it('writes Estimate through the work-item route, ALONE', async () => {
    mockPATCH.mockResolvedValue({
      data: { id: 'ta-1', itemKey: 'TA-1', projectId: 'p-1' },
      error: undefined,
      response: { status: 200 },
    })
    renderPage()
    await expandAlice()
    await screen.findByText('DEV - wire SSO')

    fireEvent.click(screen.getByText('6'))
    const input = await screen.findByRole('textbox', { name: 'Estimate' })
    fireEvent.change(input, { target: { value: '8' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    /**
     * `estimateHours` and nothing else — CLAUDE.md, "Editing Estimate on Team Status must send
     * `estimateHours` ALONE": a `todoHours` beside it would bypass the service's once-only copy gate
     * and re-inflate a completed task's auto-zeroed To Do. And the WORK-ITEM route, not
     * `/team-status/tasks/:id`, which refuses hours (`.strict()`).
     */
    await waitFor(() =>
      expect(mockPATCH).toHaveBeenCalledWith('/v1/work-items/{id}', {
        params: { path: { id: 'ta-1' } },
        body: { estimateHours: 8 },
      }),
    )
  })

  it('renders a never-entered hour as `--`, not 0 — the state a cleared cell refetches into', async () => {
    const [alice] = TEAM_STATUS.groups
    mockGET.mockResolvedValue({
      data: {
        ...TEAM_STATUS,
        groups: [
          {
            ...alice,
            tasks: [{ ...alice.tasks[0], estimateHours: null }, alice.tasks[1]],
          },
        ],
      },
      error: undefined,
      response: { status: 200 },
    })
    renderPage()
    await expandAlice()
    await screen.findByText('DEV - wire SSO')

    // TA-1's Estimate cell shows the empty marker; its old value (6) is gone from the grid.
    expect(screen.getAllByText('--').length).toBeGreaterThan(0)
    expect(screen.queryByText('6')).toBeNull()
  })

  it('sends null, not 0, when an hour cell is cleared', async () => {
    mockPATCH.mockResolvedValue({
      data: { id: 'ta-1', itemKey: 'TA-1', projectId: 'p-1' },
      error: undefined,
      response: { status: 200 },
    })
    renderPage()
    await expandAlice()
    await screen.findByText('DEV - wire SSO')

    fireEvent.click(screen.getByText('6'))
    const input = await screen.findByRole('textbox', { name: 'Estimate' })
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() =>
      expect(mockPATCH).toHaveBeenCalledWith('/v1/work-items/{id}', {
        params: { path: { id: 'ta-1' } },
        body: { estimateHours: null },
      }),
    )
  })

  it('offers no hours editor to a caller without work_item:edit', async () => {
    grantedCodes.deny = 'work_item:edit'
    const { container } = renderPage()
    await expandAlice()
    await screen.findByText('DEV - wire SSO')

    // Capacity + two Task Names (team_status:edit) remain; the six hour cells are values.
    expect(container.querySelectorAll('.inline-edit-cell')).toHaveLength(3)
    fireEvent.click(screen.getByText('6'))
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})

describe('Team Status task state matches the rest of the app', () => {
  it('renders the shared stepper with its letter in the current box, like Iteration Status', async () => {
    renderPage()
    await expandAlice()
    await screen.findByText('DEV - wire SSO')

    // Same D / I / C first-letter rule as `SIMPLIFIED_STATE_STEPS`; the value is in the name.
    const completed = screen.getByRole('group', { name: 'Task state: Completed' })
    const defined = screen.getByRole('group', { name: 'Task state: Defined' })
    expect(completed.querySelector('[data-current="true"]')?.textContent).toBe('C')
    expect(defined.querySelector('[data-current="true"]')?.textContent).toBe('D')
  })
})

/**
 * GAP-P3-TS-008 makes this group far more reachable: an off-roster owner's task now lands under
 * `Unassigned` rather than in a named group of its own, so a Capacity cell that could only ever fail
 * would be hit routinely. `owner.id` is the literal `'unassigned'` and `UpdateCapacitySchema` requires
 * a uuid, so the edit was a guaranteed 400 with a bare "Validation failed" toast. The AC's own wording
 * is the rule: "Null-owner Tasks appear under Unassigned WITH 0h CAPACITY".
 */
describe('the Unassigned group has no capacity to plan', () => {
  const UNASSIGNED_GROUP = {
    ...TEAM_STATUS,
    groups: [
      {
        ...TEAM_STATUS.groups[0],
        owner: { id: 'unassigned', displayName: 'Unassigned', avatarUrl: null },
        capacityHours: 0,
        progressPercent: 0,
      },
    ],
  }

  it('renders its Capacity as a value, not an editor, and its load as unmeasurable', async () => {
    mockGET.mockResolvedValue({
      data: UNASSIGNED_GROUP,
      error: undefined,
      response: { status: 200 },
    })
    const { container } = renderPage()
    fireEvent.click(await screen.findByText('Unassigned'))
    await screen.findByText('DEV - wire SSO')

    // Two Task Names + 2 × 3 hour cells remain editable — the group Capacity is gone from the count.
    expect(container.querySelectorAll('.inline-edit-cell')).toHaveLength(8)
    expect(screen.queryByRole('textbox', { name: 'Capacity' })).toBeNull()
    // No capacity → no load to measure: `--` with a reason, never a `0%` that reads as "nothing planned".
    expect(screen.getByTitle(/Capacity not set/)).toBeTruthy()
    expect(screen.queryByText('0%')).toBeNull()
  })
})

describe('the member load bar is Estimate / Capacity, and keeps ONE formula under a filter', () => {
  it("shows the server's load unfiltered", async () => {
    renderPage()
    expect(await screen.findByText('25%')).toBeTruthy()
  })

  it('re-measures the SAME formula over the filtered rows — not a task count, not Actuals', async () => {
    renderPage()
    await screen.findByText('25%')

    // The State filter lives behind the shared toolbar's Filters disclosure (FR-007A).
    fireEvent.click(screen.getByRole('button', { name: /filters/i }))
    fireEvent.change(await screen.findByLabelText('Filter by task state'), {
      target: { value: 'Completed' },
    })

    // 6h estimate / 40h capacity over the one visible task = 15%. The task-count ratio would read
    // 100% and the old actual / estimate formula 50%.
    await waitFor(() => expect(screen.getByText('15%')).toBeTruthy())
    expect(screen.queryByText('100%')).toBeNull()
    expect(screen.queryByText('50%')).toBeNull()
  })

  it('reads an over-committed member above 100%, in red', async () => {
    mockGET.mockResolvedValue({
      data: {
        ...TEAM_STATUS,
        groups: [{ ...TEAM_STATUS.groups[0], capacityHours: 8, progressPercent: 125 }],
      },
      error: undefined,
      response: { status: 200 },
    })
    renderPage()
    const label = await screen.findByText('125%')
    expect(label.className).toMatch(/text-destructive/)
  })
})

describe('P3-TS-FR-039 — an Editor gets Team Status read-only', () => {
  /**
   * "Editor may access Team Status for assigned Project/Team scope in read-only mode; Team Status
   * mutation is rejected."
   *
   * `editor` holds `team_status:view` and deliberately not `team_status:edit`, so both writes on
   * this screen (`PATCH /team-status/capacity`, `PATCH /team-status/tasks/:taskId`) answer 403. This
   * asserts the SCREEN agrees: a control that is offered and then refused is the failure mode this
   * repo keeps finding, and it reads to the user as the save silently not sticking.
   *
   * The task HOURS are not a Team Status mutation: they write through `PATCH /v1/work-items/:id`,
   * gated on `work_item:edit`, which an Editor holds — the same cells they already edit on Iteration
   * Status and the Tasks tab. So they stay editable here, and that is asserted, not tolerated.
   */
  it('offers no capacity editor, no task-name editor and a disabled Task State control', async () => {
    grantedCodes.deny = 'team_status:edit'
    mockGET.mockResolvedValue({
      data: TEAM_STATUS,
      error: undefined,
      response: { status: 200 },
    })
    const { container } = renderPage()
    await expandAlice()
    await screen.findByText('DEV - wire SSO')

    // Only the 2 × 3 hour cells carry the editable affordance — no Capacity, no Task Name.
    expect(container.querySelectorAll('.inline-edit-cell')).toHaveLength(6)
    expect(screen.queryByRole('textbox', { name: 'Capacity' })).toBeNull()
    /**
     * Task State is the shared segmented stepper. Its read-only form still RENDERS — the reader
     * must be able to see the state they may not change — but it offers no control to press:
     * `StateStepper` emits a `<span>` per segment when it cannot act, deliberately, so a read-only
     * stepper does not put six dead buttons per row into the accessibility tree.
     */
    const steppers = screen.getAllByRole('group', { name: /^Task state/ })
    expect(steppers).toHaveLength(2)
    for (const stepper of steppers) {
      expect(stepper.querySelectorAll('button')).toHaveLength(0)
    }
  })
})
