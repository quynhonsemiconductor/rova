/**
 * Calendar's opening month (PR #653 review, round 3): `defaultMonth` may arrive AFTER mount (the
 * Target End picker feeds it from an async payload), and the shown month must follow it until the
 * reader navigates — not stay frozen on the month a `useState` initializer computed once.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Calendar } from './calendar'

const title = () => screen.getByText(/^[A-Z][a-z]+ \d{4}$/).textContent

describe('Calendar — opening month', () => {
  it('opens on the selected value, ahead of defaultMonth', () => {
    render(<Calendar value="2030-03-04" defaultMonth="2030-01-07" onSelect={vi.fn()} />)
    expect(title()).toBe('March 2030')
  })

  it('opens on defaultMonth when there is no value', () => {
    render(<Calendar value={null} defaultMonth="2030-01-07" onSelect={vi.fn()} />)
    expect(title()).toBe('January 2030')
  })

  it('follows a defaultMonth that arrives after mount', () => {
    const { rerender } = render(<Calendar value={null} defaultMonth={null} onSelect={vi.fn()} />)
    rerender(<Calendar value={null} defaultMonth="2030-01-07" onSelect={vi.fn()} />)
    expect(title()).toBe('January 2030')
  })

  it('keeps the month the reader navigated to when defaultMonth changes later', () => {
    const { rerender } = render(
      <Calendar value={null} defaultMonth="2030-01-07" onSelect={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
    expect(title()).toBe('March 2030')
    rerender(<Calendar value={null} defaultMonth="2030-06-01" onSelect={vi.fn()} />)
    expect(title()).toBe('March 2030')
  })

  it('navigates back from the derived month', () => {
    render(<Calendar value={null} defaultMonth="2030-01-07" onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }))
    expect(title()).toBe('December 2029')
  })
})
