import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'
import { RecordLink } from '@/shared/ui/record-link'

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
  className,
  wrap = false,
  children,
}: {
  onClick: () => void
  href?: string
  title?: string
  className?: string
  /** When true the text wraps across lines (`break-words`) instead of the
   *  default single-line `truncate`. Used by Name columns that wrap. */
  wrap?: boolean
  children: ReactNode
}) {
  const classes = cn(
    'block text-left text-primary-light underline-offset-2 hover:underline',
    wrap ? 'break-words whitespace-normal' : 'truncate',
    className,
  )

  if (href) {
    return (
      <RecordLink href={href} onOpen={onClick} title={title} className={classes}>
        {children}
      </RecordLink>
    )
  }

  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={classes}
    >
      {children}
    </button>
  )
}
