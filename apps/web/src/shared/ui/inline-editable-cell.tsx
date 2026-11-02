import { useState, type MouseEvent } from 'react'
import { isNewTabClick } from '@/shared/lib/new-tab-click'
import { cn } from '@/shared/lib/utils'
import { isInAppPath } from './record-link'

interface InlineEditableCellProps {
  value: string
  onCommit: (value: string) => void
  canEdit: boolean
  displayValue?: React.ReactNode
  trigger?: 'click' | 'dblclick'
  className?: string
  style?: React.CSSProperties
  inputClassName?: string
  inputStyle?: React.CSSProperties
  ariaLabel?: string
  title?: string
  /**
   * Full-cell affordance (grid parity with SearchableSelect/DateField cell
   * variant): the hover box + click target + edit input span the whole cell
   * edge-to-edge. Requires the enclosing cell wrapper to be `px-0` (the editor
   * supplies its own px-2 py-1.5). Text alignment/font stays caller-controlled
   * via className/inputStyle (e.g. right-aligned mono for numeric columns).
   */
  fullCell?: boolean
  /**
   * The record's detail URL (an in-app path), for a Name cell whose row IS a record (US-120 AC1).
   * Ctrl/Cmd/Shift+click and middle-click open it in a new tab and do NOT enter edit; a plain click
   * still edits. The cell stays a text control rather than an `<a>`, because its primary action is
   * editing — the ID cell beside it is the link. A URL that is not an in-app path is ignored.
   */
  newTabHref?: string
}

/** Baked full-cell edit-input look — mirrors the other cell editors: subtle
 * border at rest, primary border on focus (input is auto-focused on open), and
 * the same px-2 py-1.5 as the hover affordance so entering edit never shifts
 * the row. Keep in sync with SearchableSelect/DateField cell variant. */
/* Full-cell edit input: 1px border is the edit cue; the global focus ring is
 * suppressed via `outline-none` (now that the base :focus-visible rule is
 * layered, this utility wins normally — no inline-style override needed). */
/**
 * `text-inherit` is deliberate and load-bearing: the EDITOR must render at the size the cell was just
 * displaying, or clicking a value makes it jump a pixel or two and the row reflows under the pointer.
 *
 * Twelve call sites had hardcoded a size in their own `inputClassName` (`text-ui-sm`, `text-ui-xs`)
 * while the display span sat at 12px — so every one of those cells shrank on edit. They now pass
 * `text-inherit` too. Keep it that way: a caller that needs a different editor size almost certainly
 * needs a different DISPLAY size.
 */
const FULL_CELL_INPUT =
  'w-full rounded border border-input bg-white px-2 py-1.5 text-inherit outline-none'

// ponytail: editing closes as soon as commit fires (not after the caller's
// mutation resolves) — the caller still owns validation/toast/revert, this
// just avoids the input lingering through an in-flight request.
export function InlineEditableCell({
  value,
  onCommit,
  canEdit,
  displayValue,
  trigger = 'click',
  className,
  style,
  inputClassName,
  inputStyle,
  ariaLabel,
  title,
  fullCell = false,
  newTabHref,
}: InlineEditableCellProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  function startEdit() {
    if (!canEdit) return
    setDraft(value)
    setEditing(true)
  }

  function commit() {
    setEditing(false)
    onCommit(draft)
  }

  function cancel() {
    setDraft(value)
    setEditing(false)
  }

  if (editing && canEdit) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') cancel()
        }}
        aria-label={ariaLabel}
        className={fullCell ? cn(FULL_CELL_INPUT, inputClassName) : inputClassName}
        style={inputStyle}
      />
    )
  }

  const tabHref = newTabHref && isInAppPath(newTabHref) ? newTabHref : undefined

  /** True when the gesture was "open elsewhere" and has been handled — the caller must not edit. */
  function openedInNewTab(e: MouseEvent) {
    if (!tabHref || !isNewTabClick(e)) return false
    e.preventDefault()
    e.stopPropagation()
    window.open(tabHref, '_blank', 'noopener')
    return true
  }

  const triggerProps = {
    onClick: (e: MouseEvent) => {
      if (openedInNewTab(e)) return
      if (trigger === 'click') startEdit()
    },
    ...(trigger === 'dblclick' ? { onDoubleClick: startEdit } : {}),
    // Middle-click fires `auxclick`, not `click`. Its `mousedown` is prevented too, or Windows
    // starts autoscroll and swallows the gesture.
    ...(tabHref
      ? {
          onAuxClick: (e: MouseEvent) => {
            if (e.button === 1) openedInNewTab(e)
          },
          onMouseDown: (e: MouseEvent) => {
            if (e.button === 1) e.preventDefault()
          },
        }
      : {}),
  }

  // Editable cells get the shared hover affordance (outline box + text caret,
  // no layout shift); read-only cells render plain. `fullCell` adds the
  // edge-to-edge padding so the box/target fills the whole cell.
  const affordance = canEdit
    ? fullCell
      ? 'inline-edit-cell block w-full px-2 py-1.5'
      : 'inline-edit-cell'
    : fullCell
      ? 'block w-full px-2 py-1.5'
      : undefined
  const mergedClassName = cn(affordance, className) || undefined

  return (
    <span
      className={mergedClassName}
      style={{ cursor: canEdit ? 'pointer' : 'default', ...style }}
      title={title}
      {...triggerProps}
    >
      {displayValue ?? value}
    </span>
  )
}
