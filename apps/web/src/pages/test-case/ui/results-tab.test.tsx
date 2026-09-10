/**
 * Test Case Results tab (Phase D). This pass adds client-side sort/filter and inline edit on
 * Verdict/Duration/Tester — the backend list route takes no query params, so both are client-only
 * (matching Tasks tab / the Test Cases tab).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}))

const testResults = vi.fn()
const updateTestResultMutate = vi.fn()
vi.mock('@/features/test-cases/api', () => ({
  useTestResults: (...args: unknown[]) => testResults(...args),
  useUpdateTestResult: () => ({ mutate: updateTestResultMutate, isPending: false }),
}))

const canPermission = vi.fn()
vi.mock('@/features/access/api', () => ({
  useProjectPermissions: () => ({ can: canPermission }),
}))

const teamOwnerOptions = vi.fn()
const projectMemberOptions = vi.fn()
vi.mock('@/features/teams/api', () => ({
  useTeamOwnerOptions: (...args: unknown[]) => teamOwnerOptions(...args),
  useProjectMemberOptions: (...args: unknown[]) => projectMemberOptions(...args),
}))

vi.mock('@/features/test-cases/ui/add-test-result-modal', () => ({
  AddTestResultModal: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="Add Test Result">
      <button type="button" onClick={onClose}>
        close
      </button>
    </div>
  ),
}))

import '@/shared/i18n/i18n'
import { ResultsTab } from './results-tab'
import type { TestResult } from '@/features/test-cases/api'

const result = (over: Partial<TestResult> = {}): TestResult =>
  ({
    id: 'tr-1',
    testResultKey: 'TR-1',
    testCaseId: 'tc-1',
    projectId: 'proj-1',
    workItemId: 'wi-1',
    build: 'Build 1.0',
    runDate: '2026-06-01',
    verdict: 'pass',
    durationMinutes: 10,
    testerId: 'user-1',
    testerName: 'Alice Smith',
    notes: null,
    ...over,
  }) as unknown as TestResult

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  canPermission.mockReturnValue(false)
  testResults.mockReturnValue({ data: [], isLoading: false, isError: false })
  teamOwnerOptions.mockReturnValue({ data: [], isLoading: false, isError: false })
  projectMemberOptions.mockReturnValue({ data: [], isLoading: false, isError: false })
})

function renderTab() {
  return render(
    <ResultsTab testCaseId="tc-1" projectId="proj-1" teamId={null} workItemKey="US-1" />,
  )
}

describe('ResultsTab', () => {
  it('sorts by Duration when the Duration header is clicked', () => {
    testResults.mockReturnValue({
      data: [
        result({ id: 'tr-2', testResultKey: 'TR-2', build: 'Short', durationMinutes: 5 }),
        result({ build: 'Long', durationMinutes: 45 }),
      ],
      isLoading: false,
      isError: false,
    })
    renderTab()

    fireEvent.click(screen.getByText('Duration'))

    const rows = screen.getAllByText(/^(Short|Long)$/).map((el) => el.textContent)
    expect(rows).toEqual(['Short', 'Long'])
  })

  it('filters by Verdict', () => {
    testResults.mockReturnValue({
      data: [
        result({ id: 'tr-2', testResultKey: 'TR-2', build: 'Failed run', verdict: 'fail' }),
        result({ build: 'Passed run', verdict: 'pass' }),
      ],
      isLoading: false,
      isError: false,
    })
    renderTab()

    expect(screen.getByText('Failed run')).toBeInTheDocument()
    expect(screen.getByText('Passed run')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
    fireEvent.change(screen.getByLabelText('Filter by Verdict'), { target: { value: 'fail' } })

    expect(screen.getByText('Failed run')).toBeInTheDocument()
    expect(screen.queryByText('Passed run')).not.toBeInTheDocument()
  })

  it('edits Duration inline with test_result:edit', () => {
    canPermission.mockReturnValue(true)
    testResults.mockReturnValue({ data: [result()], isLoading: false, isError: false })
    renderTab()

    fireEvent.click(screen.getByText('10m'))
    const input = screen.getByDisplayValue('10')
    fireEvent.change(input, { target: { value: '25' } })
    fireEvent.blur(input)

    expect(updateTestResultMutate).toHaveBeenCalledWith({ durationMinutes: 25 })
  })

  it('renders NO inline edit controls without test_result:edit', () => {
    canPermission.mockReturnValue(false)
    testResults.mockReturnValue({ data: [result()], isLoading: false, isError: false })
    renderTab()

    // Duration is plain text, not the editable trigger.
    fireEvent.click(screen.getByText('10m'))
    expect(screen.queryByDisplayValue('10')).not.toBeInTheDocument()
  })

  it('searches by Build (a search box was previously missing entirely)', () => {
    testResults.mockReturnValue({
      data: [
        result({ id: 'tr-2', testResultKey: 'TR-2', build: 'Nightly build' }),
        result({ build: 'Release candidate' }),
      ],
      isLoading: false,
      isError: false,
    })
    renderTab()

    expect(screen.getByText('Nightly build')).toBeInTheDocument()
    expect(screen.getByText('Release candidate')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('Search results'), {
      target: { value: 'nightly' },
    })

    expect(screen.getByText('Nightly build')).toBeInTheDocument()
    expect(screen.queryByText('Release candidate')).not.toBeInTheDocument()
  })

  it('renders Show Fields (was previously missing entirely)', () => {
    testResults.mockReturnValue({ data: [], isLoading: false, isError: false })
    renderTab()

    expect(screen.getByRole('button', { name: 'Show Fields' })).toBeInTheDocument()
  })

  it('filters by Tester, reusing the project member feed rather than a second fetch', () => {
    projectMemberOptions.mockReturnValue({
      data: [{ userId: 'user-1', displayName: 'Alice Smith', email: 'alice@example.com' }],
      isLoading: false,
      isError: false,
    })
    testResults.mockReturnValue({
      data: [
        result({ id: 'tr-2', testResultKey: 'TR-2', build: 'Tested by Alice', testerId: 'user-1' }),
        result({ build: 'Tested by Bob', testerId: 'user-2', testerName: 'Bob Jones' }),
      ],
      isLoading: false,
      isError: false,
    })
    renderTab()

    expect(screen.getByText('Tested by Alice')).toBeInTheDocument()
    expect(screen.getByText('Tested by Bob')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
    fireEvent.change(screen.getByLabelText('Filter by Tester'), { target: { value: 'user-1' } })

    expect(screen.getByText('Tested by Alice')).toBeInTheDocument()
    expect(screen.queryByText('Tested by Bob')).not.toBeInTheDocument()
  })

  it('edits Date inline with test_result:edit (BR13 covers Test Case/Work Product, not Date)', () => {
    canPermission.mockReturnValue(true)
    testResults.mockReturnValue({
      data: [result({ runDate: '2026-06-01' })],
      isLoading: false,
      isError: false,
    })
    renderTab()

    expect(screen.getByRole('button', { name: 'Test result TR-1 date' })).toBeInTheDocument()
  })

  it('REGRESSION: Verdict keeps its colored badge styling while editable, not a bare select', () => {
    canPermission.mockReturnValue(true)
    testResults.mockReturnValue({
      data: [result({ verdict: 'pass' })],
      isLoading: false,
      isError: false,
    })
    renderTab()

    // The trigger renders the styled `VerdictBadge` (a rounded pill), not a plain label — before
    // this fix, `canEdit` (a permission flag) permanently swapped the badge for raw select text
    // for ANY user who could edit at all.
    const badge = screen.getByText('Pass')
    expect(badge.className).toContain('rounded-full')
  })
})
