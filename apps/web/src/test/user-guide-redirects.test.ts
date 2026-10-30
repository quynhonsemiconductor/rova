/// <reference types="node" />
/**
 * Old User Guide links (`/guide/…`, the standalone HTML guide) still land on the right chapter of the
 * in-app guide, in the same edition — through `public/_redirects`, which Pages applies statically.
 *
 * The rules are read from the file and applied with Pages' own matching (top to bottom, first match
 * wins, a trailing `*` captured as `:splat`), then the destination is resolved the way the app
 * resolves it: `/user-guide/<lang>` opens the start chapter, and `GuidePage` maps `index` and a
 * trailing `.html` onto a chapter slug.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { START_CHAPTER, isGuideLang } from '@/pages/guide/model/guide-url'
import { canonicalChapterSlug, chaptersOf } from '@/pages/guide/model/toc'

const RULES = readFileSync(join(import.meta.dirname, '../../public/_redirects'), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => {
    const [from, to, status] = line.split(/\s+/)
    return { from: from!, to: to!, status: Number(status) }
  })

function redirect(path: string): { to: string; status: number } | undefined {
  for (const rule of RULES) {
    if (rule.from.endsWith('/*')) {
      const prefix = rule.from.slice(0, -1)
      if (path.startsWith(prefix)) {
        return { to: rule.to.replace(':splat', path.slice(prefix.length)), status: rule.status }
      }
    } else if (path === rule.from) {
      return { to: rule.to, status: rule.status }
    }
  }
  return undefined
}

/** Where the app takes a `/user-guide/…` URL: `{ lang, chapter }`, or undefined for a dead end. */
function landing(path: string) {
  const [, root, lang, chapter = '', ...rest] = path.split('/')
  if (root !== 'user-guide' || !isGuideLang(lang) || rest.length > 0) return undefined
  const slug = chapter === '' ? START_CHAPTER : canonicalChapterSlug(chapter)
  return chaptersOf(lang).some((c) => c.slug === slug) ? { lang, chapter: slug } : undefined
}

const slugs = chaptersOf('vi').map((c) => c.slug)

describe('old /guide links', () => {
  it.each([
    ['/guide', 'vi'],
    ['/guide/', 'vi'],
    ['/guide/index.html', 'vi'],
    ['/guide/index', 'vi'],
    ['/guide/en', 'en'],
    ['/guide/en/', 'en'],
    ['/guide/en/index.html', 'en'],
  ])('%s opens the start chapter of the %s edition', (old, lang) => {
    const hop = redirect(old)
    expect(hop?.status).toBe(301)
    expect(landing(hop!.to)).toEqual({ lang, chapter: START_CHAPTER })
  })

  it.each(slugs.filter((slug) => slug !== START_CHAPTER))(
    'lands %s on the same chapter, in both editions, with or without .html',
    (slug) => {
      for (const [prefix, lang] of [
        ['/guide/', 'vi'],
        ['/guide/en/', 'en'],
      ] as const) {
        for (const old of [`${prefix}${slug}.html`, `${prefix}${slug}`]) {
          expect(landing(redirect(old)!.to), old).toEqual({ lang, chapter: slug })
        }
      }
    },
  )

  it('sends an old screenshot URL to where the screenshots live now', () => {
    expect(redirect('/guide/assets/03-backlog-production.png')?.to).toBe(
      '/guide-assets/03-backlog-production.png',
    )
  })

  it('leaves the in-app guide and its gated files alone', () => {
    for (const path of ['/user-guide', '/user-guide/vi/01-lam-quen', '/guide-assets/js/x.js']) {
      expect(redirect(path), path).toBeUndefined()
    }
  })
})
