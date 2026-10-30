/// <reference types="node" />
/**
 * The in-app User Guide (US-119, `pages/guide`) holds together: both editions agree, the table of
 * contents names only ids a chapter renders, every link lands somewhere, every screenshot exists.
 *
 * The static guide had `user-guide.integrity.test.ts` for the same job over HTML. Here the chapters
 * are RENDERED, through a real router, and every claim is made against what a reader gets — the
 * `href` a link resolves to, the `id`s on the page, the `src` an image asks for — so a chapter that
 * types `to="02-truy-cap"` for `02-truy-cap-pham-vi` fails here rather than in front of a reader.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ComponentType } from 'react'
import { beforeAll, describe, expect, it } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'

import '@/shared/i18n/i18n'
import { CHAPTER_MODULES } from '@/pages/guide/model/chapters'
import { GUIDE_LANGS, type GuideLang } from '@/pages/guide/model/guide-url'
import { GUIDE_TOC, chaptersOf, type GuideChapter } from '@/pages/guide/model/toc'
import { GuideContext } from '@/pages/guide/ui/guide-context'
import { GUIDE_ASSETS_ROOT } from '@/pages/guide/ui/guide-shot'

const ASSETS_DIR = join(import.meta.dirname, '../../public/guide-assets')

/**
 * Chapters the app does not render yet; the standalone guide still serves them. This list may only
 * SHRINK — each port removes its slug — and the last port empties it, at which point every screenshot
 * in `public/guide-assets` must also be in use.
 */
const NOT_YET_PORTED: readonly string[] = [
  '10-bao-cao',
  '11-quan-tri-workspace',
  '12-viet-backlog-item',
]

interface Rendered {
  ids: Set<string>
  sectionIds: string[]
  links: { chapter: string; lang: string; hash: string }[]
  images: string[]
  externals: string[]
}

const contentPath = (lang: GuideLang, slug: string) => `../content/${lang}/${slug}.tsx`
const slugsWithContent = (lang: GuideLang) =>
  chaptersOf(lang)
    .map((c) => c.slug)
    .filter((slug) => contentPath(lang, slug) in CHAPTER_MODULES)

