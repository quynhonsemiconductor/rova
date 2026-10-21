import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'
import { RecordOpener } from '@/shared/ui/record-link'

/**
 * CellLink — the shared link affordance for table/list cells whose text opens a
 * detail (milestone/release name, iteration key, …). One component so every
 * "click this text to navigate" cell reads the same (primary-light + hover
 * underline) and so grids stay link-only: the row itself never navigates, only
 * this link does. Stops propagation so it works inside rows that still carry
 * other handlers.
 *
 * Pass `href` (the record's detail path) so the link also opens in a new tab on
 * Ctrl/Cmd+click or middle-click (US-120).
 */
export function CellLink({
  onClick,
  href,
  title,
  ariaLabel,
  className,
  wrap = false,
  children,
}: {
  onClick: () => void
  href?: string
  title?: string
  /** The accessible name, kept the same whether the cell renders as a link or a button. */
  ariaLabel?: string
  className?: string
  /** When true the text wraps across lines (`break-words`) instead of the
   *  default single-line `truncate`. Used by Name columns that wrap. */
  wrap?: boolean
  children: ReactNode
}) {
  // Not `RECORD_LINK_LABEL`: its `group-hover/record:underline` is a DESCENDANT selector — it can
  // only underline a child of the `group/record` opener, and here the opener IS the text, so the
  // underline must be its own `hover:`.
  const classes = cn(
    'block text-left text-primary-light underline-offset-2 hover:underline',
    wrap ? 'break-words whitespace-normal' : 'truncate',
    className,
  )

  return (
    <RecordOpener
      href={href}
      onOpen={onClick}
      title={title}
      ariaLabel={ariaLabel}
      className={classes}
    >
      {children}
    </RecordOpener>
  )
}
