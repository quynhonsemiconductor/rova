import '@/shared/i18n/i18n'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { GuideContext } from '../guide-context'
import { PathCard, PathGrid } from './home'

function renderGrid(query: string) {
  return render(
    <GuideContext.Provider value={{ lang: 'en', chapter: '00-bat-dau', query }}>
      <PathGrid empty="Nothing matches">
        <PathCard keywords="backlog work items">Backlog card</PathCard>
        <PathCard keywords="reports metrics">Reports card</PathCard>
      </PathGrid>
    </GuideContext.Provider>,
  )
}

/** The grid; the "nothing matches" line is the sibling CSS shows only after an EMPTY grid. */
const grid = (container: HTMLElement) => container.querySelector('p')!.previousElementSibling!

describe('PathGrid', () => {
  it('shows the cards the search matches, and leaves the grid non-empty', () => {
    const { container } = renderGrid('reports')
    expect(screen.queryByText('Backlog card')).not.toBeInTheDocument()
    expect(screen.getByText('Reports card')).toBeInTheDocument()
    expect(grid(container).matches(':empty')).toBe(false)
  })

  it('empties the grid when nothing matches, which is what reveals the "nothing matches" line', () => {
    const { container } = render(
      <GuideContext.Provider value={{ lang: 'en', chapter: '00-bat-dau', query: 'zzz' }}>
        <PathGrid empty="Nothing matches">
          <PathCard keywords="backlog">Backlog card</PathCard>
          <PathCard keywords="reports">Reports card</PathCard>
        </PathGrid>
      </GuideContext.Provider>,
    )
    expect(grid(container).matches(':empty')).toBe(true)
    const line = screen.getByText('Nothing matches')
    expect(line.className).toContain('hidden')
    expect(line.className).toContain('[div:empty+&]:block')
  })
})
