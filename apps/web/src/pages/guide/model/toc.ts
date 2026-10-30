import { START_CHAPTER, type GuideLang } from './guide-url'
import { TOC_VI } from './toc.vi'
import { TOC_EN } from './toc.en'

/**
 * The User Guide's table of contents — ONE copy per edition.
 *
 * The static guide repeated a ~250-line sidebar in every one of its 26 pages and kept a second,
 * hand-maintained anchor→page table in `guide.js` to route a link to the right page. Both are this
 * file now: the sidebar renders it, search filters it, the pager walks it, and a link resolves its
 * page from it. The chapter files only render content.
 *
 * Slugs and section ids are the static guide's own, and IDENTICAL across editions, so switching
 * language keeps the reader on the same chapter and section. `user-guide-spa.integrity.test.tsx` pins that
 * and pins every id here to an id the chapter actually renders.
 */
export interface GuideSection {
  /** DOM id of the section in its chapter, i.e. the URL hash. */
  id: string
  /** Display number, e.g. `01.2`. */
  number: string
  title: string
  /** Extra search terms (the static guide's `data-search`). */
  keywords: string
}

export interface GuideChapter {
  slug: string
  /** DOM id of the chapter's own heading. */
  anchor: string
  /** Display number, e.g. `01`. */
  number: string
  title: string
  subtitle: string
  keywords: string
  sections: readonly GuideSection[]
}

export interface GuideGroup {
  label: string
  chapters: readonly GuideChapter[]
}

export const GUIDE_TOC: Readonly<Record<GuideLang, readonly GuideGroup[]>> = {
  vi: TOC_VI,
  en: TOC_EN,
}

export function chaptersOf(lang: GuideLang): readonly GuideChapter[] {
  return GUIDE_TOC[lang].flatMap((group) => group.chapters)
}

export function findChapter(lang: GuideLang, slug: string): GuideChapter | undefined {
  return chaptersOf(lang).find((chapter) => chapter.slug === slug)
}

/** The chapters before and after `slug`, in reading order. */
export function adjacentChapters(
  lang: GuideLang,
  slug: string,
): { previous?: GuideChapter; next?: GuideChapter } {
  const all = chaptersOf(lang)
  const index = all.findIndex((chapter) => chapter.slug === slug)
  if (index < 0) return {}
  return { previous: all[index - 1], next: all[index + 1] }
}

/**
 * A chapter slug as the static guide spelled it, mapped onto this one: Pages served
 * `01-lam-quen.html` and `01-lam-quen` alike, and the start page was `index.html` or the bare folder.
 * Today that covers an old file name typed or pasted onto the new path; old `/guide/…` bookmarks reach
 * it once the static guide is retired and `public/_redirects` sends them here.
 */
export function canonicalChapterSlug(raw: string): string {
  const slug = raw.replace(/\.html$/i, '')
  return slug === '' || slug === 'index' ? START_CHAPTER : slug
}

/** Lower-case and strip Vietnamese diacritics, so `lam quen` finds `Làm quen`. */
export function foldForSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
}

export function matchesQuery(query: string, ...texts: string[]): boolean {
  const needle = foldForSearch(query.trim())
  if (!needle) return true
  return texts.some((text) => foldForSearch(text).includes(needle))
}
