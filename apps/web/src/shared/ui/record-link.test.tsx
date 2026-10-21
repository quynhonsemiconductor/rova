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

import { RecordOpener, isInAppPath } from './record-link'

/** Fire a click and report whether the handler prevented the browser's default. */
function click(el: HTMLElement, init: MouseEventInit = {}): boolean {
  const event = createEvent.click(el, { button: 0, ...init })
  fireEvent(el, event)
  return event.defaultPrevented
}

describe('RecordOpener with an in-app URL (the link)', () => {
  it('is a real link to the record', () => {
    render(
      <RecordOpener href="/item/US-120" onOpen={() => {}}>
        US-120
      </RecordOpener>,
    )
    expect(screen.getByRole('link', { name: 'US-120' }).getAttribute('href')).toBe('/item/US-120')
  })

  it('routes a plain click to onOpen and prevents the full page load', () => {
    const onOpen = vi.fn()
    render(
      <RecordOpener href="/item/US-120" onOpen={onOpen}>
        US-120
      </RecordOpener>,
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
      <RecordOpener href="/item/US-120" onOpen={onOpen}>
        US-120
      </RecordOpener>,
    )
    expect(click(screen.getByRole('link'), mods)).toBe(false)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('never lets a click reach the row it sits in, modified or not', () => {
    const rowClick = vi.fn()
    const rowAux = vi.fn()
    render(
      <div onClick={rowClick} onAuxClick={rowAux}>
        <RecordOpener href="/item/US-1" onOpen={() => {}}>
          US-1
        </RecordOpener>
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

describe('RecordOpener', () => {
  it('without a URL is a button that, like the link, lets no click or middle-click reach the row', () => {
    const rowClick = vi.fn()
    const rowAux = vi.fn()
    const onOpen = vi.fn()
    render(
      <div onClick={rowClick} onAuxClick={rowAux}>
        <RecordOpener href={undefined} onOpen={onOpen} ariaLabel="Open FE-1">
          FE-1
        </RecordOpener>
      </div>,
    )
    const button = screen.getByRole('button', { name: 'Open FE-1' })
    click(button)
    fireEvent(button, new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(rowClick).not.toHaveBeenCalled()
    expect(rowAux).not.toHaveBeenCalled()
  })

  it('with a URL is the link, carrying the same accessible name', () => {
    render(
      <RecordOpener href="/portfolio/pf-1" onOpen={() => {}} ariaLabel="Open FE-1">
        FE-1
      </RecordOpener>,
    )
    expect(screen.getByRole('link', { name: 'Open FE-1' }).getAttribute('href')).toBe(
      '/portfolio/pf-1',
    )
  })
})

describe('isInAppPath', () => {
  it.each(['/item/US-1', '/portfolio/pf-1', '/test-case/TC-1'])(
    'admits the in-app path %s',
    (href) => {
      expect(isInAppPath(href)).toBe(true)
    },
  )

  it.each([
    'javascript:alert(1)',
    'https://example.com/item/US-1',
    '//example.com/item/US-1',
    '/\\example.com/item/US-1',
    'item/US-1',
    '',
    // The URL parser deletes tab / LF / CR, so each of these resolves to //evil.com.
    '/\n//evil.com',
    '/\t//evil.com',
    '/\r//evil.com',
    '/item/US-1\n',
  ])('refuses %j', (href) => {
    expect(isInAppPath(href)).toBe(false)
  })
})

describe('RecordOpener refuses a URL that is not an in-app path', () => {
  it.each(['javascript:alert(1)', '//example.com/x'])(
    'renders %s as the in-place button, never as a link',
    (href) => {
      const onOpen = vi.fn()
      render(
        <RecordOpener href={href} onOpen={onOpen}>
          US-1
        </RecordOpener>,
      )
      expect(screen.queryByRole('link')).toBeNull()
      click(screen.getByRole('button', { name: 'US-1' }))
      expect(onOpen).toHaveBeenCalledTimes(1)
    },
  )
})

describe('RecordOpener styling', () => {
  it("gives the link and the button fallback the SAME reset, under the caller's own classes", () => {
    const { rerender } = render(
      <RecordOpener href="/item/US-1" onOpen={() => {}} className="flex gap-1">
        US-1
      </RecordOpener>,
    )
    const linkClasses = screen.getByRole('link').classList
    rerender(
      <RecordOpener href={undefined} onOpen={() => {}} className="flex gap-1">
        US-1
      </RecordOpener>,
    )
    const buttonClasses = screen.getByRole('button').classList
    for (const cls of [
      'group',
      'cursor-pointer',
      'border-none',
      'bg-transparent',
      'p-0',
      'flex',
      'gap-1',
    ]) {
      expect(linkClasses.contains(cls)).toBe(true)
      expect(buttonClasses.contains(cls)).toBe(true)
    }
  })

  it("lets a caller's class override the reset (tailwind-merge)", () => {
    render(
      <RecordOpener href="/item/US-1" onOpen={() => {}} className="p-2">
        US-1
      </RecordOpener>,
    )
    const classes = screen.getByRole('link').classList
    expect(classes.contains('p-2')).toBe(true)
    expect(classes.contains('p-0')).toBe(false)
  })
})
