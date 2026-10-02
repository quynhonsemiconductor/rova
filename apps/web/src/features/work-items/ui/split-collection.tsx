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
 *
 * LAYOUT (BA mockup parity, 2026-10-02): each collection is a bordered `Card` whose header carries the
 * kind and its count, over a `PanelTable` with fixed `ID | Name | <two kind columns> | move` columns.
 * Both primitives are the shared ones, so this table aligns its header and rows the same way Home's
 * panels do and adapts to dark mode through tokens. The move button sits in the LAST column on both
 * sides, as the mockup draws it; the arrow's direction says where the row goes. Below the table's
 * minimum width the card scrolls horizontally rather than squeezing the columns until they wrap.
 */
import type { ReactNode } from 'react'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { SplitSide } from '@/features/work-items/api'
import type { SplitItemKind } from '@/features/work-items/model/split-draft'
import { cn, formatNumber } from '@/shared/lib/utils'
import { Card, CardHeader } from '@/shared/ui/card'
import { IconButton } from '@/shared/ui/icon-button'
import {
  PanelTable,
  PanelTableCell,
  PanelTableRow,
  type PanelTableColumn,
} from '@/shared/ui/table/panel-table'

/** A kind-specific column: its header label and how one row fills it. */
export interface SplitCollectionColumn<T> {
  key: string
  label: string
  width: number
  render: (row: T) => ReactNode
}

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
  /** Optional second line under the name (a Defect's explicit Iteration). */
  subtitleOf?: (row: T) => ReactNode
  /** The kind's own trailing columns: State + To Do, State + Priority, Type + Verdict. */
  columns: SplitCollectionColumn<T>[]
  onMove: (id: string) => void
}

/** Fixed geometry shared by every kind — only the two kind columns differ. */
const ID_WIDTH = 84
const MOVE_WIDTH = 32
const ROW_GAP = 'gap-2'
const ROW_PAD = 'px-3'

export function SplitCollection<T extends { id: string }>({
  kind,
  side,
  label,
  rows,
  keyOf,
  titleOf,
  subtitleOf,
  columns,
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

  const idColumn: PanelTableColumn = {
    key: 'id',
    label: t('collections.columns.id'),
    width: ID_WIDTH,
  }
  const nameColumn: PanelTableColumn = { key: 'name', label: t('collections.columns.name') }
  const kindColumns: PanelTableColumn[] = columns.map(({ key, label: colLabel, width }) => ({
    key,
    label: colLabel,
    width,
  }))
  const moveColumn: PanelTableColumn = {
    key: 'move',
    label: '',
    width: MOVE_WIDTH,
    align: 'center',
  }
  const tableColumns = [idColumn, nameColumn, ...kindColumns, moveColumn]

  return (
    <Card
      ref={setNodeRef}
      className={cn(
        'transition-colors',
        isOver && 'border-accent-border-active bg-accent-bg-subtle',
      )}
    >
      <CardHeader className="px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <h4 id={headingId} className="truncate text-ui-sm font-semibold text-foreground">
            {label}
          </h4>
          <span className="rounded-full bg-border-inner px-2 text-ui-xs font-semibold text-foreground-subtle">
            {/*
              Through `formatNumber` for the same reason the footer's counts are (SU-02 review): on a
              locale whose numbering system is not Latin, a raw count would print in one digit system
              while the hours on the rows below printed in another.
            */}
            {formatNumber(rows.length)}
          </span>
        </div>
      </CardHeader>
      <div className="overflow-x-auto">
        <PanelTable
          columns={tableColumns}
          gapClassName={ROW_GAP}
          padClassName={ROW_PAD}
          className="min-w-[440px]"
        >
          {/*
            `role="list"` named by the visible heading, so a test (and a screen reader) can address
            "the Tasks list in this panel" without a second region competing with the panel's own.
          */}
          <div role="list" aria-labelledby={headingId}>
            {rows.length === 0 ? (
              // AC5 — an empty side is a legal split. This is a DROP TARGET's empty state, not a
              // validation message: it blocks nothing and says nothing about correctness.
              <div
                role="listitem"
                className="flex h-14 items-center justify-center px-3 text-ui-sm font-semibold text-foreground-subtle"
              >
                {t('collections.empty', { kind: label })}
              </div>
            ) : (
              rows.map((row) => (
                <SplitRow
                  key={row.id}
                  kind={kind}
                  side={side}
                  id={row.id}
                  idColumn={idColumn}
                  nameColumn={nameColumn}
                  moveColumn={moveColumn}
                  itemKey={keyOf(row)}
                  title={titleOf(row)}
                  subtitle={subtitleOf?.(row)}
                  cells={columns.map((col, index) => (
                    <PanelTableCell
                      key={col.key}
                      column={kindColumns[index]}
                      className="min-w-0 overflow-hidden"
                    >
                      {col.render(row)}
                    </PanelTableCell>
                  ))}
                  moveLabel={t('collections.move', { key: keyOf(row), destination })}
                  onMove={() => onMove(row.id)}
                />
              ))
            )}
          </div>
        </PanelTable>
      </div>
    </Card>
  )
}

function SplitRow({
  kind,
  side,
  id,
  idColumn,
  nameColumn,
  moveColumn,
  itemKey,
  title,
  subtitle,
  cells,
  moveLabel,
  onMove,
}: {
  kind: SplitItemKind
  side: SplitSide
  id: string
  idColumn: PanelTableColumn
  nameColumn: PanelTableColumn
  moveColumn: PanelTableColumn
  itemKey: string
  title: string
  subtitle: ReactNode
  cells: ReactNode
  moveLabel: string
  onMove: () => void
}) {
  // `attributes` is deliberately not destructured — see the module docblock.
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: `${kind}:${id}`,
    data: { kind, side, id },
  })

  return (
    <PanelTableRow
      ref={setNodeRef}
      role="listitem"
      {...listeners}
      gapClassName={ROW_GAP}
      padClassName={ROW_PAD}
      className={cn(
        'group cursor-grab bg-card last:border-b-0 active:cursor-grabbing',
        isDragging && 'opacity-50',
      )}
    >
      <PanelTableCell column={idColumn}>
        <span className="font-mono text-ui-xs font-semibold text-primary">{itemKey}</span>
      </PanelTableCell>
      <PanelTableCell column={nameColumn} className="flex-col items-start py-1.5">
        <span className="block w-full truncate text-ui-sm text-foreground" title={title}>
          {title}
        </span>
        {subtitle}
      </PanelTableCell>
      {cells}
      <PanelTableCell column={moveColumn}>
        {/* The arrow points OUT of this side: left panel → right, right panel → left. */}
        <IconButton
          size="sm"
          aria-label={moveLabel}
          onClick={onMove}
          className="text-primary opacity-70 group-hover:opacity-100 focus-visible:opacity-100"
        >
          {side === 'unfinished' ? <ArrowRight size={12} /> : <ArrowLeft size={12} />}
        </IconButton>
      </PanelTableCell>
    </PanelTableRow>
  )
}
