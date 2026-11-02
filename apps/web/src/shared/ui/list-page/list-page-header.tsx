/**
 * ListPageHeader — the title bar at the top of a {@link ListPageScaffold},
 * mirroring Broadcom's Rally screen header: a bold page title, an optional
 * context selector beside it (e.g. the Timeboxes TYPE dropdown / iteration
 * picker), and optional right-aligned controls (view toggle, saved views).
 */
import type { ReactNode } from 'react'

export function ListPageHeader({
  title,
  accessory,
  right,
}: {
  title: ReactNode
  /** Control rendered next to the title (e.g. a TYPE / context dropdown). */
  accessory?: ReactNode
  /** Right-aligned controls (e.g. a List/Board toggle). */
  right?: ReactNode
}) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border-subtle bg-card px-4 py-2.5">
      <h1 className="shrink-0 text-ui-xl font-bold text-foreground">{title}</h1>
      {accessory}
      {right != null && <div className="ml-auto flex items-center gap-2">{right}</div>}
    </div>
  )
}
