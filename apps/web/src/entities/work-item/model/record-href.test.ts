/**
 * US-120 — the ONE id-vs-key addressing rule every ID and reference cell derives its URL from.
 * Each branch is pinned: key-addressed (with and without a key), id-addressed (with and without
 * an id), and a type the rule does not know.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultRecordHref, resolveRecordHref } from './record-href'

describe('defaultRecordHref', () => {
  // Unaddressed types warn in development (asserted below); keep the other cases' output clean.
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

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

describe('resolveRecordHref', () => {
  it('prefers an explicit URL', () => {
    expect(resolveRecordHref('/portfolio/pf-9', 'feature', 'FE-9')).toBe('/portfolio/pf-9')
  })

  it('derives the URL when none is given — and when an EMPTY one is (`||`, not `??`)', () => {
    expect(resolveRecordHref(undefined, 'story', 'US-9')).toBe('/item/US-9')
    expect(resolveRecordHref('', 'story', 'US-9')).toBe('/item/US-9')
  })
})

describe('defaultRecordHref diagnostics and encoding', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('warns in development when a type has no URL rule — a caller forgot its href', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(defaultRecordHref('Story', 'US-1')).toBeUndefined() // wrong casing: not a record kind
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"Story"'))
  })

  it('does not warn for a type it addresses', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    defaultRecordHref('story', 'US-1')
    defaultRecordHref('feature', 'FE-1', 'pf-1')
    expect(warn).not.toHaveBeenCalled()
  })

  it('encodes the segment once (the path builder does it), so a key cannot change the route', () => {
    expect(defaultRecordHref('story', 'US/1?x#y')).toBe('/item/US%2F1%3Fx%23y')
    expect(defaultRecordHref('feature', 'FE-1', 'a/b')).toBe('/portfolio/a%2Fb')
  })
})
