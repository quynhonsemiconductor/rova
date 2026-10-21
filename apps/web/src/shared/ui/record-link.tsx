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
 *
 * MODULE-PRIVATE on purpose: {@link RecordOpener} is the only way to render one, so its
 * {@link isInAppPath} check cannot be bypassed by a direct call with an untrusted URL.
 */
function RecordLink({
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
 * The reset every record opener starts from, so a `<a>` and its `<button>` fallback render the same
 * and the ID / reference cells cannot drift: no border, background or padding, no underline until
 * hovered (`group-hover` on the label), left-aligned text, a pointer cursor. Cells add only their
 * own layout (flex vs inline-flex, gap, width). `TestCaseIdCell` deliberately uses the Button link
 * variant instead.
 */
export const RECORD_OPENER_RESET =
  'group cursor-pointer border-none bg-transparent p-0 text-left no-underline'

/**
 * Whether `href` is an in-app path (`/item/US-5`), the only thing a record link may carry. A
 * `javascript:` URL, another scheme, or a protocol-relative `//host` is refused: the components below
 * are the one place every ID and reference cell renders its URL, so this is where that contract is
 * enforced rather than merely documented.
 */
export function isInAppPath(href: string): boolean {
  // Refused outright, before any prefix check: the URL parser DELETES tab, LF and CR, so `/\n//host`
  // passes `!startsWith('//')` here and still resolves to `//host`. No route path contains them.
  if (/[\t\n\r]/.test(href)) return false
  // `/\` too: browsers read a backslash as a slash, so `/\host` is protocol-relative as well.
  return href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/\\')
}

/**
 * RecordOpener — `RecordLink` when the record's URL is known, otherwise a `<button>` that opens it
 * in place only. The ONE copy of that fallback, so the ID and reference cells cannot drift on it
 * (the button stops propagation for the same reason the link does).
 *
 * A URL that is not an in-app path ({@link isInAppPath}) is treated as no URL: the cell still opens
 * in place, and nothing a caller passes can become a `javascript:` link.
 *
 * The element is a `<a>` or a `<button>` depending on `href`, so a cell whose URL appeared only
 * AFTER mount would remount (dropping focus) and change role. Every cell computes its URL from the
 * props it renders with, in the same render, so for a row that arrives with its data the element is
 * decided on the first one. The one exception the rule itself allows: a work-item row rendered
 * before it HAS a key gets no URL (`defaultRecordHref`), and would flip `<button>` → `<a>` when the
 * key arrives. No surface renders such a row today; a new one that does accepts that remount.
 * Do not pass a URL that resolves asynchronously otherwise.
 */
export function RecordOpener({
  href,
  onOpen,
  title,
  className,
  ariaLabel,
  children,
}: {
  href: string | undefined
  onOpen: () => void
  title?: string
  className?: string
  ariaLabel?: string
  children: ReactNode
}) {
  if (href && isInAppPath(href)) {
    return (
      <RecordLink
        href={href}
        onOpen={onOpen}
        title={title}
        className={className}
        ariaLabel={ariaLabel}
      >
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
      // Middle-click fires `auxclick`, not `click` — stopped here too, exactly as the link does.
      onAuxClick={(e) => e.stopPropagation()}
      title={title}
      aria-label={ariaLabel}
      className={className}
    >
      {children}
    </button>
  )
}
