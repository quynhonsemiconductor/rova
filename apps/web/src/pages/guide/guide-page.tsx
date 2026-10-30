import { Suspense, useMemo, useRef, useState, type RefObject } from 'react'
import { Navigate, useParams, useRouterState } from '@tanstack/react-router'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/icon-button'
import { PageSpinner } from '@/shared/ui/spinner'
import { GUIDE_CHAPTERS } from './model/chapters'
import { START_CHAPTER, browserGuideLang, isGuideLang, type GuideLang } from './model/guide-url'
import { canonicalChapterSlug, findChapter, type GuideChapter } from './model/toc'
import { useActiveSection, useScrollToHash } from './model/use-guide-scroll'
import { GuideContext } from './ui/guide-context'
import { ChapterPager, GuideFooter, GuideHeader } from './ui/guide-chrome'
import { GuideSidebar } from './ui/guide-sidebar'

/**
 * The User Guide (US-119) as a page of the app: `/user-guide/<lang>/<chapter>#<section>`.
 *
 * It replaces the standalone HTML guide under `public/guide`, which Pages served through a session
 * gate that asked the API about the reader on every file — page, stylesheet, script and screenshot
 * alike. Here the reader is already signed in (the route sits under `authRoute`), and only the files
 * that are the guide — the chunks carrying its text and its screenshots — pass that gate, under
 * `/guide-assets/` (see `chunkFileName` in `vite.config.ts`).
 *
 * This component only settles the URL — an unknown edition, a static-guide spelling of a chapter
 * (`01-lam-quen.html`, `index`, which old bookmarks reach through `public/_redirects`) or an unknown
 * chapter is replaced by its canonical URL — and hands a valid one to `GuideReader`.
 */
export function GuidePage() {
  const params = useParams({ from: '/auth/user-guide/$lang/$chapter' })
  const hash = useRouterState({ select: (s) => s.location.hash })

  const lang: GuideLang = isGuideLang(params.lang) ? params.lang : browserGuideLang()
  const slug = canonicalChapterSlug(params.chapter)
  // A TOC entry always has its chapter file (`user-guide.integrity.test.tsx`); checking both keeps
  // `GuideReader` from ever being handed a chapter it cannot render.
  const chapter = GUIDE_CHAPTERS[lang][slug] ? findChapter(lang, slug) : undefined

  if (!chapter || lang !== params.lang || slug !== params.chapter) {
    return (
      <Navigate
        to="/user-guide/$lang/$chapter"
        params={{ lang, chapter: chapter ? slug : START_CHAPTER }}
        hash={chapter ? hash || undefined : undefined}
        replace
      />
    )
  }
  return <GuideReader lang={lang} chapter={chapter} hash={hash} />
}

function GuideReader({
  lang,
  chapter,
  hash,
}: {
  lang: GuideLang
  chapter: GuideChapter
  hash: string
}) {
  const { t } = useTranslation('guide', { lng: lang })
  const [query, setQuery] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const pane = useRef<HTMLDivElement>(null)

  const sectionIds = useMemo(
    () => [chapter.anchor, ...chapter.sections.map((s) => s.id)],
    [chapter],
  )
  const activeSection = useActiveSection(pane, sectionIds)
  const context = useMemo(() => ({ lang, chapter: chapter.slug, query }), [lang, chapter, query])
  // Present: `GuidePage` only renders this for a chapter that has its file.
  const Content = GUIDE_CHAPTERS[lang][chapter.slug]!

  return (
    <GuideContext.Provider value={context}>
      {/* `lang` so a screen reader reads the Vietnamese edition as Vietnamese. */}
      <div lang={lang} className="relative flex flex-1 overflow-hidden bg-card">
        <aside
          className={cn(
            'w-72 shrink-0 overflow-y-auto border-r border-border-subtle bg-card',
            'max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-20 max-md:shadow-lg',
            !menuOpen && 'max-md:hidden',
          )}
        >
          <div className="flex justify-end px-2 pt-2 md:hidden">
            <IconButton aria-label={t('closeMenu')} onClick={() => setMenuOpen(false)}>
              <X size={16} aria-hidden="true" />
            </IconButton>
          </div>
          <GuideSidebar
            lang={lang}
            chapter={chapter.slug}
            activeSection={activeSection}
            query={query}
            onQueryChange={setQuery}
            onNavigate={() => setMenuOpen(false)}
          />
        </aside>

        <div ref={pane} className="min-w-0 flex-1 overflow-y-auto">
          <GuideHeader
            lang={lang}
            chapter={chapter}
            hash={hash}
            onOpenMenu={() => setMenuOpen(true)}
          />
          <article className="mx-auto w-full max-w-5xl px-9 pb-14 max-md:px-4">
            <Suspense fallback={<PageSpinner />}>
              <Content />
              <ScrollToHash pane={pane} chapter={chapter.slug} hash={hash} />
            </Suspense>
            <ChapterPager lang={lang} chapter={chapter} />
            <GuideFooter lang={lang} chapter={chapter} pane={pane} />
          </article>
        </div>
      </div>
    </GuideContext.Provider>
  )
}

/** Rendered inside the chapter's `Suspense`, so it runs once the chapter is on screen. */
function ScrollToHash({
  pane,
  chapter,
  hash,
}: {
  pane: RefObject<HTMLElement | null>
  chapter: string
  hash: string
}) {
  useScrollToHash(pane, chapter, hash)
  return null
}
