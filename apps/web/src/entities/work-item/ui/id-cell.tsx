import { TypeBadge } from '@/entities/work-item/ui/badges'
import type { WorkItemType } from '@/entities/work-item/model/types'
import { defaultRecordHref } from '@/entities/work-item/model/record-href'
import { RecordLink } from '@/shared/ui/record-link'

interface IdCellProps {
  /** Work-item type — drives the leading {@link TypeBadge} glyph. */
  type: WorkItemType | string
  /** Human item key (US-5 / TA-3 / DE-12 …). */
  itemKey: string
  /**
   * Opens the item detail. Fired from anywhere in the cell (row click intact).
   *
   * OMIT for a row that does not navigate — a preview/child row the spec says is read-only. The cell
   * then renders the same glyph and key at the same size, as a plain span in muted ink rather than a
   * link-blue button, so it neither looks nor focuses like something clickable. Callers used to
   * hand-roll that pair instead, which is how the preview rows ended up with a 10px key beside their
   * parents' 12px one.
   */
  onOpen?: () => void
  /**
   * The record's detail URL (an in-app path from `entityDetailPath`), so Ctrl/Cmd+click,
   * middle-click and "Open link in new tab" work (US-120). A plain click still calls `onOpen`.
   *
   * Defaults to `/item/{itemKey}` for a Story / Task / Defect, whose detail route is addressed by
   * key. Every other type (portfolio item, timebox, project, plan) is addressed by its own id or
   * key and MUST pass it — without one the cell falls back to a button that opens in place only.
   */
  href?: string
}

/**
 * `<IdCell>` — the single, reusable ID column cell shared by every work-item
 * grid (Iteration Status, Defects, Projects, …). Renders the icon-only
 * {@link TypeBadge} plus the monospace item key. The WHOLE cell (icon + key) is
 * one link, so clicking the glyph OR the key opens the item — keeps type glyph
 * + key styling in one place so the ID column can never drift between pages.
 *
 * The wrapping page supplies the column width + horizontal padding via
 * `styleFor('id')`; this component only lays out badge + key.
 */
/** Shared by both renderings, so the glyph/key pairing cannot drift between them. */
const KEY_CLASS =
  'flex min-h-5 min-w-0 items-center font-mono text-ui-md break-words whitespace-normal'

// `items-start` + no `overflow-hidden`: the key wraps, so the type glyph must stay
// on its first line and the control must be allowed to grow.
const OPEN_CLASS =
  'group flex min-w-0 cursor-pointer items-start gap-1 border-none bg-transparent p-0 text-left no-underline'

export function IdCell({ type, itemKey, onOpen, href }: IdCellProps) {
  if (onOpen === undefined) {
    return (
      <span className="inline-flex min-w-0 items-start gap-1" title={itemKey}>
        <TypeBadge type={type} />
        <span className={`${KEY_CLASS} text-muted-foreground`}>{itemKey}</span>
      </span>
    )
  }

  const content = (
    <>
      <TypeBadge type={type} />
      {/* `min-h-5` (in `KEY_CLASS`) so a one-line key sits CENTRED against the type glyph rather than
          riding its top edge, which is the same rule the team and owner cells follow. A wrapped key
          still starts level with the glyph. */}
      <span className={`${KEY_CLASS} text-primary-light underline-offset-2 group-hover:underline`}>
        {itemKey}
      </span>
    </>
  )

  const target = href ?? defaultRecordHref(type, itemKey)
  if (target) {
    return (
      <RecordLink href={target} onOpen={onOpen} title={itemKey} className={OPEN_CLASS}>
        {content}
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
      title={itemKey}
      className={OPEN_CLASS}
    >
      {content}
    </button>
  )
}
