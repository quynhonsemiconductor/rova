/**
 * P5-CP-025 — the `Allocation` cell on a team's nested Feature table.
 *
 * The cell reports a RELATIONSHIP: `from {team}` on a contributor row, `to {team}` / `N teams` on the
 * row that holds the assignment, and nothing to report when the Feature sits under its own team and
 * is allocated nowhere else. That last case rendered an EMPTY cell, which in a table where every
 * neighbour carries a value reads as "not loaded"; it now renders `EMPTY_VALUE`.
 *
 * `EMPTY_VALUE` is asserted through the constant, never as a literal `--`, and never as `—`: the BA
 * writes an em-dash in prose, the app renders `--` everywhere (see the constant's own docblock), and a
 * test that hardcoded either string would be the place that drift lands unnoticed.
 */
import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'

vi.mock('@/shared/api/http-client', () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}))

import '@/shared/i18n/i18n'
import { EMPTY_VALUE } from '@/shared/lib/utils'
import { AllocationRow } from './allocation-row'
import type { CapacityAllocation } from '@/features/capacity-planning/api'

const allocation = (over: Partial<CapacityAllocation> = {}): CapacityAllocation =>
  ({
    id: 'alloc-1',
    portfolioItemId: 'fe-1',
    itemKey: 'FE-1',
    name: 'Guest checkout flow',
    teamId: 't1',
    isPrimary: true,
    state: 'developing',
    value: 8,
    source: 'manual',
    tier: 'allocated',
    estimateBreakdown: { refined: 13, preliminary: 5 },
    metrics: { complete: 2, rollup: 5, estimated: 8, capacity: null, warnings: [] },
    ...over,
  }) as CapacityAllocation

function renderRow(
  over: Partial<CapacityAllocation> = {},
  props: { ownerTeamName?: string | null; contributorTeamNames?: string[] } = {},
) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AllocationRow
        planId="plan-1"
        allocation={allocation(over)}
        canManage
        colStyleFor={() => ({})}
        onOpenFeature={() => {}}
        rankPosition={1}
        ownerTeamName={props.ownerTeamName ?? null}
        contributorTeamNames={props.contributorTeamNames ?? []}
        hasTeams
      />
    </QueryClientProvider>,
  )
}

describe('AllocationRow — the Allocation cell', () => {
  it("renders EMPTY_VALUE under the Feature's OWN team when nothing is allocated away", () => {
    renderRow({ isPrimary: true }, { contributorTeamNames: [] })
    expect(screen.getByText(EMPTY_VALUE)).toBeTruthy()
    // Not an em-dash — the BA's prose spells it `—`, the app does not.
    expect(screen.queryByText('—')).toBeNull()
  })

  it('renders EMPTY_VALUE in the Unallocated bucket, where there is no assignment to be relative to', () => {
    renderRow({ teamId: null }, {})
    expect(screen.getByText(EMPTY_VALUE)).toBeTruthy()
  })

  it('still names the owner on a CONTRIBUTOR row rather than the placeholder', () => {
    // The control: the placeholder must not swallow the case the cell exists for.
    renderRow({ isPrimary: false }, { ownerTeamName: 'Team Alpha' })
    expect(screen.getByText('from Team Alpha')).toBeTruthy()
    expect(screen.queryByText(EMPTY_VALUE)).toBeNull()
  })

  it('still names what was allocated AWAY on the assignment row', () => {
    renderRow({ isPrimary: true }, { contributorTeamNames: ['Team Beta'] })
    expect(screen.getByText('to Team Beta')).toBeTruthy()
    expect(screen.queryByText(EMPTY_VALUE)).toBeNull()
  })

  it('leaves Dependencies at `0`, the declared divergence', () => {
    // `0` here is a ruling, not an oversight: Rally's column is a COUNT and dependencies are
    // unimplemented rather than unknown, so this is the ONE cell the absent-value rule skips. Pinned
    // so a future sweep for `--` does not "finish the job" and reverse it.
    renderRow({ isPrimary: true }, { contributorTeamNames: [] })
    expect(screen.getByText('0')).toBeTruthy()
  })
})

// US-120: the ID cell is a real link to the Feature's portfolio detail (by id), so Ctrl/Cmd+click and
// "Open link in new tab" work. Dropping `href` would silently fall back to an in-place-only button.
describe('AllocationRow — ID link', () => {
  it('links the Feature key to its portfolio detail page', () => {
    renderRow()
    expect(screen.getByTitle('FE-1').getAttribute('href')).toBe('/portfolio/fe-1')
  })
})
