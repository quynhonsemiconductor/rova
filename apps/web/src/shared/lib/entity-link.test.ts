import { describe, expect, it } from 'vitest'

import {
  entityDetailPath,
  entityDetailUrl,
  entityLinkFor,
  entityLinkFormats,
  type EntityLinkFormatId,
} from './entity-link'

const SUBJECT = {
  key: 'US-2',
  name: 'Allow Workspace Admin to be added as a Team member',
  url: 'https://rova.qnsc.vn/item/US-2',
}

function byId(id: EntityLinkFormatId, subject = SUBJECT) {
  const found = entityLinkFormats(subject).find((f) => f.id === id)
  if (!found) throw new Error(`no format ${id}`)
  return found
}

describe('entityLinkFormats', () => {
  it('offers exactly the five Rally rows, in Rally order', () => {
    expect(entityLinkFormats(SUBJECT).map((f) => f.id)).toEqual([
      'linkAndName',
      'markdownWithName',
      'markdown',
      'html',
      'plain',
    ])
  })

  it('renders each row the way a reader expects to paste it', () => {
    expect(byId('linkAndName').value).toBe(`US-2: ${SUBJECT.name}`)
    expect(byId('markdownWithName').value).toBe(`[US-2: ${SUBJECT.name}](${SUBJECT.url})`)
    expect(byId('markdown').value).toBe(`[US-2](${SUBJECT.url})`)
    expect(byId('html').value).toBe(`<a href="${SUBJECT.url}">US-2: ${SUBJECT.name}</a>`)
    expect(byId('plain').value).toBe(SUBJECT.url)
  })

  it('gives ONLY linkAndName a rich flavour — the other rows are source text', () => {
    // A reader copying the Markdown row wants the Markdown, not a rendered link.
    expect(byId('linkAndName').html).toBe(`<a href="${SUBJECT.url}">US-2: ${SUBJECT.name}</a>`)
    for (const id of ['markdownWithName', 'markdown', 'html', 'plain'] as const) {
      expect(byId(id).html).toBeUndefined()
    }
  })

  it('falls back to the key alone when a record has no name', () => {
    const anon = { ...SUBJECT, name: '' }
    expect(byId('linkAndName', anon).value).toBe('US-2')
    expect(byId('markdownWithName', anon).value).toBe(`[US-2](${SUBJECT.url})`)
  })

  // ── Escaping: the reason this module is pure and tested ────────────────────

  it('escapes brackets in a title so a Markdown label cannot close early', () => {
    const tricky = { ...SUBJECT, name: 'Fix [link] and \\ path' }
    expect(byId('markdownWithName', tricky).value).toBe(
      `[US-2: Fix \\[link\\] and \\\\ path](${SUBJECT.url})`,
    )
  })

  it('wraps a target containing parentheses in angle brackets, not percent-encoding', () => {
    // Percent-encoding would change a URL the reader is meant to recognise.
    const paren = { ...SUBJECT, url: 'https://rova.qnsc.vn/item/US-2?q=(a)' }
    expect(byId('markdown', paren).value).toBe('[US-2](<https://rova.qnsc.vn/item/US-2?q=(a)>)')
    expect(byId('plain', paren).value).toBe(paren.url)
  })

  it('escapes markup in the HTML row, both in the text and in the href', () => {
    const markup = {
      key: 'DE-9',
      name: 'Crash on <script> & "quotes"',
      url: 'https://rova.qnsc.vn/item/DE-9?a=1&b=2',
    }
    expect(byId('html', markup).value).toBe(
      '<a href="https://rova.qnsc.vn/item/DE-9?a=1&amp;b=2">' +
        'DE-9: Crash on &lt;script&gt; &amp; &quot;quotes&quot;</a>',
    )
  })

  it('leaves the plain row byte-identical to the URL', () => {
    // It is the row a reader pastes into a field that parses nothing.
    expect(byId('plain').value).toBe(SUBJECT.url)
  })
})

describe('entityDetailUrl', () => {
  it('mirrors every detail route the router declares', () => {
    expect(Object.keys(entityDetailPath).sort()).toEqual([
      'capacityPlan',
      'iteration',
      'milestone',
      'portfolioItem',
      'project',
      'release',
      'testCase',
      'testResult',
      'workItem',
    ])
  })

  it('builds an absolute URL against a given origin', () => {
    expect(entityDetailUrl('workItem', 'US-2', 'https://rova.qnsc.vn')).toBe(
      'https://rova.qnsc.vn/item/US-2',
    )
    expect(entityDetailUrl('testCase', 'TC-14', 'https://rova.qnsc.vn/')).toBe(
      'https://rova.qnsc.vn/test-case/TC-14',
    )
  })

  it('encodes a param so a key with a slash or space cannot forge a path', () => {
    expect(entityDetailUrl('workItem', 'US 2/edit', 'https://x.test')).toBe(
      'https://x.test/item/US%202%2Fedit',
    )
  })
})

describe('entityLinkFor', () => {
  it('builds a subject when the record has a key', () => {
    expect(entityLinkFor('capacityPlan', 'plan-1', 'CP-3', 'Q3 plan')).toEqual({
      key: 'CP-3',
      name: 'Q3 plan',
      url: `${window.location.origin}/capacity-planning/plan-1`,
    })
  })

  it('returns undefined for a draft with no key, so no control renders', () => {
    expect(entityLinkFor('capacityPlan', 'plan-1', null, 'Draft')).toBeUndefined()
    expect(entityLinkFor('iteration', undefined, 'IT-1', 'Sprint')).toBeUndefined()
  })

  it('treats a missing name as empty rather than printing "null"', () => {
    expect(entityLinkFor('iteration', 'it-1', 'IT-1', null)?.name).toBe('')
  })
})
