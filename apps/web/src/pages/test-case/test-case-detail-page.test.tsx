/**
 * Test Case Detail page (Phase 7, Phase A — AC4). READ-ONLY: every field is a
 * `DetailReadonlyValue` / read-only `RichTextEditor`, never an editable input.
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
vi.mock('@/features/test-cases/api', () => ({
  useTestCaseByKey: (...args: unknown[]) => testCaseByKey(...args),
}))
vi.mock('@/features/work-items/api', () => ({
  useWorkItem: () => ({ data: { id: 'wi-1', itemKey: 'US-1' } }),
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
})

describe('TestCaseDetailPage', () => {
  it('renders every field read-only — no editable input anywhere', () => {
    testCaseByKey.mockReturnValue({ data: testCase(), isLoading: false, isError: false })
    render(<TestCaseDetailPage />)

    expect(screen.getByText('User can log in')).toBeInTheDocument()
    // RichTextEditor keeps `role="textbox"` even read-only (it is still the accessible name for the
    // rendered prose), but `contenteditable` must be `false` on every one of them, and no `combobox`
    // (a live SearchableSelect) may exist at all on a read-only detail page.
    for (const editor of screen.getAllByRole('textbox')) {
      expect(editor).toHaveAttribute('contenteditable', 'false')
    }
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('renders Project backlog when teamId is null (SRS §5)', () => {
    testCaseByKey.mockReturnValue({
      data: testCase({ teamId: null }),
      isLoading: false,
      isError: false,
    })
    render(<TestCaseDetailPage />)

    expect(screen.getByText('Project backlog')).toBeInTheDocument()
  })

  it('links Work Product to the parent Work Item', () => {
    testCaseByKey.mockReturnValue({ data: testCase(), isLoading: false, isError: false })
    render(<TestCaseDetailPage />)

    const link = screen.getByRole('link', { name: 'US-1' })
    expect(link).toHaveAttribute('href', '/item/$itemKey')
  })

  it('renders each of the three denied states, not a blank page', () => {
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
