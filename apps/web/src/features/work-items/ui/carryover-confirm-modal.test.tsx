/**
 * CarryoverConfirmModal (CO-04/05) — one / many / no targets, and that every way of leaving the modal
 * without Accept makes ZERO mutations (CO-BR-25).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const { mutateAsync } = vi.hoisted(() => ({ mutateAsync: vi.fn() }))
vi.mock('../carryover-api', () => ({
  useCarryOverWorkItem: () => ({ mutateAsync, isPending: false }),
}))

import '@/shared/i18n/i18n'
import { CarryoverConfirmModal, type CarryoverConfirmModalProps } from './carryover-confirm-modal'

const it_ = (id: string, name: string, startDate: string, endDate: string) => ({
  id,
  name,
  iterationKey: null,
  state: 'planning',
  startDate,
  endDate,
  teamId: 't',
})
const B = it_('B', 'Sprint B', '2030-01-21', '2030-02-01')
const O = it_('O', 'Sprint O', '2030-01-28', '2030-02-08')

function renderModal(over: Partial<CarryoverConfirmModalProps> = {}) {
  const onClose = vi.fn()
  render(
    <CarryoverConfirmModal
      open
      onClose={onClose}
      workItemId="wi-1"
      itemKey="US-7"
      targetEndDate="2030-01-30"
      source={{ id: 'A', name: 'Sprint A', startDate: '2030-01-07', endDate: '2030-01-18' }}
      targets={[B]}
      taskCount={3}
      unfinishedTaskCount={2}
      {...over}
    />,
  )
  return { onClose }
}

const accept = () => screen.getByRole('button', { name: 'Accept & Carry Over' })

describe('CarryoverConfirmModal', () => {
  beforeEach(() => {
    mutateAsync.mockReset()
    mutateAsync.mockResolvedValue({})
  })

  it('summarises the story, date, ranges and task counts (BR-21)', () => {
    renderModal()
    expect(screen.getByText('This User Story will carry over')).toBeInTheDocument()
    expect(screen.getByText('US-7')).toBeInTheDocument()
    expect(screen.getByText('Sprint A')).toBeInTheDocument()
    expect(screen.getByText('Sprint B')).toBeInTheDocument()
    expect(screen.getByText('3 total · 2 unfinished')).toBeInTheDocument()
  })

  it('proposes the single target and Accept posts the echoed source (BR-19/22)', async () => {
    const { onClose } = renderModal()
    expect(accept()).toBeEnabled()
    fireEvent.click(accept())
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        expectedSourceIterationId: 'A',
        targetIterationId: 'B',
        targetEndDate: '2030-01-30',
      }),
    )
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('makes the reader choose among several targets (BR-20)', async () => {
    renderModal({ targets: [B, O] })
    expect(accept()).toBeDisabled()
    fireEvent.click(screen.getByRole('radio', { name: /Sprint O/ }))
    expect(accept()).toBeEnabled()
    fireEvent.click(accept())
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ targetIterationId: 'O' })),
    )
  })

  it('shows the no-destination state with Accept disabled', () => {
    renderModal({ targets: [] })
    expect(screen.getByText(/No destination iteration contains/)).toBeInTheDocument()
    expect(accept()).toBeDisabled()
  })

  it('Cancel closes with no mutation (BR-25)', () => {
    const { onClose } = renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
    expect(mutateAsync).not.toHaveBeenCalled()
  })

  it('Escape closes with no mutation (BR-25)', () => {
    const { onClose } = renderModal()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    expect(mutateAsync).not.toHaveBeenCalled()
  })

  it('keeps the modal open and shows the server message when the write fails', async () => {
    mutateAsync.mockRejectedValue(new Error('This story has moved'))
    const { onClose } = renderModal()
    fireEvent.click(accept())
    expect(await screen.findByRole('alert')).toHaveTextContent('This story has moved')
    expect(onClose).not.toHaveBeenCalled()
  })
})
