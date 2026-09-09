/**
 * Test Case Type catalog section (SRS §3, Phase G). Controls (`Add New`, `×`) render only for a
 * Workspace Admin; every reader sees the chip list. BR16's uniqueness/length errors surface
 * inline in the Add modal.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const testCaseTypes = vi.fn()
const createTestCaseType = vi.fn()
const archiveTestCaseType = vi.fn()
vi.mock('@/features/test-cases/api', () => ({
  useTestCaseTypes: (...args: unknown[]) => testCaseTypes(...args),
  useCreateTestCaseType: () => ({ mutateAsync: createTestCaseType, isPending: false }),
  useArchiveTestCaseType: () => ({ mutate: archiveTestCaseType, isPending: false }),
}))

vi.mock('@/shared/lib/toast', () => ({
  notify: { success: vi.fn(), fromError: vi.fn() },
}))

import { TestCaseTypesSection } from './test-case-types-section'

describe('TestCaseTypesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    testCaseTypes.mockReturnValue({
      data: [
        { id: 'type-1', name: 'Acceptance', position: 0 },
        { id: 'type-2', name: 'Functional', position: 1 },
      ],
      isLoading: false,
    })
  })

  it('renders the chip list for every reader', () => {
    render(<TestCaseTypesSection projectId="proj-1" isWA={false} />)

    expect(screen.getByText('Acceptance')).toBeInTheDocument()
    expect(screen.getByText('Functional')).toBeInTheDocument()
  })

  it('hides Add New and the remove control for a non-Workspace-Admin reader', () => {
    render(<TestCaseTypesSection projectId="proj-1" isWA={false} />)

    expect(screen.queryByRole('button', { name: /add new/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /remove acceptance/i })).not.toBeInTheDocument()
  })

  it('shows Add New and the remove control for a Workspace Admin', () => {
    render(<TestCaseTypesSection projectId="proj-1" isWA />)

    expect(screen.getByRole('button', { name: /add new/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /remove acceptance/i })).toBeInTheDocument()
  })

  it('opens the Add modal and disables Save while the name is blank', async () => {
    render(<TestCaseTypesSection projectId="proj-1" isWA />)

    fireEvent.click(screen.getByRole('button', { name: /add new/i }))

    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
  })

  it('BR16: shows an inline length error over 60 characters and disables Save', () => {
    render(<TestCaseTypesSection projectId="proj-1" isWA />)
    fireEvent.click(screen.getByRole('button', { name: /add new/i }))

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'x'.repeat(61) } })

    expect(screen.getByText(/60 characters or fewer/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
  })

  it('BR16: a duplicate-name refusal from the server surfaces inline, not just as a toast', async () => {
    createTestCaseType.mockRejectedValue(
      new Error('"Acceptance" already exists as a Test Case Type in this project'),
    )
    render(<TestCaseTypesSection projectId="proj-1" isWA />)
    fireEvent.click(screen.getByRole('button', { name: /add new/i }))

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'acceptance' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() =>
      expect(screen.getByText(/already exists as a Test Case Type/i)).toBeInTheDocument(),
    )
  })

  it('trims the name before submitting', async () => {
    createTestCaseType.mockResolvedValue({ id: 'type-3', name: 'Smoke', position: 2 })
    render(<TestCaseTypesSection projectId="proj-1" isWA />)
    fireEvent.click(screen.getByRole('button', { name: /add new/i }))

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: '  Smoke  ' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => expect(createTestCaseType).toHaveBeenCalledWith('Smoke'))
  })

  it('BR17: the remove confirmation names what survives, and archives only after confirming', () => {
    render(<TestCaseTypesSection projectId="proj-1" isWA />)

    fireEvent.click(screen.getByRole('button', { name: /remove acceptance/i }))

    expect(
      screen.getByText(/Existing Test Cases keep their historical Type value/i),
    ).toBeInTheDocument()
    expect(archiveTestCaseType).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /^remove$/i }))
    expect(archiveTestCaseType).toHaveBeenCalledWith('type-1', expect.anything())
  })

  it('renders an empty state when the project has no Types', () => {
    testCaseTypes.mockReturnValue({ data: [], isLoading: false })
    render(<TestCaseTypesSection projectId="proj-1" isWA={false} />)

    expect(screen.getByText(/no test case types yet/i)).toBeInTheDocument()
  })
})
