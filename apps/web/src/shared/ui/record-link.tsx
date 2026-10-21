import { useEffect, type ReactNode } from 'react'
import { isNewTabClick } from '@/shared/lib/new-tab-click'
import { reportOnce } from '@/shared/lib/report-once'
import { cn } from '@/shared/lib/utils'

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
 * Every `click` and `auxclick` (middle-click) stops propagation, so a row that listens for CLICKS
 * (select, open a summary) does not also react to a gesture aimed at the link. `mousedown` /
 * `pointerdown` are NOT stopped: no row wraps a record link in a press handler today — the drag
 * listeners (`useRowRerank`, the Iteration Board, capacity rows) sit on a separate grip beside the
 * link, never around it. A row that starts something on press must stop it here too.
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
 * The reset every record opener starts from: no border, background or padding, no underline until
 * hovered (`group-hover/record` on the label, hence the NAMED `group/record`), left-aligned text, a pointer cursor. Applied
 * by `RecordOpener` ITSELF to both the `<a>` and the `<button>` fallback, so the two cannot drift
 * and no cell can forget it; a caller's `className` comes after it and wins any conflict
 * (tailwind-merge), which is how `TestCaseIdCell` keeps the Button link look.
 */
const RECORD_OPENER_RESET =
  'group/record cursor-pointer border-none bg-transparent p-0 text-left no-underline'

/**
 * The link treatment for the LABEL inside an opener: link colour, underline only on hover of the
 * opener itself. A NAMED group (`group/record`): a bare `group-hover:` matches ANY ancestor `group`,
 * and most grid rows carry one, so every ID in a row underlined when the row was hovered. One constant, so the ID and
 * reference cells cannot drift when the link look next changes.
 */
export const RECORD_LINK_LABEL =
  'text-primary-light underline-offset-2 group-hover/record:underline'

/**
 * The label's LAYOUT inside an ID / reference cell: one line centred against the type glyph
 * (`min-h-5`), wrapping when long. Each cell adds only its type scale (mono key vs body text).
 */
export const RECORD_LABEL_LAYOUT = 'flex min-h-5 min-w-0 items-center break-words whitespace-normal'

/**
 * Whether `href` is an in-app path (`/item/US-5`), the only thing a record link may carry. A
 * `javascript:` URL, another scheme, or a protocol-relative `//host` is refused: the components below
 * are the one place every ID and reference cell renders its URL, so this is where that contract is
 * enforced rather than merely documented.
 */
export function isInAppPath(href: string): boolean {
  return hrefRefusal(href) === undefined
}

/**
 * Why `href` is NOT an in-app path, or `undefined` when it is. The ONE classifier: `isInAppPath`
 * and the refusal report both read it, so a new refusal rule cannot leave the report mislabelling
 * (and so de-duplicating) two different defects under one reason.
 */
function hrefRefusal(href: string): string | undefined {
  // Refused outright, before any prefix check: the URL parser DELETES tab, LF and CR, so `/\n//host`
  // passes `!startsWith('//')` here and still resolves to `//host`. No route path contains them.
  if (/[\t\n\r]/.test(href)) return 'control-character'
  // `/\` too: browsers read a backslash as a slash, so `/\host` is protocol-relative as well.
  if (href.startsWith('//') || href.startsWith('/\\')) return 'protocol-relative'
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)
  if (scheme) return `scheme:${scheme[1].toLowerCase()}`
  if (!href.startsWith('/')) return 'not-a-path'
  return undefined
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
 * key arrives. No surface renders such a row today — checked: every work-item cache write stores the
 * server's reply, key included (`setQueryData` in `onSuccess`; there is no `onMutate` insert), and
 * `useRowRerank` only reorders rows the server returned. A new one that does accepts that remount. (The
 * empty-key branch of `defaultRecordHref` points back here.)
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
  const classes = cn(RECORD_OPENER_RESET, className)
  // Decided ONCE: the warning and the branch below cannot disagree about the same URL.
  const linkHref = href && isInAppPath(href) ? href : undefined
  // In an effect, not during render (render stays pure; StrictMode would double it). Safe either
  // way — it opens in place — but a path builder returning a full URL or junk would otherwise
  // disable new-tab links silently, everywhere: reported once per KIND of bad URL for the session.
  useEffect(() => {
    if (href && !linkHref) {
      // The URL's SHAPE and length only, never its content: this branch exists because a caller
      // passed something unexpected, which could carry user text, an email or a token — a log line
      // must not become a copy of it. The shape already names the defect.
      const shape = hrefRefusal(href) ?? 'unknown'
      reportOnce(
        `record-link:refused:${shape}`,
        `RecordOpener: refused a URL that is not an in-app path (${shape}, ${href.length} chars), opening in place`,
      )
    }
  }, [href, linkHref])
  if (linkHref) {
    return (
      <RecordLink
        href={linkHref}
        onOpen={onOpen}
        title={title}
        className={classes}
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
      className={classes}
    >
      {children}
    </button>
  )
}
