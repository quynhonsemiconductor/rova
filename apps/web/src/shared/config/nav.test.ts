/**
 * The top-nav's active state, which was wrong for every dropdown with more than one child.
 *
 * `isActive(item.path)` tested the parent's own path — the dropdown's DEFAULT destination, which is
 * its FIRST child — so the trigger lit on that child and went dark on every other. This pins the
 * group rule against the real `NAV_ITEMS` table rather than a fixture, so a new child is covered the
 * day it is added.
 */
import { describe, expect, it } from 'vitest'

import { NAV_ITEMS, isNavGroupActive, isNavPathActive, type NavItem } from './nav'

const group = (label: string): NavItem => {
  const item = NAV_ITEMS.find((i) => i.label === label)
  if (!item) throw new Error(`no nav group ${label}`)
  return item
}

describe('isNavPathActive', () => {
  it('matches a surface and everything under it', () => {
    expect(isNavPathActive('/backlog', '/backlog')).toBe(true)
    expect(isNavPathActive('/quality/defects', '/quality')).toBe(true)
  })

  it('matches Home ONLY on Home', () => {
    // Every path starts with `/`, so a prefix test would light Home on every screen in the app.
    expect(isNavPathActive('/', '/')).toBe(true)
    expect(isNavPathActive('/backlog', '/')).toBe(false)
  })
})

describe('isNavGroupActive — the reported defect', () => {
  it('lights Track on BOTH its children, not just the first', () => {
    const track = group('Track')
    expect(isNavGroupActive('/iteration-status', track)).toBe(true)
    // The repro: `Team Status` is Track's SECOND child, and the trigger went dark here.
    expect(isNavGroupActive('/team-status', track)).toBe(true)
  })

  it('lights Plan on Timeboxes, and Portfolio on all three of its children', () => {
    expect(isNavGroupActive('/timeboxes', group('Plan'))).toBe(true)
    const portfolio = group('Portfolio')
    for (const path of ['/portfolio', '/capacity-planning', '/release-tracking']) {
      expect(isNavGroupActive(path, portfolio), `${path} must light Portfolio`).toBe(true)
    }
  })

  it('lights Plan on the Releases and Milestones type modes, not just the default Iterations mode', () => {
    // `/releases` and `/milestones` are TYPE MODES of the Timeboxes screen (TimeboxTypeSwitcher),
    // aliased onto `/timeboxes` in NAV_PATH_ALIASES rather than being children of Plan in their own
    // right — the trigger went dark switching to either, which the screenshot reported.
    const plan = group('Plan')
    for (const path of ['/releases', '/milestones', '/releases/rel-1', '/milestones/ms-1']) {
      expect(isNavGroupActive(path, plan), `${path} must light Plan`).toBe(true)
    }
  })

  it('stays dark on another group, so the cue still means something', () => {
    // The control: a rule that answered `true` everywhere would pass every assertion above.
    expect(isNavGroupActive('/backlog', group('Track'))).toBe(false)
    expect(isNavGroupActive('/team-status', group('Quality'))).toBe(false)
    expect(isNavGroupActive('/', group('Plan'))).toBe(false)
  })

  it('covers EVERY child of every group — the property, not seven examples', () => {
    for (const item of NAV_ITEMS) {
      for (const child of item.children ?? []) {
        expect(
          isNavGroupActive(child.path, item),
          `${item.label} must light on its child ${child.path}`,
        ).toBe(true)
      }
    }
  })

  it('consults hidden children too, since a permission cannot change where the reader IS', () => {
    // Not filtered by permission on purpose: a child the caller cannot see is one they cannot be
    // standing on, so it can never match anyway — and filtering would make this answer depend on a
    // permission read it does not need.
    const gated: NavItem = {
      path: '/a',
      label: 'Gated',
      children: [
        { path: '/a', label: 'A' },
        { path: '/b', label: 'B', permission: 'never:held' },
      ],
    }
    expect(isNavGroupActive('/b', gated)).toBe(true)
  })
})
