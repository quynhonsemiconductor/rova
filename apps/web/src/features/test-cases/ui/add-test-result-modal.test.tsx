/**
 * `AddTestResultModal` (Phase D — SRS §8).
 *
 * AC9: Save disabled without Build/Date/Tester. Verdict defaults Pass, Duration defaults 0 with
 * `min=0`. Test Case and Work Product render read-only (BR13 — no field, no picker, could not send
 * either even if it tried).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const createTestResult = vi.fn()
const useTestCase = vi.fn()
const useWorkItem = vi.fn()
const teamOwnerOptions = vi.fn()

vi.mock('@/features/test-cases/api', () => ({
  useCreateTestResult: () => ({ mutateAsync: createTestResult }),
  useTestCase: (...args: unknown[]) => useTestCase(...args),
}))
vi.mock('@/features/work-items/api', () => ({
  useWorkItem: (...args: unknown[]) => useWorkItem(...args),
}))
vi.mock('@/features/teams/api', () => ({
  useTeamOwnerOptions: (...args: unknown[]) => teamOwnerOptions(...args),
}))

import '@/shared/i18n/i18n'
import { AddTestResultModal } from './add-test-result-modal'

const TESTER = { userId: 'admin-1', displayName: 'Admin User', email: 'admin@qnsc.dev' }
const TEST_CASE = { id: 'tc-1', testCaseKey: 'TC-1', workItemId: 'wi-1', teamId: 'team-1' }
const WORK_ITEM = { id: 'wi-1', itemKey: 'US-17' }

beforeEach(() => {
  vi.clearAllMocks()
  createTestResult.mockResolvedValue({ id: 'tr-1', testResultKey: 'TR-1' })
  useTestCase.mockReturnValue({ data: TEST_CASE })
  useWorkItem.mockReturnValue({ data: WORK_ITEM })
  teamOwnerOptions.mockReturnValue({ data: [TESTER] })
})

function open(onClose = vi.fn()) {
  render(<AddTestResultModal testCaseId="tc-1" projectId="proj-1" onClose={onClose} />)
}

function fillRequired() {
  fireEvent.change(screen.getByLabelText(/^Build/), { target: { value: 'build-42' } })
  fireEvent.click(screen.getByRole('button', { name: 'Tester' }))
  fireEvent.click(screen.getByText('Admin User'))
}

describe('AddTestResultModal', () => {
  it('AC9: Save is disabled while Build is blank', () => {
    open()

    expect(screen.getByRole('button', { name: /^Save$/ })).toBeDisabled()
  })

  it('AC9: Save is disabled while no Tester is selected', () => {
    open()
    fireEvent.change(screen.getByLabelText(/^Build/), { target: { value: 'build-42' } })

    expect(screen.getByRole('button', { name: /^Save$/ })).toBeDisabled()
  })

  it('AC9: Save becomes enabled once Build, Date and Tester are all set', () => {
    open()
    fillRequired()

    expect(screen.getByRole('button', { name: /^Save$/ })).not.toBeDisabled()
  })

  it('Date defaults to TODAY via todayIsoDate (not a UTC-converted value)', () => {
    open()

    const today = new Date()
    const yyyy = today.getFullYear()
    const mm = String(today.getMonth() + 1).padStart(2, '0')
    const dd = String(today.getDate()).padStart(2, '0')
    expect(screen.getByText(`${yyyy}-${mm}-${dd}`)).toBeInTheDocument()
  })

  it('Verdict defaults to Pass', async () => {
    open()
    fillRequired()
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))

    await vi.waitFor(() => expect(createTestResult).toHaveBeenCalled())
    expect(createTestResult.mock.calls[0][0].verdict).toBe('pass')
  })

  it('Duration defaults to 0 and the input carries min=0', () => {
    open()

    const durationInput = screen.getByLabelText(/duration/i) as HTMLInputElement
    expect(durationInput.value).toBe('0')
    expect(durationInput).toHaveAttribute('min', '0')
  })

  it('BR13: renders the Test Case key and Work Product read-only — no field, no picker', () => {
    open()

    expect(screen.getByText('TC-1')).toBeInTheDocument()
    expect(screen.getByText('US-17')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /work product/i })).not.toBeInTheDocument()
  })

  it('submits build/runDate/verdict/durationMinutes/testerId, and closes on success', async () => {
    const onClose = vi.fn()
    open(onClose)
    fillRequired()
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))

    await vi.waitFor(() => expect(createTestResult).toHaveBeenCalled())
    expect(createTestResult.mock.calls[0][0]).toMatchObject({
      build: 'build-42',
      verdict: 'pass',
      durationMinutes: 0,
      testerId: 'admin-1',
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('shows a modal-level error banner on a failed submit', async () => {
    createTestResult.mockRejectedValue(new Error('WORK_ITEM_ASSIGNEE_NOT_ELIGIBLE'))
    open()
    fillRequired()
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('WORK_ITEM_ASSIGNEE_NOT_ELIGIBLE')
  })
})
