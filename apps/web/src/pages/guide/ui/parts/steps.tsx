import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'
import { part } from './part'

/*
 * The guide's procedure blocks — steps, troubleshooting, panels, results, templates — as they render
 * inside a chapter section. Same rule as `prose.tsx`: the `.prose-section` look, which flattens the
 * static guide's card grids into ruled rows, in the app's tokens.
 */

/** Ruled rows: one rule above the first row and one under each. */
const ROWS =
  '[&>article]:border-b [&>article]:border-border-subtle [&>article]:py-5 [&>article:first-child]:border-t'

/** A row's heading + text, written as `<strong>` + `<p>` inside the row. */
const ROW_TEXT =
  '[&_p]:mt-1 [&_p]:text-doc-body [&_p]:text-muted-foreground [&_strong]:block [&_strong]:text-ui-lg [&_strong]:font-bold [&_strong]:text-foreground'

const ROW_H3 =
  '[&_h3]:mt-2 [&_h3]:mb-1.5 [&_h3]:text-doc-h2 [&_h3]:font-bold [&_h3]:text-foreground [&_p]:text-doc-body [&_p]:text-muted-foreground'

// ── Steps ─────────────────────────────────────────────────────────────────────

/** Numbered steps: `<li><span>1</span><div><strong/><p/></div></li>`. */
export const InstructionList = part(
  'ol',
  'mt-7 first:mt-0 [&_p]:text-doc-body [&_p]:text-muted-foreground [&_strong]:mb-1 [&_strong]:block [&_strong]:text-doc-h3 [&_strong]:font-bold [&_strong]:text-foreground [&>li]:grid [&>li]:grid-cols-[2.25rem_1fr] [&>li]:gap-3 [&>li]:border-b [&>li]:border-border-inner [&>li]:py-5 [&>li:last-child]:border-b-0 [&>li>span]:grid [&>li>span]:size-8 [&>li>span]:place-items-center [&>li>span]:rounded-md [&>li>span]:bg-primary-lighter [&>li>span]:text-ui-xs [&>li>span]:font-extrabold [&>li>span]:text-primary-light',
  'InstructionList',
)

/** What the reader needs before the steps that follow it. */
export const TaskPrereq = part(
  'div',
  'border-b border-border-subtle pb-5 [&>span]:text-ui-xs [&>span]:font-extrabold [&>span]:tracking-wider [&>span]:text-primary-light [&>strong]:mt-2 [&>strong]:mb-2.5 [&>strong]:block [&>strong]:text-doc-h3 [&>strong]:font-bold [&>strong]:text-foreground [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:text-doc-body [&_ul]:text-muted-foreground [&_li+li]:mt-2',
  'TaskPrereq',
)

// ── Rows of short items ───────────────────────────────────────────────────────

/** Problem → fix, numbered: `<article><span>01</span><div><strong/><p/></div></article>`. */
export const TroubleshootList = part(
  'div',
  cn(
    ROWS,
    ROW_TEXT,
    '[&>article]:grid [&>article]:grid-cols-[2.25rem_1fr] [&>article]:gap-3 [&>article>span]:text-ui-xs [&>article>span]:font-extrabold [&>article>span]:text-primary-light',
  ),
  'TroubleshootList',
)

/** Things a screen lets you do, with a round number badge. */
export const ActionGrid = part(
  'div',
  cn(
    ROWS,
    ROW_TEXT,
    '[&>article]:grid [&>article]:grid-cols-[2.25rem_1fr] [&>article]:gap-3 [&>article>span]:grid [&>article>span]:size-7 [&>article>span]:place-items-center [&>article>span]:rounded-full [&>article>span]:bg-primary-light [&>article>span]:text-ui-xs [&>article>span]:font-extrabold [&>article>span]:text-primary-foreground',
  ),
  'ActionGrid',
)

/**
 * The key to an annotated screenshot. Its number badges take the colours of the pins drawn ON the
 * image, in order, which is why they are the `guide-marker-*` tokens and not theme colours.
 */
export const NavigationLegend = part(
  'div',
  cn(
    ROWS,
    ROW_TEXT,
    '[&>article]:flex [&>article]:gap-3 [&>article>span]:grid [&>article>span]:size-6 [&>article>span]:shrink-0 [&>article>span]:place-items-center [&>article>span]:rounded-full [&>article>span]:text-ui-xs [&>article>span]:font-extrabold [&>article>span]:text-primary-foreground [&>article:nth-child(1)>span]:bg-guide-marker-1 [&>article:nth-child(2)>span]:bg-guide-marker-2 [&>article:nth-child(3)>span]:bg-guide-marker-3 [&>article:nth-child(4)>span]:bg-guide-marker-4',
  ),
  'NavigationLegend',
)

export const PersonalToolsGrid = part(
  'div',
  cn(
    ROWS,
    '[&_h3]:col-start-2 [&_h3]:mb-1.5 [&_h3]:text-doc-h2 [&_h3]:font-bold [&_h3]:text-foreground [&_li+li]:mt-1 [&_ol]:col-start-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:text-doc-body [&_ol]:text-muted-foreground [&>article]:grid [&>article]:grid-cols-[2.75rem_minmax(0,1fr)] [&>article]:items-start [&>article]:gap-x-4',
  ),
  'PersonalToolsGrid',
)

