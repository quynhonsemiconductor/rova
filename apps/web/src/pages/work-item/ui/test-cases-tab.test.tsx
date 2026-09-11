/**
 * The Test Cases tab (Phase 7, Phase A — AC2, AC3, AC4, BR10, BR15; Phase B — B4's live Add New).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

const testCases = vi.fn()
const reorderMutate = vi.fn()
const deleteMutate = vi.fn()
let canCreateTestCase = false
let canEditTestCase = false
let canDeleteTestCase = false
vi.mock('@/features/test-cases/api', () => ({
  useTestCases: (...args: unknown[]) => testCases(...args),
  useReorderTestCase: () => ({ mutate: reorderMutate, isPending: false }),
  useDeleteTestCase: () => ({ mutateAsync: deleteMutate, isPending: false }),
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

  // ── Phase F: row delete (F2) ────────────────────────────────────────────────

  it('renders NO row action menu without test_case:delete (F2)', () => {
    testCases.mockReturnValue({ data: [testCase()], isLoading: false, isError: false })
    renderTab()

    expect(screen.queryByRole('button', { name: /Actions for TC-1/i })).not.toBeInTheDocument()
  })

  it('deletes the row after a NAMED confirmation, with test_case:delete (F2)', async () => {
    canDeleteTestCase = true
    deleteMutate.mockResolvedValue(undefined)
    testCases.mockReturnValue({ data: [testCase()], isLoading: false, isError: false })
    renderTab()

    fireEvent.click(screen.getByRole('button', { name: /Actions for TC-1/i }))
    fireEvent.click(await screen.findByText('Delete'))

    // Still nothing sent — the dialog is the gate.
    expect(deleteMutate).not.toHaveBeenCalled()
    // The confirmation names what survives: Results do NOT survive independently.
    expect(screen.getByText(/Its Results are deleted with it/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
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
})
