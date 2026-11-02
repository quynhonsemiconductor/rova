/**
 * `CellLink` renders a link when it has a URL and a button when it does not; its accessible name
 * must not depend on which one it turned out to be.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CellLink } from './cell-link'

describe('CellLink', () => {
  it('carries the same accessible name as a link and as a button', () => {
    const { rerender } = render(
      <CellLink onClick={() => {}} href="/iteration/it-1" ariaLabel="Open iteration IT-1">
        IT-1
      </CellLink>,
    )
    expect(screen.getByRole('link', { name: 'Open iteration IT-1' })).toBeTruthy()

    rerender(
      <CellLink onClick={() => {}} ariaLabel="Open iteration IT-1">
        IT-1
      </CellLink>,
    )
    expect(screen.getByRole('button', { name: 'Open iteration IT-1' })).toBeTruthy()
  })
})
