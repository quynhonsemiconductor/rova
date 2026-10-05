/**
 * The Tasks tab's two "read the RECORD, not the selection" rules.
 *
 *  1. P6-E2E-003 — the Project column is the item's own project. This tab already RECEIVES `projectId`
 *     and every other column reads the task row; the Project cell alone read `useAppContext()`, so a
 *     deep-linked or hover-preloaded item printed whichever project the reader last selected.
 *  2. GAP-P1-WID-007 — the inline Owner picker offers the ROW's Team's active members, per row,
 *     because a Task's team only DEFAULTS to its parent's and stays settable (SRS P1-04).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
// `work_item:delete` gates the bulk Delete control, which the route requires and `work_item:edit` does
// not grant. Permissive here; the control's own tests own the negative case.
vi.mock('@/features/access/api', () => ({ useProjectPermissions: () => ({ can: () => true }) }))

const recordProject = vi.fn()
const teamOwnerOptions = vi.fn()
const tasks = vi.fn()

vi.mock('@/shared/lib/deep-link-project', () => ({
  useRecordProject: (...args: unknown[]) => recordProject(...args),
}))
vi.mock('@/features/teams/api', () => ({
  useProjectTeams: () => ({
    data: [
      { id: 'team-1', name: 'Team Alpha', key: 'TA' },
      { id: 'team-2', name: 'Team Beta', key: 'TB' },
    ],
  }),
  // The project-wide feed stays the id→NAME source and always holds BOTH people, so a narrowed
  // picker can only come from `useTeamOwnerOptions`.
  useProjectMemberOptions: () => ({ data: [ALICE, BRUNO] }),
  useTeamOwnerOptions: (...args: unknown[]) => teamOwnerOptions(...args),
}))
vi.mock('@/features/work-items/api', () => ({
  useTasks: (...args: unknown[]) => tasks(...args),
  useTaskTotals: () => ({ data: undefined }),
  useUpdateWorkItem: () => ({ mutateAsync: vi.fn() }),
  useCreateTask: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRankAnyWorkItem: () => ({ mutate: vi.fn() }),
  useDeleteWorkItem: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

import '@/shared/i18n/i18n'
import { TasksTab } from './tasks-tab'
import type { WorkItem } from '@/features/work-items/api'

const ALICE = { userId: 'alice', displayName: 'Alice Smith', email: 'alice@qnsc.dev' }
const BRUNO = { userId: 'bruno', displayName: 'Bruno Beta', email: 'bruno@qnsc.dev' }

const task = (over: Partial<WorkItem> = {}): WorkItem =>
  ({
    id: 'ta-1',
    itemKey: 'TA-1',
    type: 'task',
    title: 'DEV - wire SSO',
    scheduleState: 'in_progress',
    projectId: 'proj-record',
    teamId: 'team-1',
    assigneeId: 'alice',
    estimateHours: 6,
    todoHours: 5,
    actualHours: 3,
    rank: 'a1',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  }) as unknown as WorkItem

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  recordProject.mockReturnValue({
    projectId: 'proj-record',
    projectKey: 'TEST',
    projectName: 'Test Project',
  })
  teamOwnerOptions.mockReturnValue({ data: [ALICE] })
  tasks.mockReturnValue({ data: [task()], isLoading: false, isError: false })
})

function renderTab() {
  return render(
    <TasksTab
      workItemId="wi-1"
      projectId="proj-record"
      parentTeamId="team-parent"
      readOnly={false}
    />,
  )
}

/**
 * Phase 7 CO-02 AC5 — the Task list shows the SAME persisted lifecycle dates Task Detail does: the
 * same row field, through the same read-only `DateField` and the same `Not set` placeholder the
 * sidebar uses (`detail-sidebar.test.tsx` "lifecycle dates" pins that side).
 */
