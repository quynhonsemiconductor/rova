import type { MouseEvent } from 'react'

/**
 * Whether a click is the browser's own "open this link elsewhere" gesture.
 *
 * Ctrl+click / Cmd+click open a new tab, Shift+click a new window, Alt+click downloads, and any
 * non-primary button (middle-click) opens a new tab. A handler that `preventDefault`s those would
 * swallow the gesture — which is exactly what US-120 reported: every ID and reference cell was a
 * `<button>` calling `navigate()`, so there was no URL for the browser to open anywhere else.
 */
export function isNewTabClick(
  e: Pick<MouseEvent, 'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
): boolean {
  return e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey
}
