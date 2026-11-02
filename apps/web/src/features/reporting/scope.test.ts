import { describe, expect, it } from 'vitest'

import { iterationsInScope, iterationsOwnedByTeam, reportScopeLabel, teamScopeLabel } from './scope'

describe('report scope labels', () => {
  it('names the aggregate scope instead of printing nothing', () => {
    // `null` teamName is All Teams — the DEFAULT scope, so this is the first thing a reader sees.
    // Every report rendered it as '', producing "NextGen Platform - " and "Team: ".
    expect(teamScopeLabel(null, 'All Teams')).toBe('All Teams')
    expect(reportScopeLabel('NextGen Platform', null, 'All Teams')).toBe(
      'NextGen Platform - All Teams',
    )
  })

  it('uses the real team name when there is one', () => {
    expect(reportScopeLabel('NextGen Platform', 'Team Alpha', 'All Teams')).toBe(
      'NextGen Platform - Team Alpha',
    )
  })

  it('never leaves a dangling separator while the project is still loading', () => {
    // The label is rendered before `context` arrives on a slow request.
    expect(reportScopeLabel(undefined, null, 'All Teams')).toBe('- All Teams')
  })
})

describe('iterationsInScope', () => {
  const iterations = [
    { id: 'shared', teamId: null },
    { id: 'alpha', teamId: 'team-a' },
    { id: 'beta', teamId: 'team-b' },
  ]

  it('keeps the shared iterations a team-scoped report actually measures', () => {
    // This is the client half of `teamOrSharedTimebox`. A team-less iteration is project-wide, and
    // the server counts it for every team — so a picker that dropped it would hide the only timebox
    // a project running one shared sprint has.
    expect(iterationsInScope(iterations, 'team-a').map((i) => i.id)).toEqual(['shared', 'alpha'])
  })

  it("drops another team's private iteration, which the report can only answer as empty", () => {
    expect(iterationsInScope(iterations, 'team-a').map((i) => i.id)).not.toContain('beta')
  })

  it('offers everything under All Teams', () => {
    // No team selected is the aggregate, not "no filter yet" — every timebox is in scope.
    expect(iterationsInScope(iterations, undefined)).toHaveLength(3)
  })
})

describe('iterationsOwnedByTeam', () => {
  const iterations = [
    { id: 'shared', teamId: null },
    { id: 'alpha', teamId: 'team-a' },
    { id: 'beta', teamId: 'team-b' },
  ]

  it('keeps only the selected Team own iterations — no shared ones (Carryover, R7)', () => {
    expect(iterationsOwnedByTeam(iterations, 'team-a').map((i) => i.id)).toEqual(['alpha'])
  })

  it('keeps every iteration for All Teams', () => {
    expect(iterationsOwnedByTeam(iterations, undefined)).toHaveLength(3)
  })
})
