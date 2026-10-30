import type { ReactNode } from 'react'
import { buttonVariants } from '@/shared/ui/button'
import { cn } from '@/shared/lib/utils'
import { matchesQuery } from '../../model/toc'
import { useGuide } from '../guide-context'
import { GuideLink } from '../guide-link'
import { part } from './part'

/*
 * The start page's blocks (chapter 00). Unlike the chapters, its sections were never prose sections
 * in the static guide: they are boxed cards, a hero and a scope mock-up, ported here as such.
 */

// ── Hero ──────────────────────────────────────────────────────────────────────

export const Hero = part(
  'section',
  'mt-8 grid scroll-mt-6 grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)] items-center gap-12 rounded-2xl border border-border-subtle bg-card p-12 shadow-sm max-lg:grid-cols-1 max-md:p-8 max-sm:p-6 [&_h1]:mb-4 [&_h1]:max-w-2xl [&_h1]:text-doc-display [&_h1]:font-bold [&_h1]:tracking-tight [&_h1]:text-foreground max-sm:[&_h1]:text-doc-title',
  'Hero',
)

export const HeroCopy = part('div', '[&>p]:mb-6 [&>p]:max-w-2xl', 'HeroCopy')

export const Eyebrow = part(
  'span',
  'mb-3 block text-ui-xs font-extrabold tracking-widest text-primary-light',
  'Eyebrow',
)

export const HeroActions = part('div', 'flex flex-wrap gap-2.5 max-sm:flex-col', 'HeroActions')

/** A call to action that jumps to a section of the start page. */
export function HeroButton({
  variant,
  hash,
  children,
}: {
  variant: 'primary' | 'secondary'
  hash: string
  children: ReactNode
}) {
  return (
    <GuideLink
      hash={hash}
      className={cn(
        buttonVariants({ variant: variant === 'primary' ? 'default' : 'secondary' }),
        'hover:no-underline',
      )}
    >
      {children}
    </GuideLink>
  )
}

// ── Scope mock-up beside the hero ─────────────────────────────────────────────

export const ScopePreview = part(
  'div',
  'rotate-1 overflow-hidden rounded-xl border border-border-strong bg-surface-subtle shadow-md max-lg:max-w-lg max-lg:rotate-0',
  'ScopePreview',
)

export const PreviewTop = part(
  'div',
  'flex h-11 items-center gap-2.5 bg-primary px-3.5 text-primary-foreground',
  'PreviewTop',
)

export const PreviewLogo = part('span', 'text-ui-sm font-extrabold', 'PreviewLogo')

export const PreviewContext = part(
  'span',
  'border-l border-primary-foreground/30 pl-2.5 text-ui-xs text-primary-foreground/80',
  'PreviewContext',
)

export const PreviewBody = part(
  'div',
  'p-5 [&>p]:mb-3 [&>p]:text-ui-xs [&>p]:font-extrabold [&>p]:tracking-wider [&>p]:text-muted-foreground [&>p]:uppercase',
  'PreviewBody',
)

export const ScopePath = part(
  'div',
  'grid gap-px rounded-md border border-border-subtle bg-card p-3.5 [&_b]:mb-1 [&_b]:text-ui-sm [&_b]:text-primary [&_i]:hidden [&_span]:text-ui-xs [&_span]:tracking-wider [&_span]:text-muted-foreground [&_span]:uppercase',
  'ScopePath',
)

export const PreviewCards = part(
  'div',
  'mt-2.5 grid grid-cols-[1.3fr_0.7fr] gap-2 [&_i]:mb-2 [&_i]:block [&_i]:h-1.5 [&_i]:rounded-sm [&_i]:bg-muted [&_i:first-child]:w-3/5 [&_i:first-child]:bg-accent-border-strong [&>span]:min-h-16 [&>span]:rounded-md [&>span]:border [&>span]:border-border-subtle [&>span]:bg-card [&>span]:p-2.5',
  'PreviewCards',
)

export const PreviewCaption = part(
  'p',
  'border-t border-border-subtle bg-card px-4 py-3 text-ui-xs text-muted-foreground',
  'PreviewCaption',
)

// ── Document facts ────────────────────────────────────────────────────────────

export const MetaStrip = part(
  'section',
  'mt-6 mb-14 grid grid-cols-4 rounded-xl border border-border-subtle bg-card max-lg:grid-cols-2 max-sm:grid-cols-1 [&_span]:mb-1 [&_span]:block [&_span]:text-ui-xs [&_span]:tracking-wider [&_span]:text-muted-foreground [&_span]:uppercase [&_strong]:block [&_strong]:text-ui-sm [&_strong]:text-foreground [&>div]:border-border-subtle [&>div]:px-5 [&>div]:py-4 lg:[&>div:not(:last-child)]:border-r max-lg:[&>div:not(:last-child)]:border-b',
  'MetaStrip',
)

