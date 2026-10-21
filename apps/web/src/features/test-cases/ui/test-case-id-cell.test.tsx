/**
 * `TestCaseIdCell` renders `Button asChild` over a `RecordLink` (US-120). `asChild` only works if the
 * Button's classes land on the final `<a>` and the link keeps its click contract, so both are pinned
 * on the rendered element rather than assumed from the composition.
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
})