/** Render one chapter inside a router that knows the guide's route, and read off what it shows. */
async function renderChapter(lang: GuideLang, slug: string): Promise<Rendered> {
  const { default: Chapter } = (await CHAPTER_MODULES[contentPath(lang, slug)]!()) as {
    default: ComponentType
  }
  const rootRoute = createRootRoute({
    component: () => (
      <GuideContext.Provider value={{ lang, chapter: slug, query: '' }}>
        <Chapter />
      </GuideContext.Provider>
    ),
  })
  const chapterRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/user-guide/$lang/$chapter',
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([chapterRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  const { container, unmount } = render(<RouterProvider router={router} />)
  await waitFor(() => expect(container.querySelector('[id]')).not.toBeNull())

  const links = [...container.querySelectorAll('a[href]')].map((a) => {
    const url = new URL(a.getAttribute('href')!, 'https://rova.test')
    const [, root, linkLang, chapter] = url.pathname.split('/')
    expect(root, `link ${a.getAttribute('href')} leaves the guide`).toBe('user-guide')
    return { lang: linkLang!, chapter: chapter!, hash: url.hash.slice(1) }
  })
  const out: Rendered = {
    ids: new Set([...container.querySelectorAll('[id]')].map((el) => el.id)),
    sectionIds: [...container.querySelectorAll('section[id]')].map((el) => el.id),
    links,
    images: [...container.querySelectorAll('img')].map((img) => img.getAttribute('src')!),
    externals: [...container.querySelectorAll('[href], [src]')]
      .map((el) => el.getAttribute('href') ?? el.getAttribute('src')!)
      .filter((url) => /^[a-z][a-z0-9+.-]*:|^\/\//i.test(url)),
  }
  unmount()
  return out
}

const tocIds = (chapter: GuideChapter) => [chapter.anchor, ...chapter.sections.map((s) => s.id)]

describe('in-app User Guide integrity', () => {
  const rendered = new Map<string, Rendered>()
  const key = (lang: string, slug: string) => `${lang}/${slug}`

  beforeAll(async () => {
    for (const lang of GUIDE_LANGS) {
      for (const slug of slugsWithContent(lang))
        rendered.set(key(lang, slug), await renderChapter(lang, slug))
    }
  }, 60_000)

  it('gives both editions the same chapters, anchors and section ids, in the same order', () => {
    const shape = (lang: GuideLang) =>
      GUIDE_TOC[lang].map((group) => group.chapters.map((c) => [c.slug, ...tocIds(c)]))
    expect(shape('en')).toEqual(shape('vi'))
  })

  it.each(GUIDE_LANGS)(
    'ships a %s chapter for every TOC entry except those not yet ported',
    (lang) => {
      const toc = chaptersOf(lang).map((c) => c.slug)
      expect(slugsWithContent(lang)).toEqual(toc.filter((slug) => !NOT_YET_PORTED.includes(slug)))
      const files = Object.keys(CHAPTER_MODULES)
        .filter((path) => path.startsWith(`../content/${lang}/`))
        .map((path) => path.slice(`../content/${lang}/`.length, -'.tsx'.length))
      expect(
        files.filter((slug) => !toc.includes(slug)),
        'chapter files missing from the TOC',
      ).toEqual([])
    },
  )

  it('renders every id the TOC names, and no section the TOC does not know', () => {
    for (const lang of GUIDE_LANGS) {
      for (const slug of slugsWithContent(lang)) {
        const chapter = chaptersOf(lang).find((c) => c.slug === slug)!
        const page = rendered.get(key(lang, slug))!
        const missing = tocIds(chapter).filter((id) => !page.ids.has(id))
        expect(missing, `${lang}/${slug}: TOC ids the chapter does not render`).toEqual([])
        const unknown = page.sectionIds.filter((id) => !tocIds(chapter).includes(id))
        expect(unknown, `${lang}/${slug}: sections absent from the TOC`).toEqual([])
      }
    }
  })

  it('renders the same ids in both editions of a chapter', () => {
    for (const slug of slugsWithContent('vi')) {
      expect([...rendered.get(key('en', slug))!.ids].sort(), slug).toEqual(
        [...rendered.get(key('vi', slug))!.ids].sort(),
      )
    }
  })

  it('links only to chapters and sections that exist, in the edition being read', () => {
    for (const [page, { links }] of rendered) {
      const lang = page.split('/')[0] as GuideLang
      for (const link of links) {
        const where = `${page} → ${link.lang}/${link.chapter}#${link.hash}`
        expect(link.lang, where).toBe(lang)
        const target = chaptersOf(lang).find((c) => c.slug === link.chapter)
        expect(target, `${where}: no such chapter`).toBeDefined()
        if (!link.hash) continue
        // A ported chapter is checked against what it renders; one not ported yet, against its TOC.
        const known = rendered.get(key(lang, link.chapter))?.ids ?? new Set(tocIds(target!))
        expect(known.has(link.hash), `${where}: no such section`).toBe(true)
      }
    }
  })

  it('shows only screenshots that exist under the gated assets path', () => {
    const used = new Set<string>()
    for (const [page, { images }] of rendered) {
      for (const src of images) {
        expect(src.startsWith(GUIDE_ASSETS_ROOT), `${page}: ${src} is not gated`).toBe(true)
        const file = src.slice(GUIDE_ASSETS_ROOT.length)
        expect(existsSync(join(ASSETS_DIR, file)), `${page}: ${src} does not exist`).toBe(true)
        used.add(file)
      }
    }
    if (NOT_YET_PORTED.length === 0) {
      const unused = readdirSync(ASSETS_DIR).filter((file) => !used.has(file))
      expect(unused, 'screenshots no chapter shows').toEqual([])
    }
  })

  it('reaches no external origin', () => {
    for (const [page, { externals }] of rendered) expect(externals, page).toEqual([])
  })
})
