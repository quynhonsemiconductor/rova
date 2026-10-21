/**
 * US-120 — the ONE id-vs-key addressing rule every ID and reference cell derives its URL from.
 * Each branch is pinned: key-addressed (with and without a key), id-addressed (with and without
 * an id), and a type the rule does not know.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetReportedForTests } from '@/shared/lib/report-once'
import {
  defaultRecordHref,
  recordHrefForClick,
  recordHrefProblem,
  resolveRecordHref,
} from './record-href'

// `reportOnce` is session-wide by design; each test starts a fresh session.
beforeEach(() => {
  resetReportedForTests()
})

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
    // A padded key (bad data) builds from the trimmed value, never `/item/%20US-5%20`.
    ['story', ' US-5 ', undefined, '/item/US-5'],
  ])('addresses a %s (%s, id %s) at %s', (type, key, id, expected) => {
    expect(defaultRecordHref(type, key, id)).toBe(expected)
  })

  it.each([
    ['a key-addressed row with no key yet (an optimistic row)', 'story', '', 'wi-1'],
    ['a key-addressed row whose key is only whitespace (bad data)', 'story', '  ', 'wi-1'],
    ['an id-addressed row with no id', 'feature', 'FE-1', undefined],
    ['an id-addressed row whose id is only whitespace (bad data)', 'feature', 'FE-1', '  '],
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

describe('recordHrefProblem (what useRecordHref reports) and encoding', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('names an unknown type — a caller forgot its href, or mistyped the type', () => {
    expect(recordHrefProblem('Story')?.message).toContain('"Story"') // wrong casing
  })

  it('names an Epic / Feature with no id — a portfolio type through a work-item cast', () => {
    expect(recordHrefProblem('epic')?.message).toContain('pass `recordId`')
    expect(recordHrefProblem('epic', 'pf-1')).toBeUndefined()
  })

  it('reports a whitespace-only id like a missing one', () => {
    expect(recordHrefProblem('feature', '  ')?.message).toContain('pass `recordId`')
  })

  it('never copies an unexpected type string into the report — only its length', () => {
    const odd = 'contact me: a@b.example'
    const problem = recordHrefProblem(odd)
    expect(problem?.message).not.toContain('a@b.example')
    expect(problem?.key).not.toContain('a@b.example')
    expect(problem?.message).toContain(`${odd.length} chars`)
  })

  it('has nothing to say about a type it addresses, or a work item still without a key', () => {
    expect(recordHrefProblem('story')).toBeUndefined()
    expect(recordHrefProblem('feature', 'pf-1')).toBeUndefined()
  })

  it('keeps defaultRecordHref PURE: deriving a URL never logs, even for a broken input', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    defaultRecordHref('Story', 'US-1')
    defaultRecordHref('epic', 'EP-1')
    expect(warn).not.toHaveBeenCalled()
  })

  it('encodes the segment once (the path builder does it), so a key cannot change the route', () => {
    expect(defaultRecordHref('story', 'US/1?x#y')).toBe('/item/US%2F1%3Fx%23y')
    expect(defaultRecordHref('feature', 'FE-1', 'a/b')).toBe('/portfolio/a%2Fb')
  })
})

describe('recordHrefForClick', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the URL and reports nothing for a known record', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(recordHrefForClick('feature', 'FE-1', 'pf-1')).toBe('/portfolio/pf-1')
    expect(warn).not.toHaveBeenCalled()
  })

  it('reports a click that resolves nowhere, instead of swallowing it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(recordHrefForClick('milestone', 'MS-1', 'ms-1')).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"milestone"'))
  })

  it('stays silent for an optimistic row with no key yet — that is normal, not a defect', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(recordHrefForClick('story', '')).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })
})
