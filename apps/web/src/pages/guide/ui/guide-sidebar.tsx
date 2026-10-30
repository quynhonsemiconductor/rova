import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/icon-button'
import { SearchInput } from '@/shared/ui/search-input'
import type { GuideLang } from '../model/guide-url'
import { GUIDE_TOC, matchesQuery, type GuideChapter } from '../model/toc'

interface GuideSidebarProps {
  lang: GuideLang
  chapter: string
  activeSection?: string
  query: string
  onQueryChange: (query: string) => void
  /** Called after a link is followed, so the narrow-screen drawer can close. */
  onNavigate?: () => void
}

/**
 * The guide's table of contents: search, one row per chapter, its sections under a toggle.
 *
 * Search keeps the static guide's rule — a chapter that matches shows all its sections, a chapter
 * that does not shows only the sections that match, and a chapter with neither is hidden — and opens
 * every chapter it leaves standing, so a hit is never folded away.
 */
export function GuideSidebar({
  lang,
  chapter,
  activeSection,
  query,
  onQueryChange,
  onNavigate,
}: GuideSidebarProps) {
  const { t } = useTranslation('guide', { lng: lang })
  const searching = query.trim() !== ''

  return (
    <nav aria-label={t('contents')} className="flex h-full flex-col">
      <div className="sticky top-0 z-10 bg-card px-4 pt-4 pb-3">
        <SearchInput
          value={query}
          onChange={onQueryChange}
          placeholder={t('search')}
          className="h-9 w-full"
          iconSize={14}
        />
      </div>
      <div className="px-2.5 pb-5">
        {GUIDE_TOC[lang].map((group) => {
          const rows = group.chapters
            .map((c) => ({ chapter: c, sections: visibleSections(c, query) }))
            .filter((row) => row.sections !== null)
          if (rows.length === 0) return null
          return (
            <div key={group.label}>
              <p className="mx-3 mt-5 mb-2 text-ui-xs font-extrabold tracking-widest text-foreground-subtle">
                {group.label}
              </p>
              {rows.map(({ chapter: c, sections }) => (
                <ChapterRow
                  key={c.slug}
                  lang={lang}
                  chapter={c}
                  sections={sections ?? []}
                  current={c.slug === chapter}
                  activeSection={activeSection}
                  forceOpen={searching}
                  toggleLabel={t('toggleSections', { title: c.title })}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          )
        })}
      </div>
    </nav>
  )
}

/** The sections to list under `chapter`, or `null` when search hides the chapter entirely. */
function visibleSections(chapter: GuideChapter, query: string) {
  if (matchesQuery(query, chapter.title, chapter.subtitle, chapter.keywords))
    return chapter.sections
  const hits = chapter.sections.filter((s) => matchesQuery(query, s.title, s.keywords))
  return hits.length > 0 ? hits : null
}

function ChapterRow({
  lang,
  chapter,
  sections,
  current,
  activeSection,
  forceOpen,
  toggleLabel,
  onNavigate,
}: {
  lang: GuideLang
  chapter: GuideChapter
  sections: GuideChapter['sections']
  current: boolean
  activeSection?: string
  forceOpen: boolean
  toggleLabel: string
  onNavigate?: () => void
}) {
  // `undefined` = the reader has not touched the toggle: open exactly when this is the chapter on
  // screen, so following a link into another chapter unfolds that one.
  const [toggled, setToggled] = useState<boolean>()
  const open = forceOpen || (toggled ?? current)
  const submenuId = `guide-sections-${chapter.slug}`

  return (
    <div className="mb-0.5">
      <div className="flex items-stretch gap-0.5">
        <Link
          to="/user-guide/$lang/$chapter"
          params={{ lang, chapter: chapter.slug }}
          hash={chapter.anchor}
          onClick={onNavigate}
          aria-current={current ? 'page' : undefined}
          className={cn(
            'flex min-h-13 min-w-0 flex-1 items-center gap-3 rounded-md px-2.5 py-2 text-muted-foreground hover:bg-surface-hover',
            current &&
              'bg-primary-lighter text-primary shadow-[inset_3px_0_0_var(--primary-light)]',
          )}
        >
          <span
            className={cn(
              'w-7 shrink-0 text-ui-xs font-extrabold',
              current ? 'text-primary-light' : 'text-foreground-subtle',
            )}
          >
            {chapter.number}
          </span>
          <span className="min-w-0">
            <strong className="block text-ui-md leading-tight">{chapter.title}</strong>
            <small className="mt-0.5 block text-ui-xs leading-tight text-foreground-subtle">
              {chapter.subtitle}
            </small>
          </span>
        </Link>
        {sections.length > 0 && (
          <IconButton
            aria-label={toggleLabel}
            aria-expanded={open}
            aria-controls={submenuId}
            onClick={() => setToggled(!open)}
            className={cn(
              'h-auto w-8 self-stretch',
              current && 'bg-primary-lighter text-primary-light',
            )}
          >
            <ChevronDown
              size={16}
              aria-hidden="true"
              className={cn(
                'transition-transform motion-reduce:transition-none',
                open && 'rotate-180',
              )}
            />
          </IconButton>
        )}
      </div>
      {open && sections.length > 0 && (
        <div id={submenuId} className="my-1 mr-2 ml-10 border-l border-border-subtle py-0.5 pl-3">
          {sections.map((section) => {
            const active = current && section.id === activeSection
            return (
              <Link
                key={section.id}
                to="/user-guide/$lang/$chapter"
                params={{ lang, chapter: chapter.slug }}
                hash={section.id}
                onClick={onNavigate}
                aria-current={active ? 'location' : undefined}
                className={cn(
                  'grid grid-cols-[2.5rem_minmax(0,1fr)] gap-1 rounded px-2 py-1.5 text-ui-xs leading-snug text-muted-foreground hover:bg-surface-hover hover:text-primary',
                  active && 'bg-accent-bg-subtle font-bold text-primary-light',
                )}
              >
                <span
                  className={cn(
                    'font-extrabold',
                    active ? 'text-primary-light' : 'text-foreground-subtle',
                  )}
                >
                  {section.number}
                </span>
                {section.title}
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
