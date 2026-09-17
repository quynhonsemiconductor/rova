/**
 * SplitCollection — one side's list of one child kind (SU-03 3.1, reused by SU-04 and SU-05).
 *
 * ONE component for Tasks, Defects and Test Cases. The three differ only in which trailing facts a
 * row shows, so they differ by a `meta` render prop and nothing else; written three times they would
 * drift three ways, and the drop behaviour — the part that can actually be wrong — would be
 * implemented three times.
 *
 * TWO WAYS TO MOVE AN ITEM, and the button is the accessible one.
 *   • Pointer: `@dnd-kit/core` — the house library (§8 Q17), never the mockup's hand-rolled
 *     `onDragStart`/`dataTransfer`. `useRerankSensors()` (in the modal, which owns the `DndContext`)
 *     supplies the sensor set, including its 4px pointer activation constraint — which is what keeps
 *     a CLICK on the arrow button from being read as the start of a drag.
 *   • Keyboard and screen reader: the per-row arrow `IconButton`, labelled
 *     `Move {key} to {[Unfinished]|[Continued]}`. This is the equivalent the plan's accessibility
 *     section requires — a drag-only distribution is unusable — and it is the primary path, not a
 *     fallback.
 *
 * **`useDraggable`'s `attributes` are deliberately NOT spread onto the row.** They include
 * `role="button"`, `tabIndex={0}` and `aria-roledescription="draggable"`, which would advertise a
 * keyboard drag on every row. Cross-CONTAINER keyboard dragging is not what
 * `sortableKeyboardCoordinates` computes (it answers "which sibling do I swap with" inside one
 * sortable list), so those attributes would promise a gesture that does nothing — an affordance that
 * lies, the same fault the read-only fields avoid one file over. The arrow button is the keyboard
 * gesture; the row carries only the pointer `listeners`.
 *
 * The count pill is PER SIDE (this collection's own length). The modal footer's counts are
 * whole-story totals — two different questions, deliberately not the same number.
 */
import type { ReactNode } from 'react'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { SplitSide } from '@/features/work-items/api'
import type { SplitItemKind } from '@/features/work-items/model/split-draft'
import { cn, formatNumber } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/icon-button'

interface SplitCollectionProps<T extends { id: string }> {
  kind: SplitItemKind
  side: SplitSide
  /** Section heading — already translated, and it names the KIND, not the side. */
  label: string
  /** Only the rows on THIS side. Order comes from the preview's array (see `rowsOnSide`). */
  rows: T[]
  /** The item key a human quotes: `TA-1`, `DE-1`, `TC-1`. */
  keyOf: (row: T) => string
  /** `title` for a Task or Defect, `name` for a Test Case — §3.1's field ruling, per entity. */
  titleOf: (row: T) => string
  /** The trailing facts for this kind: state + To Do, priority, verdict… */
  meta?: (row: T) => ReactNode
  onMove: (id: string) => void
}

export function SplitCollection<T extends { id: string }>({
  kind,
  side,
  label,
  rows,
  keyOf,
  titleOf,
  meta,
  onMove,
}: SplitCollectionProps<T>) {
  const { t } = useTranslation('split-story')
  /**
   * The droppable. `data` carries both halves so `SplitStoryModal`'s `onDragEnd` can refuse a drop
   * whose KINDS differ — which is how a Task cannot land in the Test Cases list — without parsing
   * the id string.
   */
  const { setNodeRef, isOver } = useDroppable({ id: `${kind}:${side}`, data: { kind, side } })

  // Where the arrow sends a row: the OTHER side. Named, because it is what the label must say.
  const destination =
    side === 'unfinished'
      ? t('collections.destinationContinued')
      : t('collections.destinationUnfinished')
  const headingId = `split-${kind}-${side}-label`

  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <h4
          id={headingId}
          className="text-ui-xs font-semibold tracking-wide text-foreground-subtle uppercase"
        >
          {label}
        </h4>
        <span className="rounded-full bg-surface-hover px-1.5 text-ui-xs text-foreground-subtle">
          {/*
            Through `formatNumber` for the same reason the footer's counts are (SU-02 review): on a
            locale whose numbering system is not Latin, a raw count would print in one digit system
            while the hours on the rows below printed in another. That divergence is visible at `2`,
            not only past a thousand.
          */}
          {formatNumber(rows.length)}
        </span>
      </div>
      {/*
        `aria-labelledby` rather than a nested landmark: the list takes its name from the visible
        heading, so a test (and a screen reader) can address "the Tasks list in this panel" without a
        second region competing with the panel's own.
      */}
      <ul
        ref={setNodeRef}
        aria-labelledby={headingId}
        className={cn(
          'space-y-1 rounded border border-dashed p-1',
          isOver ? 'border-accent-border-active bg-accent-bg-subtle' : 'border-border-subtle',
        )}
      >
        {rows.length === 0 ? (
          // AC5 — an empty side is a legal split. This is a DROP TARGET's empty state, not a
          // validation message: it blocks nothing and says nothing about correctness.
          <li className="px-1 py-2 text-ui-xs text-foreground-subtle">{t('collections.empty')}</li>
        ) : (
          rows.map((row) => (
            <SplitRow
              key={row.id}
              kind={kind}
              side={side}
              id={row.id}
              itemKey={keyOf(row)}
              title={titleOf(row)}
              meta={meta?.(row)}
              moveLabel={t('collections.move', { key: keyOf(row), destination })}
              onMove={() => onMove(row.id)}
            />
          ))
        )}
      </ul>
    </div>
  )
}

function SplitRow({
  kind,
  side,
  id,
  itemKey,
  title,
  meta,
  moveLabel,
  onMove,
}: {
  kind: SplitItemKind
  side: SplitSide
  id: string
  itemKey: string
  title: string
  meta: ReactNode
  moveLabel: string
  onMove: () => void
}) {
  // `attributes` is deliberately not destructured — see the module docblock.
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: `${kind}:${id}`,
    data: { kind, side, id },
  })

  return (
    <li
      ref={setNodeRef}
      {...listeners}
      className={cn(
        'flex items-center gap-2 rounded border border-border-subtle bg-card px-2 py-1',
        isDragging && 'opacity-50',
      )}
    >
      {/* The arrow points OUT of this side: left panel → right, right panel → left. */}
      {side === 'continued' && (
        <IconButton size="sm" aria-label={moveLabel} onClick={onMove}>
          <ArrowLeft size={12} />
        </IconButton>
      )}
      <span className="font-mono text-ui-xs text-foreground-subtle">{itemKey}</span>
      <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground">{title}</span>
      {meta}
      {side === 'unfinished' && (
        <IconButton size="sm" aria-label={moveLabel} onClick={onMove}>
          <ArrowRight size={12} />
        </IconButton>
      )}
    </li>
  )
}
