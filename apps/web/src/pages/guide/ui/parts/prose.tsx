import type { ReactNode } from 'react'
import { Info, TriangleAlert } from 'lucide-react'
import type { PortfolioItemType, WorkItemType } from '@/entities/work-item/model/types'
import { TypeBadge } from '@/entities/work-item/ui/badges'
import { cn } from '@/shared/lib/utils'
import { ProseContext, useProse } from '../guide-context'
import { part } from './part'

/*
 * The guide's long-form blocks, as they render inside a chapter section.
 *
 * Every chapter section of the static guide carried `.prose-section`, whose overrides flatten the
 * card grids of `styles.css` into ruled rows and turn callouts into ruled quotes — so that, not the
 * boxed card, is the look ported here. Colours are the app's tokens, not the guide's hex palette, so
 * the guide follows the app's theme (dark mode included).
 */

// ── Chapter frame ─────────────────────────────────────────────────────────────

export function Section({
  id,
  number,
  title,
  lead,
  prose = true,
  children,
}: {
  id: string
  number: string
  title: ReactNode
  lead?: ReactNode
  /** False for the start page's boxed sections. */
  prose?: boolean
  children: ReactNode
}) {
  return (
    <ProseContext.Provider value={prose}>
      <section id={id} className={cn('scroll-mt-6', prose ? 'mb-24' : 'mb-16')}>
        <div className="mb-8 grid grid-cols-[max-content_1fr] items-start gap-3 max-sm:grid-cols-1 max-sm:gap-0.5">
          <span className="pt-1.5 text-ui-sm font-extrabold tracking-wide text-primary-light underline decoration-1 underline-offset-4 max-sm:pt-0">
            {number}
          </span>
          <div>
            <h2 className="mb-1.5 text-doc-h2 font-bold text-foreground underline decoration-1 underline-offset-4">
              {title}
            </h2>
            {lead && (
              <p className={cn('text-muted-foreground', prose ? 'text-doc-lead' : 'text-ui-lg')}>
                {lead}
              </p>
            )}
          </div>
        </div>
        {children}
      </section>
    </ProseContext.Provider>
  )
}

export const ChapterIntro = part(
  'section',
  'mt-9 mb-18 scroll-mt-6 border-b border-border-subtle pb-9 [&_h2]:mb-3.5 [&_h2]:text-doc-h2 [&_h2]:font-bold [&_h2]:text-foreground',
  'ChapterIntro',
)

export const ChapterEyebrow = part(
  'span',
  'mb-5 block border-l-5 border-primary-light pl-4 text-doc-title font-extrabold tracking-tight text-foreground',
  'ChapterEyebrow',
)

export const Lead = part('p', 'text-doc-lead text-muted-foreground', 'Lead')

export const ScopeLeadPath = part('strong', 'mt-1.5 mb-0.5 block text-primary', 'ScopeLeadPath')

export const ScopeLeadFollow = part('span', 'block', 'ScopeLeadFollow')

export const ChapterSummary = part(
  'aside',
  'mt-7 border-t border-border-subtle pt-6 [&>strong]:text-ui-md [&>strong]:font-bold [&>strong]:text-primary [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:columns-2 [&_ul]:gap-x-10 [&_ul]:pl-5 [&_ul]:text-ui-lg [&_ul]:leading-relaxed [&_ul]:text-muted-foreground max-sm:[&_ul]:columns-1 [&_li+li]:mt-1.5',
  'ChapterSummary',
)

// ── Notes ─────────────────────────────────────────────────────────────────────

/**
 * A note beside the text. A ruled quote inside a chapter section; a boxed card with its icon on the
 * start page, which is the static guide's own split.
 */
export function Callout({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warning'
  children: ReactNode
}) {
  const prose = useProse()
  const warning = tone === 'warning'
  if (prose) {
    return (
      <aside
        className={cn(
          'mt-4 border-l-3 py-1 pl-4 [&>p]:mt-1.5 [&>p]:text-doc-body [&>p]:text-muted-foreground [&>strong]:block [&>strong]:text-doc-lead [&>strong]:font-bold [&>strong]:text-primary',
          warning ? 'border-warning' : 'border-accent-border-strong',
        )}
      >
        {children}
      </aside>
    )
  }
  const Icon = warning ? TriangleAlert : Info
  return (
    <aside
      className={cn(
        'mt-4 flex gap-3 rounded-lg border px-5 py-4 [&_p]:mt-1 [&_p]:text-ui-sm [&_p]:text-muted-foreground [&_strong]:block [&_strong]:text-ui-md [&_strong]:text-primary',
        warning
          ? 'border-warning-border bg-warning-bg'
          : 'border-accent-border bg-accent-bg-subtle',
      )}
    >
      <Icon
        size={20}
        aria-hidden="true"
        className={cn('mt-0.5 shrink-0', warning ? 'text-warning' : 'text-primary-light')}
      />
      <div>{children}</div>
    </aside>
  )
}

