import type { ReactNode } from 'react'
import { isNewTabClick } from '@/shared/lib/new-tab-click'

/**
 * RecordLink — a real `<a href>` to a record's detail page that still lets the caller decide what
 * a PLAIN click does (US-120).
 *
 * - Plain left click → `preventDefault()` + `onOpen()`. The caller keeps its in-app behaviour: a
 *   router navigation, the Backlog's summary panel, a drawer.
 * - Ctrl/Cmd/Shift/Alt/middle click and the context menu's "Open link in new tab" → the browser's
 *   native handling of `href`, because nothing is prevented.
 *
 * `href` is an in-app PATH (`entityDetailPath.*`), so the new tab boots the SPA at the record
 * exactly as a pasted link does — the deep-link loaders already adopt the record's own project.
 *
 * Every click and middle-click stops propagation, so a row that also listens (select, open a
 * summary) does not ALSO react to a gesture aimed at the link.
 */
export function RecordLink({
  href,
  onOpen,
  title,
  className,
  ariaLabel,
  children,
}: {
  href: string
  onOpen: () => void
  title?: string
  className?: string
  ariaLabel?: string
  children: ReactNode
}) {
  return (
    <a
      href={href}
      title={title}
      aria-label={ariaLabel}
      className={className}
      // A link is draggable by default, which would fight the row's rank drag handle.
      draggable={false}
      onClick={(e) => {
        e.stopPropagation()
        if (isNewTabClick(e)) return
        e.preventDefault()
        onOpen()
      }}
      onAuxClick={(e) => e.stopPropagation()}
    >
      {children}
    </a>
  )
}

/**
 * RecordOpener — `RecordLink` when the record's URL is known, otherwise a `<button>` that opens it
 * in place only. The ONE copy of that fallback, so the ID and reference cells cannot drift on it
 * (the button stops propagation for the same reason the link does).
 */
export function RecordOpener({
  href,
  onOpen,
  title,
  className,
  children,
}: {
  href: string | undefined
  onOpen: () => void
  title?: string
  className?: string
  children: ReactNode
}) {
  if (href) {
    return (
      <RecordLink href={href} onOpen={onOpen} title={title} className={className}>
        {children}
      </RecordLink>
    )
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onOpen()
      }}
      title={title}
      className={className}
    >
      {children}
    </button>
  )
}
