import { createElement, type ComponentPropsWithoutRef, type ElementType } from 'react'
import { cn } from '@/shared/lib/utils'

/**
 * One styled block of the guide's layout, standing in for one class of the static guide's
 * `styles.css`.
 *
 * The static guide styled its blocks by DESCENDANT selectors (`.definition-grid strong`,
 * `.scenario-flow li > span`), so its chapters are plain semantic HTML inside a handful of classed
 * containers. A part keeps that shape: the container carries the styling — as Tailwind descendant
 * variants (`[&_strong]:…`) over the design tokens — and a chapter file keeps writing `<article>`,
 * `<strong>` and `<p>` inside it. That is what lets a chapter read like the document it is, and what
 * lets the BA's HTML convert into it mechanically.
 */
export function part<T extends ElementType>(tag: T, className: string, displayName: string) {
  function Part({ className: extra, ...rest }: ComponentPropsWithoutRef<T>) {
    return createElement(tag, { className: cn(className, extra), ...rest })
  }
  Part.displayName = displayName
  return Part
}
