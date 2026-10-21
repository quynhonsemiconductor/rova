import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'

/**
 * Wraps free text inside a table cell WITHOUT letting it size the row.
 *
 * Grid rows across the app are `minWidth: max-content`, so a cell's max-content width becomes a
 * floor on the row. For a `grow` column of wrapping free text — which by design has no width
 * ceiling — that floor is the whole text on ONE line: the row widens to fit it, the text never
 * wraps, and the cell grows past its header so every column after it is pushed off to the right
 * (Production, 2026-10-06, the US-120 Changesets tab).
 *
 * `w-0` makes the content contribute nothing to that max-content measurement; `min-w-full` then
 * stretches it back to the cell's real width once the row is laid out, so it wraps inside the column
 * exactly as wide as its header. Use it for any `grow` column whose cell WRAPS (a `truncate` cell
 * clips instead and does not need it). Guarded end to end by `backlog.e2e.ts` (Connections tab).
 */
export function WrapBox({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('w-0 min-w-full', className)}>{children}</div>
}
