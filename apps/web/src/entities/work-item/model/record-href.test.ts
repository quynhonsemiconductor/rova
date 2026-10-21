/**
 * US-120 — the ONE id-vs-key addressing rule every ID and reference cell derives its URL from.
 * Each branch is pinned: key-addressed (with and without a key), id-addressed (with and without
 * an id), and a type the rule does not know.
 */
import { describe, expect, it } from 'vitest'
import { defaultRecordHref } from './record-href'

describe('defaultRecordHref', () => {
  it.each([
    ['story', 'US-120', undefined, '/item/US-120'],
    ['task', 'TA-3', undefined, '/item/TA-3'],
    ['defect', 'DE-9', undefined, '/item/DE-9'],
    // A work item stays key-addressed even when a mixed grid passes its id unconditionally.
    ['story', 'US-1', 'wi-1', '/item/US-1'],
    ['feature', 'FE-1', 'pf-1', '/portfolio/pf-1'],
    ['epic', 'EP-1', 'pf-2', '/portfolio/pf-2'],
  ])('addresses a %s (%s, id %s) at %s', (type, key, id, expected) => {
    expect(defaultRecordHref(type, key, id)).toBe(expected)
  })

  it.each([
    ['a key-addressed row with no key yet (an optimistic row)', 'story', '', 'wi-1'],
    ['an id-addressed row with no id', 'feature', 'FE-1', undefined],
    ['a type the rule does not address', 'release', 'RL-1', 'rl-1'],
    // `hasOwn`, not `in`: an inherited property name is not a record kind.
    ['an inherited property name', 'constructor', 'X-1', 'x-1'],
  ])('gives %s no URL', (_case, type, key, id) => {
    expect(defaultRecordHref(type, key, id)).toBeUndefined()
  })
})