export const ToolIcon = part(
  'span',
  'col-start-1 row-span-2 mt-0.5 grid size-9 place-items-center rounded-lg bg-primary text-ui-xs font-extrabold text-primary-foreground',
  'ToolIcon',
)

/** Labelled rows with a heading: `<article><span>LABEL</span><h3/><p/></article>`. */
export const DetailGuide = part(
  'div',
  cn(
    ROWS,
    ROW_H3,
    '[&>article>span]:text-ui-xs [&>article>span]:font-extrabold [&>article>span]:tracking-wider [&>article>span]:text-primary-light',
  ),
  'DetailGuide',
)

export const IterationChangeGrid = part(
  'div',
  cn(
    ROWS,
    ROW_H3,
    '[&>article>span]:text-ui-xs [&>article>span]:font-extrabold [&>article>span]:tracking-wider [&>article>span]:text-primary-light',
  ),
  'IterationChangeGrid',
)

export const HomeSections = part(
  'div',
  '[&_p]:mt-1 [&_p]:text-doc-body [&_p]:text-muted-foreground [&_strong]:text-doc-h3 [&_strong]:font-bold [&_strong]:text-foreground [&>article]:border-b [&>article]:border-border-subtle [&>article]:py-5',
  'HomeSections',
)

// ── Two ways to do one thing ──────────────────────────────────────────────────

export const DefectRoutes = part('div', ROWS, 'DefectRoutes')

/**
 * One way of doing it: a label, a heading, what to do, then an inline "Use when:" line. `quality`
 * colours the label as the Quality route, as the static guide did.
 */
export function RouteCard({
  quality = false,
  children,
}: {
  quality?: boolean
  children: ReactNode
}) {
  return (
    <article
      className={cn(
        ROW_H3,
        '[&>p]:mb-3 [&>p:last-child]:mb-0 [&>p:last-child]:inline [&>span]:text-ui-xs [&>span]:font-extrabold [&>span]:tracking-wider [&>strong]:mr-1 [&>strong]:inline-block [&>strong]:text-doc-body [&>strong]:font-bold [&>strong]:text-primary',
        quality ? '[&>span]:text-success' : '[&>span]:text-primary-light',
      )}
    >
      {children}
    </article>
  )
}

// ── Iteration states ──────────────────────────────────────────────────────────

export const IterationStateFlow = part('div', '', 'IterationStateFlow')

const STATE_BADGE = {
  plain: '[&>span]:bg-muted-foreground',
  planning: '[&>span]:bg-foreground-subtle',
  committed: '[&>span]:bg-primary-light',
  accepted: '[&>span]:bg-success',
} as const

export function IterationStateCard({
  state = 'plain',
  children,
}: {
  state?: keyof typeof STATE_BADGE
  children: ReactNode
}) {
  return (
    <article
      className={cn(
        'border-b border-border-subtle py-5 first:border-t [&>h3]:mt-3.5 [&>h3]:mb-1.5 [&>h3]:text-doc-h2 [&>h3]:font-bold [&>h3]:text-foreground [&>p]:text-doc-body [&>p]:text-muted-foreground [&>span]:grid [&>span]:size-8 [&>span]:place-items-center [&>span]:rounded-md [&>span]:text-ui-xs [&>span]:font-extrabold [&>span]:text-primary-foreground',
        STATE_BADGE[state],
      )}
    >
      {children}
    </article>
  )
}

// ── Outcomes ──────────────────────────────────────────────────────────────────

/**
 * What the reader should see once done (`result`), or what to send when asking for help
 * (`support`).
 */
export function ResultBox({
  tone = 'result',
  children,
}: {
  tone?: 'result' | 'support'
  children: ReactNode
}) {
  const support = tone === 'support'
  return (
    <div
      className={cn(
        'mt-4 border-l-3 py-1 pl-4 [&>p]:mt-1 [&>p]:text-doc-body [&>p]:text-muted-foreground [&>span]:block [&>span]:text-ui-xs [&>span]:font-extrabold [&>span]:tracking-wider [&>strong]:mt-1 [&>strong]:block [&>strong]:text-doc-lead [&>strong]:font-bold',
        support
          ? 'border-primary-light [&>span]:text-primary-light [&>strong]:text-primary'
          : 'border-success [&>span]:text-success [&>strong]:text-success',
      )}
    >
      {children}
    </div>
  )
}

// ── Writing templates ─────────────────────────────────────────────────────────

/** A fill-in template or a worked example: a title, then `<p><TemplateLabel/>text</p>` lines. */
export const WritingTemplate = part(
  'div',
  'my-7 border-y border-border-subtle py-5 [&_li+li]:mt-2 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-6 [&>p]:my-2 [&>p]:text-doc-body [&>p]:text-muted-foreground [&>strong]:mb-3.5 [&>strong]:block [&>strong]:text-doc-h3 [&>strong]:font-bold [&>strong]:text-foreground',
  'WritingTemplate',
)

export const TemplateLabel = part(
  'span',
  'inline-block min-w-28 pr-2 font-bold text-primary-light',
  'TemplateLabel',
)
