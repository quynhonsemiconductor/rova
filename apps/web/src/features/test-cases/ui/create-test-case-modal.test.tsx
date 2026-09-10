/**
 * `CreateTestCaseModal` (Phase B — SRS §5).
 *
 * BR1: Create disabled while Name is blank. BR2/BR3: Type/Method/Priority defaults are the
 * SERVICE's, not re-derived here — an untouched selector must send `undefined`. BR4: Owner
 * defaults to the current user ONLY when the parent Team's own feed offers them (`useDefaultOwner`,
 * not a re-derived rule). BR5: Project renders read-only. SRS §2: success navigates to the new
 * Test Case's own detail route.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const createTestCase = vi.fn()
const useWorkItem = vi.fn()
const useTestCaseTypes = vi.fn()
const teamOwnerOptions = vi.fn()
const navigate = vi.fn()

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@/features/test-cases/api', () => ({
  useCreateTestCase: () => ({ mutateAsync: createTestCase }),
  useTestCaseTypes: (...args: unknown[]) => useTestCaseTypes(...args),
}))
vi.mock('@/features/work-items/api', () => ({
  useWorkItem: (...args: unknown[]) => useWorkItem(...args),
}))
vi.mock('@/features/teams/api', () => ({
  useTeamOwnerOptions: (...args: unknown[]) => teamOwnerOptions(...args),
}))
vi.mock('@/shared/lib/deep-link-project', () => ({
  useRecordProject: (projectId: string | undefined) =>
    projectId === 'proj-1'
      ? { projectId: 'proj-1', projectKey: 'NXP', projectName: 'NextGen Platform' }
      : undefined,
}))
vi.mock('@/shared/lib/stores/auth.store', () => ({
  useAuthStore: (selector: (s: { user: { id: string } }) => unknown) =>
    selector({ user: { id: 'alice' } }),
}))

import '@/shared/i18n/i18n'
import { CreateTestCaseModal } from './create-test-case-modal'

const ALICE = { userId: 'alice', displayName: 'Alice Smith', email: 'alice@qnsc.dev' }
const BOB = { userId: 'bob', displayName: 'Bob Jones', email: 'bob@qnsc.dev' }

const PARENT = { id: 'wi-1', projectId: 'proj-1', teamId: 'team-1' }
const TYPES = [
  { id: 'type-1', name: 'Acceptance' },
  { id: 'type-2', name: 'Functional' },
]

beforeEach(() => {
  vi.clearAllMocks()
  createTestCase.mockResolvedValue({ id: 'tc-1', testCaseKey: 'TC-1' })
  useWorkItem.mockReturnValue({ data: PARENT })
  useTestCaseTypes.mockReturnValue({ data: TYPES })
  teamOwnerOptions.mockReturnValue({ data: [ALICE] })
})

function open() {
  render(<CreateTestCaseModal workItemId="wi-1" onClose={vi.fn()} />)
}

describe('CreateTestCaseModal', () => {
  it('BR1: Create is disabled while Name is blank', () => {
    open()

    expect(screen.getByRole('button', { name: /^Create$/ })).toBeDisabled()
  })

  it('BR1: Create becomes enabled once a Name is typed', () => {
    open()

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Login works' } })

    expect(screen.getByRole('button', { name: /^Create$/ })).not.toBeDisabled()
  })

  it('BR1: submits the Name verbatim, trimmed', async () => {
    open()

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: '  Login works  ' } })
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }))

    await vi.waitFor(() => expect(createTestCase).toHaveBeenCalled())
    expect(createTestCase.mock.calls[0][0]).toMatchObject({ name: 'Login works' })
  })

  it('BR2/BR3: an untouched Type/Method/Priority selector sends nothing (service resolves the default)', async () => {
    open()

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Login works' } })
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }))

    await vi.waitFor(() => expect(createTestCase).toHaveBeenCalled())
    expect(createTestCase.mock.calls[0][0].type).toBeUndefined()
    expect(createTestCase.mock.calls[0][0].method).toBeUndefined()
    expect(createTestCase.mock.calls[0][0].priority).toBeUndefined()
  })

  it("BR2: the Type selector DISPLAYS the project's first selectable Type as the resolved default", () => {
    open()

    expect(screen.getByText('Acceptance')).toBeInTheDocument()
  })

  it('BR4: Owner defaults to the current user when the parent TEAM feed offers them', async () => {
    open()

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Login works' } })
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }))

    await vi.waitFor(() => expect(createTestCase).toHaveBeenCalled())
    expect(createTestCase.mock.calls[0][0].ownerId).toBe('alice')
  })

  it("BR4: Owner stays Unassigned when the current user is NOT in the parent Team's feed", async () => {
    teamOwnerOptions.mockReturnValue({ data: [BOB] })
    open()

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Login works' } })
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }))

    await vi.waitFor(() => expect(createTestCase).toHaveBeenCalled())
    expect(createTestCase.mock.calls[0][0].ownerId).toBeUndefined()
  })

  it('BR6: Assigned To starts Unassigned and is omitted from the payload untouched', async () => {
    open()

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Login works' } })
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }))

    await vi.waitFor(() => expect(createTestCase).toHaveBeenCalled())
    expect(createTestCase.mock.calls[0][0].assigneeId).toBeUndefined()
  })

  it("BR5: renders the parent Work Item's Project READ-ONLY (no picker)", () => {
    open()

    expect(screen.getByText('NXP')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: /project/i })).not.toBeInTheDocument()
  })

  it("uses the PARENT's team for Owner options, not the app shell's selected team", () => {
    open()

    expect(teamOwnerOptions).toHaveBeenCalledWith('proj-1', 'team-1')
  })

  it('renders the mockup footer note about test steps', () => {
    open()

    expect(
      screen.getByText(
        'Test steps are maintained on the Test Case detail as Input and Expected Result pairs.',
      ),
    ).toBeInTheDocument()
  })

  it('SRS §2: on success, navigates to the new Test Case detail route and closes', async () => {
    const onClose = vi.fn()
    render(<CreateTestCaseModal workItemId="wi-1" onClose={onClose} />)

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Login works' } })
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }))

    await vi.waitFor(() => expect(navigate).toHaveBeenCalled())
    expect(navigate).toHaveBeenCalledWith({
      to: '/test-case/$testCaseKey',
      params: { testCaseKey: 'TC-1' },
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('shows a modal-level error banner on a failed submit, and does not navigate', async () => {
    createTestCase.mockRejectedValue(new Error('WORK_ITEM_TEAM_REQUIRED'))
    open()

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Login works' } })
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('WORK_ITEM_TEAM_REQUIRED')
    expect(navigate).not.toHaveBeenCalled()
  })
})