export const CheckUnderstanding = part(
  'div',
  'mt-4 border-t border-border-subtle pt-5 [&>strong]:text-doc-lead [&>strong]:font-bold [&>strong]:text-primary [&_ul]:mt-2.5 [&_ul]:grid [&_ul]:list-disc [&_ul]:grid-cols-2 [&_ul]:gap-x-7 [&_ul]:gap-y-1.5 [&_ul]:pl-5 [&_ul]:text-ui-lg [&_ul]:text-muted-foreground max-sm:[&_ul]:grid-cols-1',
  'CheckUnderstanding',
)

// ── Type marks ────────────────────────────────────────────────────────────────

// From the entity, so a renamed type fails to compile here instead of rendering the fallback mark.
type MarkType = WorkItemType | PortfolioItemType
type TimeboxType = 'iteration' | 'release' | 'milestone'

/**
 * A work-item type mark. The app's own `TypeBadge`, not the static guide's lettered chip, so a
 * reader sees in the guide the exact mark they will meet on the Backlog.
 */
export function TypeChip({ type }: { type: MarkType }) {
  return <TypeBadge type={type} size={28} />
}

// ── Scope and work structure ──────────────────────────────────────────────────

export const ScopeLevels = part(
  'div',
  '[&_h3]:mt-1 [&_h3]:mb-2 [&_h3]:text-doc-h3 [&_h3]:font-bold [&_h3]:text-foreground [&_p]:mb-3 [&_p]:text-doc-body [&_p]:text-muted-foreground [&_small]:text-ui-sm [&_small]:text-muted-foreground [&>article]:flex [&>article]:gap-4 [&>article]:border-t [&>article]:border-border-subtle [&>article]:py-6 [&>article:last-of-type]:border-b',
  'ScopeLevels',
)

export const ScopeLevel = part(
  'span',
  'grid size-8 shrink-0 place-items-center rounded-md bg-primary text-ui-xs font-extrabold text-primary-foreground',
  'ScopeLevel',
)

export const ObjectLabel = part(
  'span',
  'text-ui-xs font-extrabold tracking-widest text-primary-light',
  'ObjectLabel',
)

export const WorkTree = part(
  'div',
  'rounded-xl border border-border-subtle bg-card p-7 max-sm:p-4',
  'WorkTree',
)

const TREE_ARTICLE =
  '[&_h3]:mb-1 [&_h3]:text-ui-xl [&_h3]:font-bold [&_h3]:text-foreground [&_p]:text-ui-md [&_p]:text-muted-foreground [&>article]:flex [&>article]:w-full [&>article]:items-start [&>article]:gap-3 [&>article]:rounded-lg [&>article]:border [&>article]:border-border-subtle [&>article]:bg-surface-subtle [&>article]:px-5 [&>article]:py-4'

export function TreeRow({
  level,
  children,
}: {
  level: 'epic' | 'feature' | 'work-item' | 'task'
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'relative flex justify-center gap-4',
        TREE_ARTICLE,
        level === 'work-item'
          ? 'max-md:flex-col [&>article]:max-w-sm max-md:[&>article]:max-w-none'
          : '[&>article]:max-w-md',
      )}
    >
      {children}
    </div>
  )
}

/**
 * The lines between tree rows. `split` fans one row out to two and `merge` joins them back; on a
 * narrow screen the rows stack, so both collapse to a plain line and the line after a merge (which
 * would double it) is dropped.
 */
export function TreeConnector({ shape = 'line' }: { shape?: 'line' | 'split' | 'merge' }) {
  if (shape === 'line') {
    return (
      <div
        aria-hidden="true"
        className="mx-auto h-6 w-px bg-border-strong max-md:[[data-merge]+&]:hidden"
      />
    )
  }
  return (
    <div
      aria-hidden="true"
      data-merge={shape === 'merge' ? '' : undefined}
      className={cn(
        'mx-auto h-6 w-1/2 border-x border-border-strong max-md:w-px max-md:border-0 max-md:bg-border-strong',
        shape === 'split' ? 'border-t' : 'border-b',
      )}
    />
  )
}

// ── Row lists (the flattened card grids) ──────────────────────────────────────

const ROWS =
  '[&>article]:border-b [&>article]:border-border-subtle [&>article]:py-5 [&>article:first-child]:border-t'

