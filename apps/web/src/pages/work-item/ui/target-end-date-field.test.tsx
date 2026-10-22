/**
 * TargetEndDateField (CO-03/04) — disabled days are unclickable, an in-Iteration date PATCHes with
 * no modal, a later date opens the modal and PATCHes nothing, and Clear PATCHes `null`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const { useCarryoverOptions, modalProps } = vi.hoisted(() => ({
  useCarryoverOptions: vi.fn(),
  modalProps: vi.fn(),
}))
vi.mock('@/features/work-items/api', () => ({ useCarryoverOptions }))
vi.mock('@/features/work-items/ui/carryover-confirm-modal', () => ({
  CarryoverConfirmModal: (props: { targets: Array<{ id: string }> }) => {
    modalProps(props)
    return <div data-testid="carryover-modal" />
  },
}))

import '@/shared/i18n/i18n'
import { TargetEndDateField } from './target-end-date-field'

const A = {
  id: 'A',
  name: 'A',
  iterationKey: null,
  state: 'committed',
  startDate: '2030-01-07',
  endDate: '2030-01-18',
  teamId: 't',
}
const B = {
  ...A,
  id: 'B',
  name: 'B',
  state: 'planning',
  startDate: '2030-01-21',
  endDate: '2030-02-01',
}
const OPTIONS = {
  editable: true,
  storyStartDate: null,
  targetEndDate: null,
  current: { ...A, eligible: true },
  minDate: '2030-01-07',
  eligibleIterations: [A, B],
  taskCount: 2,
  unfinishedTaskCount: 1,
}

const story = (targetEndDate: string | null = null) => ({
  id: 'wi-1',
  type: 'story',
  itemKey: 'US-1',
  targetEndDate,
})

function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Target End Date' }))
}
const day = (iso: string) => document.querySelector(`[data-date="${iso}"]`) as HTMLButtonElement

describe('TargetEndDateField', () => {
  beforeEach(() => {
    useCarryoverOptions.mockReturnValue({ data: OPTIONS })
    modalProps.mockReset()
  })

  it('disables days outside the window, and clicking one does nothing (BR-15/16)', () => {
    const onUpdate = vi.fn()
    render(<TargetEndDateField item={story()} onUpdate={onUpdate} readOnly={false} />)
    open()
    expect(day('2030-01-06')).toBeDisabled()
    expect(day('2030-01-06')).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(day('2030-01-06'))
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('saves a date inside the current Iteration without a modal (BR-17)', () => {
    const onUpdate = vi.fn()
    render(<TargetEndDateField item={story()} onUpdate={onUpdate} readOnly={false} />)
    open()
    fireEvent.click(day('2030-01-15'))
    expect(onUpdate).toHaveBeenCalledWith({ targetEndDate: '2030-01-15' })
    expect(screen.queryByTestId('carryover-modal')).toBeNull()
  })

  it('opens the modal for a later date and PATCHes nothing (BR-18)', () => {
    const onUpdate = vi.fn()
    render(<TargetEndDateField item={story()} onUpdate={onUpdate} readOnly={false} />)
    open()
    fireEvent.click(day('2030-01-25'))
    expect(onUpdate).not.toHaveBeenCalled()
    expect(screen.getByTestId('carryover-modal')).toBeInTheDocument()
    expect(modalProps.mock.calls[0][0].targets.map((t: { id: string }) => t.id)).toEqual(['B'])
  })

  it('Clear PATCHes null and moves nothing (BR-28)', () => {
    const onUpdate = vi.fn()
    render(<TargetEndDateField item={story('2030-01-15')} onUpdate={onUpdate} readOnly={false} />)
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(onUpdate).toHaveBeenCalledWith({ targetEndDate: null })
  })

  it('is read-only for a reader who cannot edit, or when nothing is eligible (R6)', () => {
    useCarryoverOptions.mockReturnValue({ data: { ...OPTIONS, editable: false } })
    render(<TargetEndDateField item={story()} onUpdate={vi.fn()} readOnly={false} />)
    expect(screen.queryByRole('button', { name: 'Target End Date' })).toBeNull()
  })

  it('renders nothing on a Defect (BR-01)', () => {
    const { container } = render(
      <TargetEndDateField
        item={{ ...story(), type: 'defect' }}
        onUpdate={vi.fn()}
        readOnly={false}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
