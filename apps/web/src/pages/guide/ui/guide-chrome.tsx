import type { RefObject } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { Menu } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/button'
import { IconButton } from '@/shared/ui/icon-button'
import { CompactSelect } from '@/shared/ui/native-select'
import { GUIDE_LANGS, START_CHAPTER, isGuideLang, type GuideLang } from '../model/guide-url'
import { adjacentChapters, type GuideChapter } from '../model/toc'

/** The bar above a chapter: breadcrumb, edition version, language. */
export function GuideHeader({
  lang,
  chapter,
  hash,
  onOpenMenu,
}: {
  lang: GuideLang
  chapter: GuideChapter
  hash: string
  onOpenMenu: () => void
}) {
  const { t } = useTranslation('guide', { lng: lang })
  const navigate = useNavigate()

  return (
    <header className="flex items-center gap-3 border-b border-border-subtle px-9 py-3 max-md:px-4">
      <IconButton aria-label={t('openMenu')} onClick={onOpenMenu} className="md:hidden">
        <Menu size={18} aria-hidden="true" />
      </IconButton>
      <nav
        aria-label={t('breadcrumb')}
        className="flex min-w-0 flex-1 gap-2 text-ui-sm text-muted-foreground"
      >
        <Link
          to="/user-guide/$lang/$chapter"
          params={{ lang, chapter: START_CHAPTER }}
          className="shrink-0 hover:text-primary-light hover:underline max-sm:hidden"
        >
          {t('title')}
        </Link>
        <span aria-hidden="true" className="max-sm:hidden">
          /
        </span>
        <strong className="truncate text-foreground">
          {chapter.number}. {chapter.title}
        </strong>
      </nav>
      <span className="ml-auto shrink-0 rounded-full border border-border-strong px-2.5 py-0.5 text-ui-xs font-bold whitespace-nowrap text-muted-foreground max-sm:hidden">
        {t('version')}
      </span>
      {/* Same chapter and section in the other edition: slugs and ids are shared (see toc.ts). */}
      <CompactSelect
        aria-label={t('language')}
        value={lang}
        onChange={(e) => {
          const next = e.target.value
          if (!isGuideLang(next)) return
          void navigate({
            to: '/user-guide/$lang/$chapter',
            params: { lang: next, chapter: chapter.slug },
            hash: hash || undefined,
          })
        }}
      >
        {GUIDE_LANGS.map((code) => (
          <option key={code} value={code}>
            {t(`languages.${code}`)}
          </option>
        ))}
      </CompactSelect>
    </header>
  )
}

/** Previous / next chapter, in reading order. */
export function ChapterPager({ lang, chapter }: { lang: GuideLang; chapter: GuideChapter }) {
  const { t } = useTranslation('guide', { lng: lang })
  const { previous, next } = adjacentChapters(lang, chapter.slug)
  const link = (target: GuideChapter, label: string, direction: 'previous' | 'next') => (
    <Link
      to="/user-guide/$lang/$chapter"
      params={{ lang, chapter: target.slug }}
      hash={target.anchor}
      rel={direction === 'next' ? 'next' : 'prev'}
      className={`group flex items-center gap-3 text-foreground ${direction === 'next' ? 'justify-end text-right max-sm:justify-start max-sm:text-left' : ''}`}
    >
      {direction === 'previous' && (
        <span
          aria-hidden="true"
          className="text-doc-title text-primary-light transition-transform group-hover:-translate-x-1"
        >
          ←
        </span>
      )}
      <span className="flex flex-col gap-0.5">
        <small className="text-ui-xs font-bold tracking-wider text-muted-foreground uppercase">
          {label}
        </small>
        <strong className="text-ui-lg">
          {target.number}. {target.title}
        </strong>
      </span>
      {direction === 'next' && (
        <span
          aria-hidden="true"
          className="text-doc-title text-primary-light transition-transform group-hover:translate-x-1"
        >
          →
        </span>
      )}
    </Link>
  )

  return (
    <nav
      aria-label={t('pager')}
      className="mt-5 mb-16 grid grid-cols-2 gap-6 border-t border-border-subtle pt-5 max-sm:grid-cols-1"
    >
      {previous ? link(previous, t('previous'), 'previous') : <span aria-hidden="true" />}
      {next && link(next, t('next'), 'next')}
    </nav>
  )
}

export function GuideFooter({
  lang,
  chapter,
  pane,
}: {
  lang: GuideLang
  chapter: GuideChapter
  pane: RefObject<HTMLElement | null>
}) {
  const { t } = useTranslation('guide', { lng: lang })
  return (
    <footer className="flex items-center justify-between gap-4 border-t border-border-subtle pt-6 text-ui-xs text-muted-foreground max-sm:flex-col max-sm:items-start">
      <div>
        <strong className="block text-foreground">{t('title')}</strong>
        <span className="block">
          {chapter.number}. {chapter.title} · {t('version')}
        </span>
      </div>
      <Button variant="link" size="xs" onClick={() => pane.current?.scrollTo({ top: 0 })}>
        {t('backToTop')}
      </Button>
    </footer>
  )
}
