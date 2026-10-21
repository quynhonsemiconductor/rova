/**
 * US-120 — ID and reference cells carry the record's URL, so they open in a new tab on
 * Ctrl/Cmd+click or middle-click. The click semantics themselves are pinned in
 * `shared/ui/record-link.test.tsx`.
 */
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { createEvent, fireEvent, render, screen } from '@testing-library/react'

import { IdCell } from './id-cell'
import { WorkItemRefCell } from './work-item-ref-cell'

describe('IdCell / WorkItemRefCell carry the record URL', () => {
  it('IdCell links a work item to its detail page by default', () => {
    render(<IdCell type="story" itemKey="US-120" onOpen={() => {}} />)
    expect(screen.getByRole('link', { name: /US-120/ }).getAttribute('href')).toBe('/item/US-120')
  })

  it('IdCell uses the explicit href for a record addressed by id', () => {
    render(<IdCell type="feature" itemKey="FE-1" onOpen={() => {}} href="/portfolio/abc" />)
    expect(screen.getByRole('link', { name: /FE-1/ }).getAttribute('href')).toBe('/portfolio/abc')
  })

  it('IdCell derives a portfolio URL from recordId, so a mixed grid needs no per-row split', () => {
    render(<IdCell type="feature" itemKey="FE-1" onOpen={() => {}} recordId="pf-1" />)
    expect(screen.getByRole('link', { name: /FE-1/ }).getAttribute('href')).toBe('/portfolio/pf-1')
  })

  it('IdCell stays a button when no URL is known, and plain text when it cannot be opened', () => {
    const { rerender } = render(<IdCell type="feature" itemKey="FE-1" onOpen={() => {}} />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByRole('button', { name: /FE-1/ })).toBeTruthy()
    rerender(<IdCell type="story" itemKey="US-1" />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  // The cell a permission gate relies on (Iteration Status' Feature column, §3.2:85): no `onOpen`
  // means read-only text, and a URL passed anyway must not become a link.
  it('WorkItemRefCell without onOpen ignores href and renders text', () => {
    render(<WorkItemRefCell type="feature" itemKey="FE-2" href="/portfolio/pf-1" />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText(/FE-2/)).toBeTruthy()
  })

  it('WorkItemRefCell derives a portfolio URL from recordId, as IdCell does', () => {
    render(<WorkItemRefCell type="feature" itemKey="FE-2" onOpen={() => {}} recordId="pf-2" />)
    expect(screen.getByRole('link').getAttribute('href')).toBe('/portfolio/pf-2')
  })

  it('WorkItemRefCell links both variants', () => {
    const { rerender } = render(
      <WorkItemRefCell type="story" itemKey="US-6" title="Parent" onOpen={() => {}} />,
    )
    expect(screen.getByRole('link').getAttribute('href')).toBe('/item/US-6')
    rerender(
      <WorkItemRefCell
        type="story"
        itemKey="US-6"
        title="Parent"
        onOpen={() => {}}
        variant="pill"
      />,
    )
    expect(screen.getByRole('link').getAttribute('href')).toBe('/item/US-6')
  })
})

/** Fire a click and report whether the handler prevented the browser's default. */
function click(el: HTMLElement, init: MouseEventInit = {}): boolean {
  const event = createEvent.click(el, { button: 0, ...init })
  fireEvent(el, event)
  return event.defaultPrevented
}

/**
 * The contract the cells inherit from `RecordOpener` now that the click handling moved there: every
 * host grid's ROW has its own click handler, so a plain click must open the record ONCE and never
 * reach the row; a new-tab gesture must be left to the browser and must not ALSO open in place.
 */
describe.each<[string, (onOpen: () => void) => ReactElement]>([
  ['IdCell', (onOpen) => <IdCell type="story" itemKey="US-7" onOpen={onOpen} />],
  [
    'WorkItemRefCell (inline)',
    (onOpen) => <WorkItemRefCell type="story" itemKey="US-7" onOpen={onOpen} />,
  ],
  [
    'WorkItemRefCell (pill)',
    (onOpen) => <WorkItemRefCell type="story" itemKey="US-7" onOpen={onOpen} variant="pill" />,
  ],
])('%s inside a clickable row', (_name, cell) => {
  it('a plain click opens in place once and never reaches the row', () => {
    const onOpen = vi.fn()
    const rowClick = vi.fn()
    render(<div onClick={rowClick}>{cell(onOpen)}</div>)

    expect(click(screen.getByRole('link'))).toBe(true)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(rowClick).not.toHaveBeenCalled()
  })

  it('a Ctrl/Cmd+click is left to the browser — no in-place open, no row click', () => {
    const onOpen = vi.fn()
    const rowClick = vi.fn()
    render(<div onClick={rowClick}>{cell(onOpen)}</div>)

    expect(click(screen.getByRole('link'), { ctrlKey: true })).toBe(false)
    expect(click(screen.getByRole('link'), { metaKey: true })).toBe(false)
    expect(onOpen).not.toHaveBeenCalled()
    expect(rowClick).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})

describe('an empty href is no URL', () => {
  it('falls back to the derived URL instead of rendering <a href=""> (the current page)', () => {
    render(<IdCell type="story" itemKey="US-8" onOpen={() => {}} href="" />)
    expect(screen.getByRole('link').getAttribute('href')).toBe('/item/US-8')
  })

  it('does the same in WorkItemRefCell', () => {
    render(<WorkItemRefCell type="story" itemKey="US-8" onOpen={() => {}} href="" />)
    expect(screen.getByRole('link').getAttribute('href')).toBe('/item/US-8')
  })
})

describe('IdCell with no URL to derive (an unaddressed type)', () => {
  it('is a focusable button that opens in place once and never reaches the row', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {}) // unaddressed type, on purpose
    const onOpen = vi.fn()
    const rowClick = vi.fn()
    render(
      <div onClick={rowClick}>
        <IdCell type="iteration" itemKey="IT-3" onOpen={onOpen} />
      </div>,
    )
    expect(screen.queryByRole('link')).toBeNull()
    const button = screen.getByRole('button', { name: /IT-3/ })
    button.focus()
    expect(document.activeElement).toBe(button)

    click(button)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(rowClick).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})

// The hover underline is scoped to the opener's NAMED group: a bare `group-hover:` matched any
// ancestor `group`, and most grid rows carry one, so every ID underlined on row hover.
describe('the label underline belongs to the opener, not the row', () => {
  it.each<[string, ReactElement]>([
    ['IdCell', <IdCell key="id" type="story" itemKey="US-4" onOpen={() => {}} />],
    [
      'WorkItemRefCell',
      <WorkItemRefCell key="ref" type="story" itemKey="US-4" onOpen={() => {}} />,
    ],
  ])('%s scopes group-hover to group/record', (_name, cell) => {
    render(<div className="group">{cell}</div>)
    const link = screen.getByRole('link')
    expect(link.classList.contains('group/record')).toBe(true)
    const classes = [link, ...link.querySelectorAll('*')].flatMap((el) => [...el.classList])
    expect(classes).toContain('group-hover/record:underline')
    expect(classes).not.toContain('group-hover:underline')
  })
})

describe('WorkItemRefCell pill keeps its border under the opener reset', () => {
  it('replaces the reset border-none with border-solid, so the border paints', () => {
    render(
      <WorkItemRefCell
        type="story"
        itemKey="US-6"
        title="Parent"
        onOpen={() => {}}
        variant="pill"
      />,
    )
    const pill = screen.getByRole('link')
    expect(pill.classList.contains('border-solid')).toBe(true)
    expect(pill.classList.contains('border-none')).toBe(false)
  })
})
