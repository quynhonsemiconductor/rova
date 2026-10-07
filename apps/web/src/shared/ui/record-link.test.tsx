/**
 * US-120 — an item can be opened in a new tab.
 *
 * The contract is split between the browser and us, and both halves are pinned here:
 *  - the link carries a real `href`, which is what Ctrl/Cmd+click, middle-click and the context
 *    menu's "Open link in new tab" need — none of that can work on a `<button>`;
 *  - a PLAIN click is still ours: it is prevented and routed to `onOpen`, so in-app navigation
 *    (or the Backlog's summary panel) behaves exactly as before;
 *  - a modified click is NOT prevented and does NOT call `onOpen`, so the current tab stays put
 *    while the browser opens the new one.
 */
import { describe, expect, it, vi } from 'vitest'
import { createEvent, fireEvent, render, screen } from '@testing-library/react'

import { isNewTabClick } from '@/shared/lib/new-tab-click'
import { RecordLink } from './record-link'

/** Fire a click and report whether the handler prevented the browser's default. */
function click(el: HTMLElement, init: MouseEventInit = {}): boolean {
  const event = createEvent.click(el, { button: 0, ...init })
  fireEvent(el, event)
  return event.defaultPrevented
}

describe('isNewTabClick', () => {
  it('is false only for a plain primary click', () => {
    const plain = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }
    expect(isNewTabClick(plain)).toBe(false)
    expect(isNewTabClick({ ...plain, ctrlKey: true })).toBe(true)
    expect(isNewTabClick({ ...plain, metaKey: true })).toBe(true)
    expect(isNewTabClick({ ...plain, shiftKey: true })).toBe(true)
    expect(isNewTabClick({ ...plain, altKey: true })).toBe(true)
    expect(isNewTabClick({ ...plain, button: 1 })).toBe(true)
  })
})

describe('RecordLink', () => {
  it('is a real link to the record', () => {
    render(
      <RecordLink href="/item/US-120" onOpen={() => {}}>
        US-120
      </RecordLink>,
    )
    expect(screen.getByRole('link', { name: 'US-120' }).getAttribute('href')).toBe('/item/US-120')
  })

  it('routes a plain click to onOpen and prevents the full page load', () => {
    const onOpen = vi.fn()
    render(
      <RecordLink href="/item/US-120" onOpen={onOpen}>
        US-120
      </RecordLink>,
    )
    expect(click(screen.getByRole('link'))).toBe(true)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['Ctrl', { ctrlKey: true }],
    ['Cmd', { metaKey: true }],
    ['Shift', { shiftKey: true }],
  ])('leaves %s+click to the browser (new tab) and does not navigate this tab', (_, mods) => {
    const onOpen = vi.fn()
    render(
      <RecordLink href="/item/US-120" onOpen={onOpen}>
        US-120
      </RecordLink>,
    )
    expect(click(screen.getByRole('link'), mods)).toBe(false)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('never lets a click reach the row it sits in, modified or not', () => {
    const rowClick = vi.fn()
    const rowAux = vi.fn()
    render(
      <div onClick={rowClick} onAuxClick={rowAux}>
        <RecordLink href="/item/US-1" onOpen={() => {}}>
          US-1
        </RecordLink>
      </div>,
    )
    const link = screen.getByRole('link')
    click(link)
    click(link, { ctrlKey: true })
    fireEvent(link, new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    expect(rowClick).not.toHaveBeenCalled()
    expect(rowAux).not.toHaveBeenCalled()
  })
})
