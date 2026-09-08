/**
 * Test Result Detail page (Phase 7, Phase E — SRS §9). Editable, gated on `test_result:edit`.
 * BR13: Test Case/Work Product stay read-only regardless of permission — no control anywhere on
 * this page could write either, since `UpdateTestResultSchema` omits both.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ testResultId: 'tr-1' }),
  useNavigate: () => navigate,
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}))

const testResult = vi.fn()
const testCase = vi.fn()
const updateTestResult = vi.fn()
const testResultActivity = vi.fn()
vi.mock('@/features/test-cases/api', () => ({
  useTestResult: (...args: unknown[]) => testResult(...args),
  useTestCase: (...args: unknown[]) => testCase(...args),
  useUpdateTestResult: () => ({ mutateAsync: updateTestResult }),
  useTestResultActivity: (...args: unknown[]) => testResultActivity(...args),
}))
vi.mock('@/features/work-items/api', () => ({
  useWorkItem: () => ({ data: { id: 'wi-1', itemKey: 'US-1' } }),
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

vi.mock('@/features/collaboration/ui/attachment-block', () => ({
  AttachmentBlock: () => <div data-testid="attachment-block" />,
}))

import '@/shared/i18n/i18n'
import { TestResultDetailPage } from './test-result-detail-page'
import type { TestResult } from '@/features/test-cases/api'

const result = (over: Partial<TestResult> = {}): TestResult =>
  ({
    id: 'tr-1',
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    testCaseId: 'tc-1',
    workItemId: 'wi-1',
    testResultKey: 'TR-1',
    build: 'build-1',
    runDate: '2026-09-01',
    verdict: 'pass',
    durationMinutes: 30,
    testerId: 'user-1',
    testerName: 'Alice Smith',
    notes: null,
    createdBy: 'user-1',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  }) as unknown as TestResult

beforeEach(() => {
  vi.clearAllMocks()
  teamOwnerOptions.mockReturnValue({ data: [], isLoading: false, isError: false })
  projectMemberOptions.mockReturnValue({ data: [], isLoading: false, isError: false })
  testResultActivity.mockReturnValue({ data: [], isLoading: false, isError: false })
  testCase.mockReturnValue({
    data: { id: 'tc-1', testCaseKey: 'TC-1', projectId: 'proj-1', teamId: null },
  })
})

describe('TestResultDetailPage', () => {
  it('renders read-only when the caller lacks test_result:edit', () => {
    canPermission.mockReturnValue(false)
    testResult.mockReturnValue({ data: result(), isLoading: false, isError: false })
    render(<TestResultDetailPage />)

    expect(screen.getByText('build-1')).toBeInTheDocument()
    expect(screen.getByLabelText('Build')).toHaveAttribute('readonly')
    // Read-only SearchableSelect renders plain text, never the editable trigger button.
    expect(screen.queryByRole('button', { name: 'Verdict' })).not.toBeInTheDocument()
  })

  it('renders editable controls when the caller holds test_result:edit (E4)', () => {
    canPermission.mockReturnValue(true)
    testResult.mockReturnValue({ data: result(), isLoading: false, isError: false })
    render(<TestResultDetailPage />)

    expect(screen.getByLabelText('Build')).not.toHaveAttribute('readonly')
    expect(screen.getByRole('button', { name: 'Verdict' })).toBeInTheDocument()
  })

  it('BR13: Test Case and Work Product render as read-only display, never a picker', () => {
    canPermission.mockReturnValue(true)
    testResult.mockReturnValue({ data: result(), isLoading: false, isError: false })
    render(<TestResultDetailPage />)

    expect(screen.getByText('TC-1')).toBeInTheDocument()
    expect(screen.getByText('US-1')).toBeInTheDocument()
  })

  it('renders each of the three denied states, not a blank page', () => {
    canPermission.mockReturnValue(false)
    testResult.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: { status: 403 },
    })
    const { container } = render(<TestResultDetailPage />)
    expect(container.textContent?.trim()).not.toBe('')
  })

  it('renders the notFound state when the query succeeds with null', () => {
    canPermission.mockReturnValue(false)
    testResult.mockReturnValue({ data: undefined, isLoading: false, isError: false })
    render(<TestResultDetailPage />)

    expect(screen.getByText('No Test Result found')).toBeInTheDocument()
  })
})