describe('TasksTab — lifecycle dates (CO-02)', () => {
  it('renders Start Date and Actual End Date columns, read-only', () => {
    tasks.mockReturnValue({
      data: [task({ startDate: '2026-09-02', actualEndDate: '2026-09-05' } as Partial<WorkItem>)],
      isLoading: false,
      isError: false,
    })
    renderTab()
    expect(screen.getByText('Start Date')).toBeTruthy()
    expect(screen.getByText('Actual End Date')).toBeTruthy()
    expect(screen.getByText('2026-09-02')).toBeTruthy()
    expect(screen.getByText('2026-09-05')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Task TA-1 start date' })).toBeNull()
  })

  it('reads Not set before the Task has entered In-Progress or Completed', () => {
    tasks.mockReturnValue({
      data: [task({ startDate: null, actualEndDate: null } as Partial<WorkItem>)],
      isLoading: false,
      isError: false,
    })
    renderTab()
    expect(screen.getAllByText('Not set')).toHaveLength(2)
  })
})

describe("TasksTab — the Project column is the record's project (P6-E2E-003)", () => {
  it('resolves the projectId it was handed, not the selected project', () => {
    renderTab()
    expect(recordProject).toHaveBeenCalledWith('proj-record')
    expect(screen.getByText('TEST')).toBeTruthy()
  })
})

describe("TasksTab — the inline Owner picker is scoped to the ROW's Team (GAP-P1-WID-007)", () => {
  it("asks per row, keyed on that task's own team", () => {
    tasks.mockReturnValue({
      data: [task(), task({ id: 'ta-2', itemKey: 'TA-2', teamId: 'team-2', assigneeId: null })],
      isLoading: false,
      isError: false,
    })
    renderTab()

    // Both teams asked for — a single feed narrowed by the parent would have offered team-1's roster
    // to a task that carries team-2, which withholds a legitimate owner.
    expect(teamOwnerOptions).toHaveBeenCalledWith('proj-record', 'team-1')
    expect(teamOwnerOptions).toHaveBeenCalledWith('proj-record', 'team-2')
  })

  it('offers the team roster only, while still NAMING an owner who has left it', () => {
    // Bruno owns the row but is not on its team.
    tasks.mockReturnValue({
      data: [task({ assigneeId: 'bruno' })],
      isLoading: false,
      isError: false,
    })
    renderTab()

    // The name comes from the project-wide feed via `OwnerSelectCell`'s separate `ownerName` prop, so
    // the narrowing cannot turn an owned row into `--`.
    const trigger = screen.getByRole('button', { name: 'Task TA-1 owner' })
    expect(trigger.textContent).toContain('Bruno Beta')

    fireEvent.click(trigger)
    expect(screen.queryByText('Alice Smith')).toBeTruthy()
  })

  /**
   * `TASK-FR-017` scopes a Task's Owner options to its INHERITED PARENT Team, and `work.tasks.team_id`
   * only DEFAULTS to the parent's (SRS P1-04) and is nullable — so reading the row's own value alone
   * offered `Unassigned` and nothing else on an ordinary row (retest 2026-08-17).
   */
  it("falls back to the PARENT's Team when the row carries none", () => {
    tasks.mockReturnValue({
      data: [task({ teamId: null, assigneeId: null })],
      isLoading: false,
      isError: false,
    })
    renderTab()

    expect(teamOwnerOptions).toHaveBeenCalledWith('proj-record', 'team-parent')
    fireEvent.click(screen.getByRole('button', { name: 'Task TA-1 owner' }))
    expect(screen.queryByText('Alice Smith')).toBeTruthy()
  })

  it('offers nothing when NEITHER the row nor its parent carries a Team (AC6)', () => {
    tasks.mockReturnValue({
      data: [task({ teamId: null, assigneeId: null })],
      isLoading: false,
      isError: false,
    })
    // `useTeamOwnerOptions` is disabled without a team — the rule lives in the feed.
    teamOwnerOptions.mockReturnValue({ data: undefined })
    render(
      <TasksTab workItemId="wi-1" projectId="proj-record" parentTeamId={null} readOnly={false} />,
    )

    expect(teamOwnerOptions).toHaveBeenCalledWith('proj-record', null)
    fireEvent.click(screen.getByRole('button', { name: 'Task TA-1 owner' }))
    expect(screen.queryByText('Alice Smith')).toBeNull()
  })

  /**
   * The other half of the same rule: a Workspace Admin on the team roster is now an Owner OPTION
   * (`GAP-P1-WID-007` AC1/AC3), and the project-wide feed still does not carry them — so the row must
   * NAME them from the team roster or a saved Owner reads back as unset, which is `GAP-P2-IS-004`'s
   * symptom in a different place.
   */
  it('names an owner the project-wide feed does not carry', () => {
    const wa = { userId: 'wa-1', displayName: 'Workspace Admin', email: 'wa@qnsc.dev' }
    teamOwnerOptions.mockReturnValue({ data: [ALICE, wa] })
    tasks.mockReturnValue({
      data: [task({ assigneeId: 'wa-1' })],
      isLoading: false,
      isError: false,
    })
    renderTab()

    expect(screen.getByRole('button', { name: 'Task TA-1 owner' }).textContent).toContain(
      'Workspace Admin',
    )
  })
})
