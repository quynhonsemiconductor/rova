/**
 * `TestCaseIdCell` renders the Button link styling on a `RecordOpener` (US-120). Pinned on the
 * rendered element: ONE real link carrying the styling, no nested button, and the link's click
 * contract.
 */
import { describe, expect, it, vi } from 'vitest'
import { createEvent, fireEvent, render, screen } from '@testing-library/react'
import { TestCaseIdCell } from './test-case-id-cell'

function click(el: HTMLElement, init: MouseEventInit = {}): boolean {
  const event = createEvent.click(el, { button: 0, ...init })
  fireEvent(el, event)
  return event.defaultPrevented
}

describe('TestCaseIdCell', () => {
  it('is ONE real link to the Test Case, carrying the Button styling', () => {
    render(<TestCaseIdCell testCaseKey="TC-4" onOpen={() => {}} />)
    const link = screen.getByRole('link', { name: 'TC-4' })
    expect(link.getAttribute('href')).toBe('/test-case/TC-4')
    expect(link.className).toContain('font-mono')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('opens in place on a plain click without reaching the row, and leaves Ctrl+click to the browser', () => {
    const onOpen = vi.fn()
    const rowClick = vi.fn()
    render(
      <div onClick={rowClick}>
        <TestCaseIdCell testCaseKey="TC-4" onOpen={onOpen} />
      </div>,
    )
    const link = screen.getByRole('link', { name: 'TC-4' })

    expect(click(link)).toBe(true)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(click(link, { ctrlKey: true })).toBe(false)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(rowClick).not.toHaveBeenCalled()
  })

  it('gives a Test Case with no key yet (an optimistic row) no URL, never a bare /test-case/', () => {
    render(<TestCaseIdCell testCaseKey="" onOpen={() => {}} />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByRole('button')).toBeTruthy()
  })
})
