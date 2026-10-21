/**
 * US-120 — an Epic's child Feature ID cell is a real link to the record; dropping `href` would
 * silently fall back to an in-place-only button.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/features/teams/api', () => ({ useProjectTeams: () => ({ data: [] }) }))
vi.mock('@/features/portfolio/api', () => ({
  useRankPortfolioItem: () => ({ mutate: vi.fn() }),
  usePortfolioChildren: () => ({ data: undefined, isLoading: false }),
}))

import '@/shared/i18n/i18n'
import type { PortfolioItem } from '@/features/portfolio/api'
import { EpicChildrenTable } from './epic-children-table'

const FEATURE = {
  id: 'fe-1',
  projectId: 'p-1',
  itemKey: 'FE-1',
  type: 'feature',
  name: 'Payment retries',
  state: 'no_entry',
  teamId: null,
  teamName: null,
  ownerName: null,
  rollup: { rollupPoints: 0, rollupCount: 0, completedPoints: 0 },
  progress: { percentDonePoints: 0, percentDoneCount: 0 },
  estimate: { points: { value: 0, tier: 'none' }, count: { value: 0, tier: 'none' } },
} as unknown as PortfolioItem

describe('EpicChildrenTable', () => {
  it('links a child Feature ID cell to the record URL', () => {
    render(<EpicChildrenTable features={[FEATURE]} projectId="p-1" />)
    expect(screen.getByTitle('FE-1').getAttribute('href')).toBe('/portfolio/fe-1')
  })
})
