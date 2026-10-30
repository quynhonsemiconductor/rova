import '@/shared/i18n/i18n'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { GuideContext } from '../guide-context'
import { Callout } from './prose'
import { PathCard, PathGrid } from './home'

function renderGrid(query: string) {
  return render(
    <GuideContext.Provider value={{ lang: 'en', chapter: '00-bat-dau', query }}>
      <PathGrid empty="Nothing matches">
        <PathCard keywords="backlog work items">Backlog card</PathCard>
        {/* Not a path card: a chapter author's stray block must neither crash nor be filtered. */}
        <Callout>
          <strong>Note</strong>
        </Callout>
      </PathGrid>
    </GuideContext.Provider>,
  )
}

describe('PathGrid', () => {
  it('filters only its path cards by the search, and survives any other child', () => {
    renderGrid('backlog')
    expect(screen.getByText('Backlog card')).toBeInTheDocument()

    renderGrid('zzz')
    expect(screen.getByText('Nothing matches')).toBeInTheDocument()
  })
})
