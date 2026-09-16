/**
 * BulkActionBar — the strip that appears above a table when ≥1 row is selected.
 *
 * Rally-parity chrome: a left cluster with "N Item(s) Selected" and a
 * "Deselect All" link, then the page's action controls. Each page passes its
 * own actions (edit, delete, copy, assign, set-state, …) as `children`, so the
 * bar stays DRY while remaining flexible per surface.
 *
 * Usage:
 *   {selection.count > 0 && (
 *     <BulkActionBar selectedCount={selection.count} onClear={selection.clear} error={err}>
 *       <BulkBarButton icon={<Trash2/>} label="Delete" onClick={…} />
 *       <BulkBarButton icon={<Copy/>} label="Copy" disabled={selection.count > 1} onClick={…} />
 *     </BulkActionBar>
 *   )}
 */
import { BRAND } from '@/shared/config/brand'
import type { ReactNode } from 'react'

import { cn } from '@/shared/lib/utils'

interface BulkActionBarProps {
  selectedCount: number
  onClear: () => void
  /** Inline error surfaced by a failed bulk action. */
  error?: string | null
  /** Page-specific action controls. */
  children?: ReactNode
}

/**
 * One action button for the bulk bar.
 *
 * Six pages hand-rolled the identical element — `flex items-center gap-1 rounded px-2 py-1 text-ui-sm
 * font-medium … hover:bg-card disabled:opacity-50` — and they had already drifted: only some carried
 * `transition-colors`, and the destructive colour was repeated per call site. Every one of them was
 * also a raw `<button>` in a consumer layer, which the FE ratchet counts.
 *
 * `destructive` is the only variant, because a bulk bar has exactly two kinds of action: the one that
 * removes things and the ones that do not.
 */
export function BulkActionButton({
  label,
  icon,
  onClick,
  disabled,
  destructive,
  title,
}: {
  label: string
  icon?: ReactNode
  onClick: () => void
  disabled?: boolean
  /** Why the action is unavailable — shown on hover, since a disabled button cannot explain itself. */
  title?: string
  destructive?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'flex items-center gap-1 rounded px-2 py-1 text-ui-sm font-medium transition-colors hover:bg-card disabled:opacity-50',
        destructive ? 'text-destructive' : 'text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  )
}

export function BulkActionBar({ selectedCount, onClear, error, children }: BulkActionBarProps) {
  return (
    <div
      className="flex shrink-0 items-center gap-4 px-4 py-1.5"
      style={{
        backgroundColor: BRAND.primaryLighter,
        borderBottom: `1px solid ${BRAND.accentBorder}`,
      }}
    >
      {/* Rally-style count + Deselect All */}
      <div className="flex flex-col leading-tight">
        <span className="text-ui-sm font-semibold text-primary-light">
          {selectedCount} {selectedCount === 1 ? 'Item' : 'Items'} Selected
        </span>
        <button
          onClick={onClear}
          className="text-left text-ui-xs text-primary-light hover:underline"
          aria-label="Deselect all"
        >
          Deselect All
        </button>
      </div>

      {children}

      {error && <span className="text-ui-sm text-destructive">{error}</span>}

      <div className="flex-1" />
    </div>
  )
}

/**
 * A single Rally-style bulk action (icon + label). Renders disabled/greyed when
 * `disabled` (e.g. Copy is disabled once more than one row is selected).
 */
export function BulkBarButton({
  icon,
  label,
  onClick,
  disabled = false,
  danger = false,
  title,
}: {
  icon?: ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  /**
   * Why the action is unavailable — shown on hover, since a disabled button cannot explain itself.
   *
   * Added here rather than by reaching for `BulkActionButton` (which already had it): two button
   * families in one bar is the visual inconsistency `fe-consistency` exists to prevent, and the bar
   * this renders in is already all-`BulkBarButton`. Optional, so no existing call site changes.
   */
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex items-center gap-1 rounded px-2 py-1 text-ui-sm font-medium transition-colors hover:bg-card disabled:cursor-not-allowed disabled:opacity-40 ${
        danger ? 'text-destructive' : 'text-primary-light'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}
