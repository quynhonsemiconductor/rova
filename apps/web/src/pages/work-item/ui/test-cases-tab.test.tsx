/**
 * The Test Cases tab (Phase 7, Phase A — AC2, AC3, AC4, BR10, BR15; Phase B — B4's live Add New).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

const testCases = vi.fn()
const testCaseTypes = vi.fn()
const reorderMutate = vi.fn()
const deleteMutate = vi.fn()
const createMutate = vi.fn()
const updateTestCaseMutate = vi.fn()
let canCreateTestCase = false
let canEditTestCase = false
let canDeleteTestCase = false
vi.mock('@/features/test-cases/api', () => ({
  useTestCases: (...args: unknown[]) => testCases(...args),
  useTestCaseTypes: (...args: unknown[]) => testCaseTypes(...args),
  useReorderTestCase: () => ({ mutate: reorderMutate, isPending: false }),
  useDeleteTestCase: () => ({ mutateAsync: deleteMutate, isPending: false }),
  useCreateTestCase: () => ({ mutateAsync: createMutate, isPending: false }),
  useUpdateTestCase: () => ({ mutate: updateTestCaseMutate, isPending: false }),
}))
const teamOwnerOptions = vi.fn()
const projectMemberOptions = vi.fn()
vi.mock('@/features/teams/api', () => ({
  useTeamOwnerOptions: (...args: unknown[]) => teamOwnerOptions(...args),
  useProjectMemberOptions: (...args: unknown[]) => projectMemberOptions(...args),
}))
vi.mock('@/features/access/api', () => ({
  useProjectPermissions: () => ({
    can: (code: string) =>
      code === 'test_case:view' ||
      (code === 'test_case:create' && canCreateTestCase) ||
      (code === 'test_case:edit' && canEditTestCase) ||
      (code === 'test_case:delete' && canDeleteTestCase),
  }),
}))
vi.mock('@/features/test-cases/ui/create-test-case-modal', () => ({
  CreateTestCaseModal: ({ onClose }: { workItemId: string; onClose: () => void }) => (
    <div role="dialog" aria-label="Create Test Case">
      <button type="button" onClick={onClose}>
        close
      </button>
    </div>
  ),
}))

import '@/shared/i18n/i18n'
import { TestCasesTab } from './test-cases-tab'
import type { TestCase } from '@/features/test-cases/api'

const testCase = (over: Partial<TestCase> = {}): TestCase =>
  ({
    id: 'tc-1',
    testCaseKey: 'TC-1',
    name: 'User can log in',
    type: 'Functional',
    method: 'manual',
    priority: 'high',
    ownerId: 'user-1',
    ownerName: 'Alice Smith',
    assigneeId: null,
    assigneeName: null,
    rank: 'a0001',
    lastVerdict: null,
    lastRun: null,
    workItemId: 'wi-1',
    projectId: 'proj-1',
    teamId: null,
    ...over,
  }) as unknown as TestCase

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  canCreateTestCase = false
  canEditTestCase = false
  canDeleteTestCase = false
  testCases.mockReturnValue({ data: [], isLoading: false, isError: false })
  testCaseTypes.mockReturnValue({ data: [{ id: 'type-1', name: 'Functional' }], isLoading: false })
  teamOwnerOptions.mockReturnValue({ data: [], isLoading: false, isError: false })
  projectMemberOptions.mockReturnValue({ data: [], isLoading: false, isError: false })
})

function renderTab() {
  return render(<TestCasesTab workItemId="wi-1" projectId="proj-1" />)
}

describe('TestCasesTab', () => {
  it('renders every AC2 column label', () => {
    testCases.mockReturnValue({ data: [testCase()], isLoading: false, isError: false })
    renderTab()

    // The grid is DIVs, not a semantic table — deliberately no `role="columnheader"` (CLAUDE.md),
    // so the labels are asserted directly rather than through a columnheader query.
    const labels = [
      'Rank',
      'ID',
      'Name',
      'Type',
      'Method',
      'Priority',
      'Owner',
      'Last Verdict',
      'Last Run',
    ]
    for (const label of labels) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    expect(screen.queryAllByRole('columnheader')).toHaveLength(0)
  })

  it('shows the empty state and a DISABLED Add New with no test_case:create (AC3)', () => {
    testCases.mockReturnValue({ data: [], isLoading: false, isError: false })
    renderTab()

    expect(screen.getByText('No Test Cases yet')).toBeInTheDocument()
    const addNew = screen.getByRole('button', { name: 'Add New' })
    expect(addNew).toBeDisabled()
  })

  it('B4: renders Add New ENABLED with test_case:create, and it opens the create modal', () => {
    canCreateTestCase = true
    testCases.mockReturnValue({ data: [], isLoading: false, isError: false })
    renderTab()

    const addNew = screen.getByRole('button', { name: 'Add New' })
    expect(addNew).not.toBeDisabled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(addNew)

    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('renders "Not Run" / "Not run yet" for a Test Case with no Results — never a dash (BR10)', () => {
    testCases.mockReturnValue({
      data: [testCase({ lastVerdict: null, lastRun: null })],
      isLoading: false,
      isError: false,
    })
    renderTab()

    expect(screen.getByText('Not Run')).toBeInTheDocument()
    expect(screen.getByText('Not run yet')).toBeInTheDocument()
    expect(screen.queryByText('--')).not.toBeInTheDocument()
  })

  it('renders the populated verdict/date for a Test Case WITH results', () => {
    testCases.mockReturnValue({
      data: [testCase({ lastVerdict: 'pass', lastRun: '2026-06-21' })],
      isLoading: false,
      isError: false,
    })
    renderTab()

    expect(screen.getByText('Pass')).toBeInTheDocument()
    expect(screen.getByText('2026-06-21')).toBeInTheDocument()
  })

  it("the ID cell opens the Test Case's own detail route (AC4)", () => {
    testCases.mockReturnValue({ data: [testCase()], isLoading: false, isError: false })
    renderTab()

    screen.getByRole('button', { name: 'TC-1' }).click()
    expect(navigate).toHaveBeenCalledWith({
      to: '/test-case/$testCaseKey',
      params: { testCaseKey: 'TC-1' },
    })
  })

  it('renders no separate Test Steps list anywhere (BR15)', () => {
    testCases.mockReturnValue({ data: [testCase()], isLoading: false, isError: false })
    renderTab()

    expect(screen.queryByText(/test step/i)).not.toBeInTheDocument()
  })

  // ── Select All + bulk Delete/Copy (matches Tasks tab's SelectableTable wiring) ──

  it('renders a Select All checkbox and per-row checkbox', () => {
    testCases.mockReturnValue({ data: [testCase()], isLoading: false, isError: false })
    renderTab()

    expect(screen.getByRole('checkbox', { name: 'Select all test cases' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Select test case TC-1' })).toBeInTheDocument()
  })

  it('selecting a row reveals Delete only with test_case:delete (F2)', () => {
    testCases.mockReturnValue({ data: [testCase()], isLoading: false, isError: false })
    renderTab()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select test case TC-1' }))

    expect(screen.getByText('1 Item Selected')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
  })

  it('deletes the selected row after a confirmation, with test_case:delete (F2)', async () => {
    canDeleteTestCase = true
    deleteMutate.mockResolvedValue(undefined)
    testCases.mockReturnValue({ data: [testCase()], isLoading: false, isError: false })
    renderTab()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select test case TC-1' }))
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }))

    // Still nothing sent — the dialog is the gate.
    expect(deleteMutate).not.toHaveBeenCalled()

    // The confirm dialog's own Delete is the last one rendered (the bulk bar's is still mounted
    // behind it). T1: `act` flushes the `mutateAsync` resolution and the state update it drives
    // (closing the dialog), so the assertion below doesn't trigger an unawaited-update warning.
    const buttons = screen.getAllByRole('button', { name: /^Delete$/ })
    await act(async () => {
      fireEvent.click(buttons[buttons.length - 1])
    })
    expect(deleteMutate).toHaveBeenCalledWith('tc-1')
  })

  // ── Phase F: rank drag-reorder (F3) ──────────────────────────────────────────

  it('renders a focusable drag grip per row with test_case:edit, none without it', () => {
    testCases.mockReturnValue({ data: [testCase()], isLoading: false, isError: false })
    const { rerender } = renderTab()
    // Disabled: an inert, aria-hidden spacer — no accessible grip to find.
    expect(screen.queryByRole('button', { name: /drag to reorder/i })).not.toBeInTheDocument()

    canEditTestCase = true
    rerender(<TestCasesTab workItemId="wi-1" projectId="proj-1" />)
    expect(screen.getByRole('button', { name: /drag to reorder/i })).toBeInTheDocument()
  })

  // ── Client-side sort + filter (Tasks-tab-shaped) ─────────────────────────────

  it('sorts by Name when the Name header is clicked', () => {
    testCases.mockReturnValue({
      data: [
        testCase({ id: 'tc-2', testCaseKey: 'TC-2', name: 'Zebra' }),
        testCase({ name: 'Apple' }),
      ],
      isLoading: false,
      isError: false,
    })
    renderTab()

    const rowsBefore = screen.getAllByText(/^(Zebra|Apple)$/).map((el) => el.textContent)
    expect(rowsBefore).toEqual(['Zebra', 'Apple']) // rank order, unsorted

    fireEvent.click(screen.getByText('Name'))

    const rowsAfter = screen.getAllByText(/^(Zebra|Apple)$/).map((el) => el.textContent)
    expect(rowsAfter).toEqual(['Apple', 'Zebra'])
  })

  it('filters by Priority', () => {
    testCases.mockReturnValue({
      data: [
        testCase({ id: 'tc-2', testCaseKey: 'TC-2', name: 'Urgent one', priority: 'urgent' }),
        testCase({ name: 'High one', priority: 'high' }),
      ],
      isLoading: false,
      isError: false,
    })
    renderTab()

    expect(screen.getByText('Urgent one')).toBeInTheDocument()
    expect(screen.getByText('High one')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
    fireEvent.change(screen.getByLabelText('Filter by Priority'), { target: { value: 'urgent' } })

    expect(screen.getByText('Urgent one')).toBeInTheDocument()
    expect(screen.queryByText('High one')).not.toBeInTheDocument()
  })

  it('searches by Name (a search box was previously missing entirely)', () => {
    testCases.mockReturnValue({
      data: [
        testCase({ id: 'tc-2', testCaseKey: 'TC-2', name: 'Login flow' }),
        testCase({ name: 'Checkout flow' }),
      ],
      isLoading: false,
      isError: false,
    })
    renderTab()

    expect(screen.getByText('Login flow')).toBeInTheDocument()
    expect(screen.getByText('Checkout flow')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('Search test cases'), {
      target: { value: 'login' },
    })

    expect(screen.getByText('Login flow')).toBeInTheDocument()
    expect(screen.queryByText('Checkout flow')).not.toBeInTheDocument()
  })

  it('filters by Owner (the "no feed" claim from a prior session was wrong — memberFeed is cheap and already used elsewhere)', () => {
    projectMemberOptions.mockReturnValue({
      data: [{ userId: 'user-1', displayName: 'Alice Smith', email: 'alice@example.com' }],
      isLoading: false,
      isError: false,
    })
    testCases.mockReturnValue({
      data: [
        testCase({
          id: 'tc-2',
          testCaseKey: 'TC-2',
          name: 'Owned by Alice',
          ownerId: 'user-1',
          ownerName: 'Alice Smith',
        }),
        testCase({ name: 'Unowned', ownerId: null, ownerName: null }),
      ],
      isLoading: false,
      isError: false,
    })
    renderTab()

    expect(screen.getByText('Owned by Alice')).toBeInTheDocument()
    expect(screen.getByText('Unowned')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
    fireEvent.change(screen.getByLabelText('Filter by Owner'), { target: { value: 'user-1' } })

    expect(screen.getByText('Owned by Alice')).toBeInTheDocument()
    expect(screen.queryByText('Unowned')).not.toBeInTheDocument()
  })

  // ── Inline edit (Name/Type/Method/Priority/Owner) ────────────────────────────

  it('edits Name inline with test_case:edit (the Name column had no inline edit previously)', () => {
    canEditTestCase = true
    testCases.mockReturnValue({ data: [testCase()], isLoading: false, isError: false })
    renderTab()

    fireEvent.click(screen.getByText('User can log in'))
    const input = screen.getByDisplayValue('User can log in')
    fireEvent.change(input, { target: { value: 'User can log in securely' } })
    fireEvent.blur(input)

    expect(updateTestCaseMutate).toHaveBeenCalledWith({ name: 'User can log in securely' })
  })

  it('edits Priority inline with test_case:edit', () => {
    canEditTestCase = true
    testCases.mockReturnValue({ data: [testCase()], isLoading: false, isError: false })
    renderTab()

    fireEvent.click(screen.getByRole('button', { name: /Test case TC-1 priority/i }))
    fireEvent.click(screen.getByText('Urgent'))

    expect(updateTestCaseMutate).toHaveBeenCalledWith({ priority: 'urgent' })
  })
})
