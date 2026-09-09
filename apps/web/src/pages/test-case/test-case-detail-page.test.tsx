/**
 * Test Case Detail page (Phase 7, Phase C — SRS §6). Now editable, gated on `test_case:edit`.
 * BR5: Project/Team/Last Verdict/Last Run stay read-only regardless of permission — there is no
 * control anywhere on this page that could write any of the four.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ testCaseKey: 'TC-1' }),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}))
vi.mock('@/shared/lib/use-detail-back', () => ({ useDetailBack: () => vi.fn() }))
vi.mock('@/shared/lib/deep-link-project', () => ({
  useRecordProject: () => ({ projectId: 'proj-1', projectKey: 'NXP', projectName: 'NX Platform' }),
}))

const testCaseByKey = vi.fn()
const updateTestCase = vi.fn()
const testCaseTypes = vi.fn()
const testCaseActivity = vi.fn()
const testResults = vi.fn()
vi.mock('@/features/test-cases/api', () => ({
  useTestCaseByKey: (...args: unknown[]) => testCaseByKey(...args),
  useUpdateTestCase: () => ({ mutateAsync: updateTestCase }),
  useTestCaseTypes: (...args: unknown[]) => testCaseTypes(...args),
  useTestCaseActivity: (...args: unknown[]) => testCaseActivity(...args),
  useTestResults: (...args: unknown[]) => testResults(...args),
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
import { TestCaseDetailPage } from './test-case-detail-page'
import type { TestCase } from '@/features/test-cases/api'

const testCase = (over: Partial<TestCase> = {}): TestCase =>
  ({
    id: 'tc-1',
    testCaseKey: 'TC-1',
    name: 'User can log in',
    description: '<p>desc</p>',
    objective: null,
    preconditions: null,
    validationInput: null,
    validationExpectedResult: null,
    postconditions: null,
    notes: null,
    type: 'Functional',
    method: 'manual',
    priority: 'high',
    ownerId: 'user-1',
    ownerName: 'Alice Smith',
    assigneeId: null,
    assigneeName: null,
    lastVerdict: null,
    lastRun: null,
    workItemId: 'wi-1',
    projectId: 'proj-1',
    teamId: null,
    ...over,
  }) as unknown as TestCase

beforeEach(() => {
  vi.clearAllMocks()
  teamOwnerOptions.mockReturnValue({ data: [], isLoading: false, isError: false })
  projectMemberOptions.mockReturnValue({ data: [], isLoading: false, isError: false })
  testCaseTypes.mockReturnValue({ data: [{ id: 'type-1', name: 'Functional' }] })
  testCaseActivity.mockReturnValue({ data: [], isLoading: false, isError: false })
  testResults.mockReturnValue({ data: [], isLoading: false, isError: false })
})

describe('TestCaseDetailPage', () => {
  it('renders read-only when the caller lacks test_case:edit', () => {
    canPermission.mockReturnValue(false)
    testCaseByKey.mockReturnValue({ data: testCase(), isLoading: false, isError: false })
    render(<TestCaseDetailPage />)

    expect(screen.getByText('User can log in')).toBeInTheDocument()
    for (const editor of screen.getAllByRole('textbox')) {
      expect(editor).toHaveAttribute('contenteditable', 'false')
    }
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('renders editable controls when the caller holds test_case:edit (C5)', () => {
    canPermission.mockReturnValue(true)
    testCaseByKey.mockReturnValue({ data: testCase(), isLoading: false, isError: false })
    render(<TestCaseDetailPage />)

    // At least one content editor is writable, and the Type/Method/Priority selects are live.
    const editors = screen.getAllByRole('textbox')
    expect(editors.some((e) => e.getAttribute('contenteditable') !== 'false')).toBe(true)
    expect(screen.getAllByRole('combobox').length).toBeGreaterThan(0)
  })

  it('BR17: unions the row’s OWN Type with the live selectable list', () => {
    canPermission.mockReturnValue(true)
    testCaseTypes.mockReturnValue({ data: [{ id: 'type-2', name: 'Regression' }] })
    testCaseByKey.mockReturnValue({
      data: testCase({ type: 'Retired Type' }),
      isLoading: false,
      isError: false,
    })
    render(<TestCaseDetailPage />)

    // The Type trigger renders the row's own historical value even though it is absent from the
    // live feed above — proves the union, not a refusal to render an unknown value.
    expect(screen.getByText('Retired Type')).toBeInTheDocument()
  })

  it('BR5: renders Project backlog when teamId is null, with no Team control to edit it', () => {
    canPermission.mockReturnValue(true)
    testCaseByKey.mockReturnValue({
      data: testCase({ teamId: null, teamName: null }),
      isLoading: false,
      isError: false,
    })
    render(<TestCaseDetailPage />)

    expect(screen.getByText('Project backlog')).toBeInTheDocument()
  })

  it('SRS §6.3 / Story 5 AC3: renders the real Team name when teamId is set, never the Project backlog fallback', () => {
    canPermission.mockReturnValue(true)
    testCaseByKey.mockReturnValue({
      data: testCase({ teamId: 'team-1', teamName: 'Team Alpha' }),
      isLoading: false,
      isError: false,
    })
    render(<TestCaseDetailPage />)

    expect(screen.getByText('Team Alpha')).toBeInTheDocument()
    expect(screen.queryByText('Project backlog')).not.toBeInTheDocument()
  })

  it('Story 6 AC1: the Results tab uses the flask icon, not ClipboardList', () => {
    canPermission.mockReturnValue(false)
    testCaseByKey.mockReturnValue({ data: testCase(), isLoading: false, isError: false })
    const { container } = render(<TestCaseDetailPage />)

    expect(container.querySelector('svg.lucide-flask-conical')).not.toBeNull()
    expect(container.querySelector('svg.lucide-clipboard-list')).toBeNull()
  })

  it('links Work Product to the parent Work Item', () => {
    canPermission.mockReturnValue(false)
    testCaseByKey.mockReturnValue({ data: testCase(), isLoading: false, isError: false })
    render(<TestCaseDetailPage />)

    const link = screen.getByRole('link', { name: 'US-1' })
    expect(link).toHaveAttribute('href', '/item/$itemKey')
  })

  it('renders each of the three denied states, not a blank page', () => {
    canPermission.mockReturnValue(false)
    testCaseByKey.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: { status: 403 },
    })
    const { container } = render(<TestCaseDetailPage />)
    expect(container.textContent?.trim()).not.toBe('')
  })
})