export const DefinitionGrid = part(
  'div',
  cn(
    ROWS,
    'mt-3.5 [&_p]:text-doc-body [&_p]:text-muted-foreground [&>article>strong]:mb-1 [&>article>strong]:block [&>article>strong]:text-ui-lg [&>article>strong]:font-bold [&>article>strong]:text-primary',
  ),
  'DefinitionGrid',
)

export const PlanningGrid = part(
  'div',
  cn(
    ROWS,
    '[&_h3]:col-start-2 [&_h3]:mb-1 [&_h3]:text-doc-h2 [&_h3]:font-bold [&_h3]:text-foreground [&>article]:grid [&>article]:grid-cols-[2.75rem_minmax(0,1fr)] [&>article]:items-start [&>article]:gap-x-4 [&>article>p]:col-start-2 [&>article>p]:text-doc-body [&>article>p]:text-muted-foreground',
  ),
  'PlanningGrid',
)

export function PlanningIcon({ type = 'iteration' }: { type?: TimeboxType }) {
  return (
    <span className="col-start-1 row-span-3 mt-0.5">
      <TypeBadge type={type} size={32} />
    </span>
  )
}

export const PlanningQuestion = part(
  'div',
  'col-start-2 mt-1.5 border-t border-border-inner pt-2 [&>span]:block [&>span]:text-ui-xs [&>span]:tracking-wider [&>span]:text-muted-foreground [&>span]:uppercase [&>strong]:mt-0.5 [&>strong]:block [&>strong]:text-ui-md [&>strong]:text-primary',
  'PlanningQuestion',
)

// ── Tables ────────────────────────────────────────────────────────────────────

/** A reference table (permissions, fields). `thead`/`tbody` are written by the chapter. */
export function DocTable({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-ui-sm [&_td]:border-t [&_td]:border-border-subtle [&_td]:px-3 [&_td]:py-4 [&_td]:align-top [&_td]:text-ui-lg [&_td]:leading-relaxed [&_td]:text-muted-foreground [&_td:first-child]:w-44 [&_td:first-child]:text-primary [&_td:nth-child(2)]:w-48 [&_th]:border-b [&_th]:border-border-strong [&_th]:p-3 [&_th]:text-left [&_th]:text-ui-xs [&_th]:tracking-wider [&_th]:text-muted-foreground [&_th]:uppercase">
        {children}
      </table>
    </div>
  )
}

// ── Worked example ────────────────────────────────────────────────────────────

export const ScenarioCard = part(
  'div',
  'border-l-3 border-accent-border-strong pl-5',
  'ScenarioCard',
)

export const ScenarioHead = part(
  'div',
  'flex items-center gap-4 pb-4 [&_h3]:mb-1 [&_h3]:text-doc-h2 [&_h3]:font-bold [&_h3]:text-foreground [&_p]:text-doc-body [&_p]:text-muted-foreground',
  'ScenarioHead',
)

export const ScenarioBadge = part(
  'span',
  'rounded-md bg-primary-light px-2.5 py-1.5 text-ui-xs font-extrabold tracking-wider text-primary-foreground',
  'ScenarioBadge',
)

export const ScenarioScope = part(
  'div',
  'flex flex-wrap items-center gap-2.5 py-3 text-ui-lg text-muted-foreground [&_i]:text-foreground-subtle [&_i]:not-italic [&_strong]:text-primary',
  'ScenarioScope',
)

export const ScenarioFlow = part(
  'ol',
  'py-3 [&_p]:text-ui-lg [&_p]:text-muted-foreground [&_strong]:mb-1 [&_strong]:block [&_strong]:text-doc-lead [&_strong]:text-primary [&>li]:flex [&>li]:gap-3 [&>li]:py-3 [&>li>span]:grid [&>li>span]:h-7 [&>li>span]:w-8 [&>li>span]:shrink-0 [&>li>span]:place-items-center [&>li>span]:rounded-md [&>li>span]:bg-primary-lighter [&>li>span]:text-ui-xs [&>li>span]:font-extrabold [&>li>span]:text-primary',
  'ScenarioFlow',
)

export const ScenarioPlanning = part(
  'div',
  '[&_span]:block [&_span]:text-ui-xs [&_span]:font-extrabold [&_span]:tracking-wider [&_span]:text-primary-light [&_span]:uppercase [&_strong]:mt-1 [&_strong]:block [&_strong]:text-ui-lg [&_strong]:text-muted-foreground [&>div]:border-t [&>div]:border-border-subtle [&>div]:py-3',
  'ScenarioPlanning',
)
