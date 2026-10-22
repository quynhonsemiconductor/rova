import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import '@/shared/i18n/i18n'
import { CapacityItemRow } from './capacity-item-row'
import type { CapacityPlanItem } from '@/features/capacity-planning/api'

const item = (over: Partial<CapacityPlanItem> = {}): CapacityPlanItem =>
  ({
    portfolioItemId: 'fe-1',
    itemKey: 'FE-1',
    name: 'Guest checkout flow',
    rank: 'a',
    projectId: 'p1',
    projectName: 'NX Platform',
    releaseId: null,
    estimated: 8,
    rollup: 5,
    complete: 2,
    tier: 'allocated',
    warnings: [],
    estimateBreakdown: { allocated: 8, refined: 13, preliminary: 5 },
    teamIds: ['t1'],
    primaryTeamId: 't1',
    unallocated: false,
    ...over,
  }) as CapacityPlanItem

/** The row is presentational: no query client, no router, no providers beyond i18n. */
function renderRow(over: Partial<CapacityPlanItem> = {}) {
  render(
    <CapacityItemRow
      item={item(over)}
      position={1}
      primaryTeamName="Team Alpha"
      belowCutline={false}
      colStyleFor={() => ({})}
      onOpenFeature={() => {}}
    />,
  )
}

describe('CapacityItemRow warnings', () => {
  it('shows no triangle when nothing is wrong', () => {
    renderRow()
    expect(screen.queryByRole('img', { name: /exceeds|missing/i })).toBeNull()
  })

  it("puts `Rollup exceeds Estimated` on the ROLLUP column, in the BA's exact words", () => {
    // The wording matters beyond style: the BA's QA scenarios match on this string, so prose that
    // merely means the same thing fails them. The column matters too — a warning rendered once,
    // away from the number it is about, leaves a planner guessing which figure to fix.
    renderRow({ warnings: ['rollup_exceeds_estimated'], rollup: 11, estimated: 2 })
    expect(screen.getByRole('img', { name: 'Rollup exceeds Estimated' })).toBeTruthy()
  })

  it('puts `Point Estimated missing` on the ESTIMATED column', () => {
    renderRow({ warnings: ['feature_missing_estimate'], tier: 'none', estimated: 0 })
    expect(screen.getByRole('img', { name: 'Point Estimated missing' })).toBeTruthy()
  })

  it('renders both when both fired, each on its own column', () => {
    // `feature_missing_estimate` is the CAUSE of the comparison failing, so the two co-occur often;
    // the row has to carry them separately rather than collapsing to one glyph.
    renderRow({
      warnings: ['feature_missing_estimate', 'rollup_exceeds_estimated'],
      tier: 'none',
      estimated: 0,
      rollup: 4,
    })
    expect(screen.getByRole('img', { name: 'Point Estimated missing' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Rollup exceeds Estimated' })).toBeTruthy()
  })

  it("names the split as `N teams`, the BA's own words, not a bare digit", () => {
    /**
     * SRS §155: "If the Feature is split across multiple Teams, the parent row shows `N teams`; split
     * edits are made through the Allocate dialog."
     *
     * Rally draws a boxed `2` there, which needs a tooltip to mean anything — and a tooltip is not
     * reachable by a screen reader or a printout. The count itself is the point: no single team name is
     * the answer for a split Feature, and the nested rows name them all.
     */
    renderRow({ teamIds: ['t1', 't2'], primaryTeamId: 't1' })
    expect(screen.getByText('2 teams')).toBeTruthy()
  })

  it('ignores warning codes that belong to a TEAM, not a Feature', () => {
    // A Feature has no capacity of its own, so the capacity rules cannot apply to it. If one ever
    // arrived on an item row it must not be drawn here — the row would be reporting a limit that
    // does not exist at this level.
    renderRow({ warnings: ['estimated_exceeds_capacity', 'team_missing_capacity'] })
    expect(screen.queryByRole('img', { name: /Capacity/i })).toBeNull()
  })
})

// US-120: see `allocation-row.test.tsx` — the same cell, on the Features tab.
describe('CapacityItemRow — ID link', () => {
  it('links the Feature key to its portfolio detail page', () => {
    renderRow()
    expect(screen.getByTitle('FE-1').getAttribute('href')).toBe('/portfolio/fe-1')
  })
})
