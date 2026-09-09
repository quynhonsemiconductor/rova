/**
 * The per-ROW Delete on the Test Cases tab (F2). Mirrors `work-item-row-actions.test.tsx`'s own
 * shape — same shared `RowActionsMenu` shell, different mutation and copy.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const { del, notifySuccess, notifyError } = vi.hoisted(() => ({
  del: vi.fn(),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
}))

vi.mock('@/shared/lib/toast', () => ({
  notify: { success: notifySuccess, error: notifyError },
}))
vi.mock('@/features/test-cases/api', () => ({
  useDeleteTestCase: () => ({ mutateAsync: del, isPending: false }),
}))

import '@/shared/i18n/i18n'
import { TestCaseRowActions } from './test-case-row-actions'

const renderActions = (canDelete = true) =>
  render(
    <TestCaseRowActions
      testCaseId="tc-1"
      testCaseKey="TC-3"
      workItemId="wi-1"
      canDelete={canDelete}
    />,
  )

async function openDeleteConfirm() {
  fireEvent.click(screen.getByRole('button', { name: /Actions for TC-3/i }))
  fireEvent.click(await screen.findByText('Delete'))
}

describe('TestCaseRowActions', () => {
  beforeEach(() => {
    del.mockReset()
    del.mockResolvedValue(undefined)
    notifySuccess.mockReset()
    notifyError.mockReset()
  })

  it('renders NOTHING without `test_case:delete`', () => {
    const { container } = renderActions(false)
    expect(container).toBeEmptyDOMElement()
  })

  it('names what survives — Results do NOT survive independently', async () => {
    renderActions()
    await openDeleteConfirm()

    expect(
      screen.getByText(
        'Delete TC-3? Its Results are deleted with it and do not survive independently.',
      ),
    ).toBeInTheDocument()
  })

  it('deletes only after the confirmation is accepted', async () => {
    renderActions()
    await openDeleteConfirm()

    expect(del).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(del).toHaveBeenCalledWith('tc-1'))
    await waitFor(() => expect(notifySuccess).toHaveBeenCalled())
  })

  it('sends nothing when the confirmation is cancelled', async () => {
    renderActions()
    await openDeleteConfirm()

    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }))
    expect(del).not.toHaveBeenCalled()
  })

  it("reports the SERVER's own sentence when the delete is refused", async () => {
    del.mockRejectedValue(new Error('WORK_ITEM_NOT_FOUND'))
    renderActions()
    await openDeleteConfirm()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(notifyError).toHaveBeenCalledWith('WORK_ITEM_NOT_FOUND'))
  })
})
