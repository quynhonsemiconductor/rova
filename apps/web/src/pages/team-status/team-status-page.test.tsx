/**
 * Team Status — the read-only contract, and the one progress formula (P23-14).
 *
 * Two defects are pinned here. The grid offered inline editors for Estimate, ToDo, Actuals and
 * Owner, which the SRS makes reads on this surface: §9.3's patch accepts "`title` and/or `state`",
 * §11's editable columns are Capacity / Task Name / Task State, FR-026 SHOWS the hours and FR-027
 * DISPLAYS the owner. (They stay editable on the Task Dashboard — Work Item Detail › Tasks tab,
 * FR-038 — which writes through the work-item route.) And the member progress bar switched FORMULA
 * under the State filter: hours-burned unfiltered, completed-task-COUNT filtered.
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

/**
 * Alice owns two tasks. The numbers are chosen so the two candidate progress formulas DISAGREE
 * under the filter: over the Completed task alone, hours give 3/6 = 50% while the completed-count
 * ratio gives 1/1 = 100%. Unfiltered, the server's own §10 value is 3/10 = 30%.
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
      progressPercent: 30,
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

describe('Team Status read-only fields', () => {
  it('opens an editor for Task Name but NOT for Estimate, ToDo or Actuals', async () => {
    const { container } = renderPage()
    await expandAlice()
    await screen.findByText('DEV - wire SSO')

    /**
     * `.inline-edit-cell` is the hover affordance `InlineEditableCell` adds only when the cell is
     * editable, so counting it counts the editors on screen. Expected: the member group's Capacity
     * (FR-017) plus one Task Name per task row (FR-019) — three. It was seven: each task row also
     * carried Estimate, ToDo and Actuals.
     */
    expect(container.querySelectorAll('.inline-edit-cell')).toHaveLength(3)

    // The Task State control stays (FR-021/AC-17); the Owner picker is gone (FR-027).
    // It is the shared segmented stepper now, so it is a `group`, not a `combobox`.
    expect(screen.getAllByRole('group', { name: 'Task state' })).toHaveLength(2)
    expect(screen.queryByRole('combobox', { name: /owner/i })).toBeNull()

    /**
     * FR-045 / SRS §5:87 — the state must read as a FULL label, never as a bare `D` / `P` / `C`.
     * Asserting the words is what pins the rule; asserting the control TYPE only pinned one way of
     * satisfying it, which is what this test used to do. The two fixture tasks are Completed and
     * Defined, so both labels must be on screen.
     */
    expect(screen.getByText('Completed')).toBeTruthy()
    expect(screen.getByText('Defined')).toBeTruthy()
  })

  it('renders the hours as values, not inputs, and never as a zero it cannot prove', async () => {
    renderPage()
    await expandAlice()
    await screen.findByText('DEV - wire SSO')

    // The numbers are still THERE — read-only is not invisible.
    expect(screen.getByText('6')).toBeTruthy()
    expect(screen.getByText('5')).toBeTruthy()
    // Clicking a value opens nothing: with the editors in place this rendered an
    // <input aria-label="Estimate hours">.
    fireEvent.click(screen.getByText('6'))
    expect(screen.queryByRole('textbox')).toBeNull()
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
      },
    ],
  }

  it('renders its Capacity as a value, not an editor, for a caller with full rights', async () => {
    mockGET.mockResolvedValue({
      data: UNASSIGNED_GROUP,
      error: undefined,
      response: { status: 200 },
    })
    const { container } = renderPage()
    fireEvent.click(await screen.findByText('Unassigned'))
    await screen.findByText('DEV - wire SSO')

    // Only the two Task Name cells remain editable — the group Capacity is gone from the count.
    expect(container.querySelectorAll('.inline-edit-cell')).toHaveLength(2)
    expect(screen.queryByRole('textbox', { name: 'Capacity' })).toBeNull()
  })
})

describe('the member progress bar keeps ONE formula under a filter', () => {
  it('shows the §10 hours ratio unfiltered', async () => {
    renderPage()
    expect(await screen.findByText('30%')).toBeTruthy()
  })

  it('re-measures the SAME formula over the filtered rows — not a task count', async () => {
    renderPage()
    await screen.findByText('30%')

    // The State filter lives behind the shared toolbar's Filters disclosure (FR-007A).
    fireEvent.click(screen.getByRole('button', { name: /filters/i }))
    fireEvent.change(await screen.findByLabelText('Filter by task state'), {
      target: { value: 'Completed' },
    })

    // 3 actual / 6 estimate over the one visible task. The count ratio the page used to switch to
    // would read 100% — one Completed task out of one visible.
    await waitFor(() => expect(screen.getByText('50%')).toBeTruthy())
    expect(screen.queryByText('100%')).toBeNull()
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

    // No cell carries the editable affordance at all — capacity on the member row, task name on the
    // task rows. The class is what `InlineEditableCell` adds only when `canEdit`.
    expect(container.querySelectorAll('.inline-edit-cell')).toHaveLength(0)
    expect(screen.queryByRole('textbox', { name: 'Capacity' })).toBeNull()
    /**
     * Task State is the shared segmented stepper. Its read-only form still RENDERS — the reader
     * must be able to see the state they may not change — but it offers no control to press:
     * `StateStepper` emits a `<span>` per segment when it cannot act, deliberately, so a read-only
     * stepper does not put six dead buttons per row into the accessibility tree.
     */
    const steppers = screen.getAllByRole('group', { name: 'Task state' })
    expect(steppers).toHaveLength(2)
    for (const stepper of steppers) {
      expect(stepper.querySelectorAll('button')).toHaveLength(0)
    }
    // And the full label is still shown (FR-045), read-only or not.
    expect(screen.getByText('Completed')).toBeTruthy()
    expect(screen.getByText('Defined')).toBeTruthy()
  })
})
