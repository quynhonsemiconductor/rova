/**
 * US-120 — the Portfolio row's ID cell is a real link to the record, so Ctrl/Cmd+click and "Open in
 * new tab" work; dropping `href` would silently fall back to an in-place-only button.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@/features/portfolio/api', () => ({
  useUpdatePortfolioItem: () => ({ mutate: vi.fn(), isPending: false }),
}))

import '@/shared/i18n/i18n'
import type { PortfolioItem } from '@/features/portfolio/api'
import { PortfolioRow } from './portfolio-row'

const FEATURE = {
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
} as unknown as PortfolioItem

describe('PortfolioRow', () => {
  it('links the ID cell to the record URL', () => {
    render(
      <PortfolioRow
        item={FEATURE}
        rowNum={1}
        canRank={false}
        canEdit={false}
        members={[]}
        canEditProject={() => false}
        options={{ releases: [], teams: [] }}
        optionsFor={() => ({ releases: [], teams: [] })}
        projectKeyFor={() => 'NXP'}
        colStyleFor={() => ({})}
        gutterProps={{ stopPropagation: true }}
        onOpen={vi.fn()}
      />,
    )
    expect(screen.getByTitle('FE-1').getAttribute('href')).toBe('/portfolio/fe-1')
  })
})
