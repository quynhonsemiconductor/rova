import { describe, expect, it } from 'vitest'
import { WORK_ITEM_VIEW_ROOTS, INVALIDATION_MAP } from '@/shared/api/invalidation'
import { workItemKeys, childDefectsKeys, carryoverOptionsKey } from '@/features/work-items/api'
import { iterationKeys } from '@/features/iterations/api'
import { teamStatusKeys } from '@/features/team-status/api'
import { qualityKeys } from '@/features/quality/api'
import { portfolioKeys } from '@/features/portfolio/api'
import { reportingKeys } from '@/features/reporting/api'
import { releaseKeys } from '@/features/releases/api'
import { milestoneKeys } from '@/features/milestones/api'
import { teamKeys } from '@/features/teams/api'

/**
 * The central invalidation registry stores query-key roots as literals to avoid
 * a feature-import cycle. These guards prove each literal still matches the real
 * root exported by its feature module, so a rename can never silently break
 * cross-view cache invalidation (the "edit reverts / new item missing until
 * reload" class of bug that motivated the tag registry).
 */
const asStr = (keys: readonly unknown[]) => keys.map((k) => JSON.stringify(k))

describe('WORK_ITEM_VIEW_ROOTS', () => {
  const roots = asStr(WORK_ITEM_VIEW_ROOTS)

  it.each([
    ['work-items', workItemKeys.all],
    ['iteration-status', iterationKeys.statusAll],
    ['team-status', teamStatusKeys.all],
    ['quality', qualityKeys.all],
    ['portfolio', portfolioKeys.all],
    ['reports', reportingKeys.all],
    ['child-defects', childDefectsKeys.all],
  ])('includes the canonical %s root', (_label, featureRoot) => {
    expect(roots).toContain(JSON.stringify(featureRoot))
  })

  it('covers exactly the known work-item read-models (no drift)', () => {
    expect(WORK_ITEM_VIEW_ROOTS).toHaveLength(7)
  })
})

describe('INVALIDATION_MAP entity tags cover their feature roots', () => {
  const has = (tag: keyof typeof INVALIDATION_MAP, root: readonly unknown[]) =>
    asStr(INVALIDATION_MAP[tag]).includes(JSON.stringify(root))

  it('work-item tag fans out to every work-item read-model', () => {
    for (const root of WORK_ITEM_VIEW_ROOTS) {
      expect(asStr(INVALIDATION_MAP['work-item'])).toContain(JSON.stringify(root))
    }
  })

  it('a Carryover’s `work-item` tag reaches the options feed and every report (PR #653)', () => {
    // `useCarryOverWorkItem` relies on the tag alone, so both reads must sit under its roots.
    expect(carryoverOptionsKey('wi-1').slice(0, 1)).toEqual([...workItemKeys.all])
    expect(has('work-item', workItemKeys.all)).toBe(true)
    expect(has('work-item', reportingKeys.all)).toBe(true)
  })

  it('iteration tag includes list, detail, options, status + work-item views', () => {
    expect(has('iteration', iterationKeys.all)).toBe(true) // ['iterations'] list root
    expect(has('iteration', iterationKeys.optionsAll)).toBe(true) // the once-forgotten picker feed
    expect(has('iteration', iterationKeys.statusAll)).toBe(true)
    expect(has('iteration', ['iteration'])).toBe(true) // detail root (singular)
    expect(has('iteration', workItemKeys.all)).toBe(true) // fans out to work items
  })

  it('release / milestone tags include both their own roots and work-item views', () => {
    expect(has('release', releaseKeys.all)).toBe(true)
    expect(has('release', workItemKeys.all)).toBe(true)
    expect(has('milestone', milestoneKeys.all)).toBe(true)
    expect(has('milestone', ['milestone'])).toBe(true) // singular relation namespace
    expect(has('milestone', workItemKeys.all)).toBe(true)
  })

  it('team tag covers the teams namespace', () => {
    expect(has('team', teamKeys.all)).toBe(true)
  })

  it('every tag resolves to at least one query-key root', () => {
    for (const [tag, keys] of Object.entries(INVALIDATION_MAP)) {
      expect(keys.length, `tag "${tag}" must map to ≥1 root`).toBeGreaterThan(0)
    }
  })
})
