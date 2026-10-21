/**
 * US-120 — a disclosed child Feature's ID cell is a real link to the record; dropping `href` would
 * silently fall back to an in-place-only button.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))

const CHILD = {
  id: 'fe-1',
  projectId: 'p-1',
  projectName: 'NextGen Platform',
  itemKey: 'FE-1',
  type: 'feature',
  name: 'Payment retries',
  state: 'no_entry',
  childFeatureCount: 0,
  rollup: { rollupPoints: 0, rollupCount: 0, completedPoints: 0 },
  progress: { percentDonePoints: 0, percentDoneCount: 0 },
  health: { status: 'green', reason: 'on_track' },
}

vi.mock('@/features/portfolio/api', () => ({
  usePortfolioChildFeatures: () => ({ data: [CHILD], isLoading: false }),
  usePortfolioChildren: () => ({ data: undefined, isLoading: false }),
  useUpdatePortfolioItem: () => ({ mutate: vi.fn(), isPending: false }),
}))

import '@/shared/i18n/i18n'
import type { PortfolioItem } from '@/features/portfolio/api'
import { PortfolioChildRows } from './portfolio-child-rows'

const EPIC = { ...CHILD, id: 'ep-1', itemKey: 'EP-1', type: 'epic' } as unknown as PortfolioItem

describe('PortfolioChildRows', () => {
  it('links a child Feature ID cell to the record URL', () => {
    render(
      <PortfolioChildRows
        item={EPIC}
        colStyleFor={() => ({})}
        members={[]}
        canEditProject={() => false}
        optionsFor={() => ({ releases: [], teams: [] })}
        projectKeyFor={() => 'NXP'}
      />,
    )
    expect(screen.getByTitle('FE-1').getAttribute('href')).toBe('/portfolio/fe-1')
  })
})