// ── Before you start ──────────────────────────────────────────────────────────

export const StarterGrid = part('div', 'grid grid-cols-3 gap-4 max-md:grid-cols-1', 'StarterGrid')

export const StarterCard = part(
  'article',
  'min-h-44 rounded-xl border border-border-subtle bg-card p-6 [&_h3]:mb-2 [&_h3]:text-doc-lead [&_h3]:font-bold [&_h3]:text-foreground [&_p]:text-ui-md [&_p]:text-muted-foreground',
  'StarterCard',
)

export const StepBadge = part(
  'span',
  'mb-5 grid size-8 place-items-center rounded-md bg-primary text-ui-sm font-extrabold text-primary-foreground',
  'StepBadge',
)

// ── Learning paths ────────────────────────────────────────────────────────────

interface PathCardProps {
  /** Search terms; the sidebar search filters the cards on them. */
  keywords: string
  children: ReactNode
}

/** A learning path. Hides itself when the sidebar search does not match its `keywords`. */
export function PathCard({ keywords, children }: PathCardProps) {
  const { query } = useGuide()
  if (!matchesQuery(query, keywords)) return null
  return (
    <article className="grid min-h-60 grid-cols-[3.25rem_1fr] gap-4 rounded-xl border border-border-subtle bg-card p-6 transition hover:-translate-y-0.5 hover:shadow-md motion-reduce:transition-none max-sm:grid-cols-1">
      {children}
    </article>
  )
}

/**
 * The path cards, narrowed by the sidebar search exactly as the static guide narrowed them, with its
 * "nothing matches" line when the search leaves none.
 *
 * Each `PathCard` filters itself, so the grid never reads its children's props (which would break the
 * moment a card is wrapped). Whether any card is left is the DOM's answer: the "nothing matches" line
 * shows only after a grid with no elements left in it (`div:empty + p`).
 */
export function PathGrid({ empty, children }: { empty: ReactNode; children: ReactNode }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">{children}</div>
      <p className="hidden rounded-xl border border-dashed border-border-strong bg-card p-7 text-center text-ui-md text-muted-foreground [div:empty+&]:block">
        {empty}
      </p>
    </>
  )
}

const PATH_TONE = {
  blue: 'bg-accent-blue text-primary-light',
  teal: 'bg-success-bg text-success',
  violet: 'bg-primary-lighter text-primary',
  amber: 'bg-warning-bg text-warning',
} as const

export function PathIcon({
  tone,
  children,
}: {
  tone: keyof typeof PATH_TONE
  children: ReactNode
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'grid size-12 place-items-center rounded-lg text-ui-sm font-extrabold',
        PATH_TONE[tone],
      )}
    >
      {children}
    </div>
  )
}

export const PathCopy = part(
  'div',
  '[&_a]:flex [&_a]:justify-between [&_a]:gap-2.5 [&_a]:border-t [&_a]:border-border-inner [&_a]:py-2 [&_a]:text-ui-sm [&_a]:text-muted-foreground [&_a_span]:text-ui-xs [&_a_span]:whitespace-nowrap [&_a_span]:text-foreground-subtle [&_a:hover]:text-primary-light [&_h3]:mt-1 [&_h3]:mb-3.5 [&_h3]:text-doc-h3 [&_h3]:font-bold [&_h3]:text-foreground [&_li+li]:mt-1',
  'PathCopy',
)

export const Audience = part(
  'span',
  'text-ui-xs font-extrabold tracking-widest text-primary-light',
  'Audience',
)

// ── How a guide page reads ────────────────────────────────────────────────────

export const ReadingFlow = part(
  'ol',
  'grid grid-cols-5 overflow-hidden rounded-xl border border-border-subtle bg-card max-lg:grid-cols-2 max-sm:grid-cols-1 [&_p]:text-ui-xs [&_p]:text-muted-foreground [&_strong]:mb-1 [&_strong]:block [&_strong]:text-ui-sm [&_strong]:text-foreground [&>li]:flex [&>li]:min-h-28 [&>li]:gap-2.5 [&>li]:border-border-subtle [&>li]:px-4 [&>li]:py-5 lg:[&>li:not(:last-child)]:border-r max-lg:[&>li]:border-b [&>li>span]:text-ui-xs [&>li>span]:font-extrabold [&>li>span]:text-primary-light',
  'ReadingFlow',
)
