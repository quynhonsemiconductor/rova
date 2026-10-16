/**
 * US-120 — ID and reference cells carry the record's URL, so they open in a new tab on
 * Ctrl/Cmd+click or middle-click. The click semantics themselves are pinned in
 * `shared/ui/record-link.test.tsx`.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { IdCell } from './id-cell'
import { WorkItemRefCell } from './work-item-ref-cell'
import { defaultRecordHref } from '../model/record-href'

describe('defaultRecordHref', () => {
  it('derives /item/{key} for a work item, and nothing for a record addressed by id', () => {
    expect(defaultRecordHref('story', 'US-120')).toBe('/item/US-120')
    expect(defaultRecordHref('task', 'TA-3')).toBe('/item/TA-3')
    expect(defaultRecordHref('defect', 'DE-9')).toBe('/item/DE-9')
    expect(defaultRecordHref('feature', 'FE-1')).toBeUndefined()
    expect(defaultRecordHref('release', 'RL-1')).toBeUndefined()
  })
})

describe('IdCell / WorkItemRefCell carry the record URL', () => {
  it('IdCell links a work item to its detail page by default', () => {
    render(<IdCell type="story" itemKey="US-120" onOpen={() => {}} />)
    expect(screen.getByRole('link', { name: /US-120/ }).getAttribute('href')).toBe('/item/US-120')
  })

  it('IdCell uses the explicit href for a record addressed by id', () => {
    render(<IdCell type="feature" itemKey="FE-1" onOpen={() => {}} href="/portfolio/abc" />)
    expect(screen.getByRole('link', { name: /FE-1/ }).getAttribute('href')).toBe('/portfolio/abc')
  })

  it('IdCell stays a button when no URL is known, and plain text when it cannot be opened', () => {
    const { rerender } = render(<IdCell type="feature" itemKey="FE-1" onOpen={() => {}} />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByRole('button', { name: /FE-1/ })).toBeTruthy()
    rerender(<IdCell type="story" itemKey="US-1" />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
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
