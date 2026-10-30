import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { GuideLang } from './guide-url'

type ChapterModule = { default: ComponentType }

/**
 * Every chapter file, one lazy chunk each. Discovered rather than listed, so a new chapter needs no
 * registration here — only a TOC entry, and `user-guide.integrity.test.tsx` fails until the two agree.
 * One chunk per chapter per edition keeps the shell and the reader's first chapter small: the guide is
 * ~1 MB of prose across both editions.
 */
export const CHAPTER_MODULES = import.meta.glob<ChapterModule>('../content/*/*.tsx')

/**
 * The chapters as components, keyed by edition then slug. Built ONCE, here: `lazy` called during
 * render would hand React a new component type every time, and it would remount the chapter on each
 * render. `lazy` loads nothing until the component is first rendered.
 */
type ChapterComponents = Readonly<Partial<Record<string, LazyExoticComponent<ComponentType>>>>

function lazyChaptersOf(lang: GuideLang): ChapterComponents {
  const dir = `../content/${lang}/`
  return Object.fromEntries(
    Object.entries(CHAPTER_MODULES)
      .filter(([path]) => path.startsWith(dir))
      .map(([path, load]) => [path.slice(dir.length, -'.tsx'.length), lazy(load)]),
  )
}

export const GUIDE_CHAPTERS: Readonly<Record<GuideLang, ChapterComponents>> = {
  vi: lazyChaptersOf('vi'),
  en: lazyChaptersOf('en'),
}
