/**
 * One draggable, selectable, inline-editable row on the Test Cases tab (F3, Select All parity
 * with Tasks tab, and inline edit on Name/Type/Method/Priority/Owner — the columns that have a
 * natural cell-scale equivalent). Mirrors Tasks tab's own `TaskRow` in shape: `useSortable` lives
 * here (only the component that calls it can own the activator ref), the leading `<RowGutter>`
 * renders the grip THEN the checkbox in that fixed order, and cells are hand-rendered rather than
 * going through `useDataTable().renderCells` — a `ColumnSpec.cell` is a plain function and cannot
 * call the per-row `useTeamOwnerOptions` hook Owner's picker needs (CLAUDE.md: "An OFFER feed is
 * scoped by the ROW's Team").
 *
 * Name uses the same free-text `InlineEditableCell` Tasks tab's own Name column uses.
 *
 * Rank, ID, Last Verdict and Last Run stay read-only here: Rank is derived position, ID opens the
 * record, and Last Verdict/Last Run are trigger-maintained (BR9/BR10) — none has a natural
 * cell-scale edit control the way an enum or a picker does.
 *
 * `useRerankSensors()` (pointer + KEYBOARD) is the sensor set the PARENT `<DndContext>` supplies —
 * a sensor alone would not be enough: dnd-kit's `KeyboardSensor` activates from the ACTIVATOR's own
 * `onKeyDown`, which only fires if `attributes` (role="button", tabIndex) are on the FOCUSABLE grip,
 * never on the row (CLAUDE.md — this exact mistake shipped on four other grids before being fixed
 * once, centrally, in `DragHandle`/`useRerankSensors`).
 */
import type { CSSProperties } from 'react'
import { useSortable } from '@dnd-kit/sortable'

import {
  METHOD_LABEL,
  PRIORITY_LABEL,
  type TestCaseColKey,
} from '@/features/test-cases/model/test-case-columns'
import { useUpdateTestCase, type TestCase } from '@/features/test-cases/api'
import { useTeamOwnerOptions } from '@/features/teams/api'
import { listResource } from '@/shared/lib/query/resource'
import { RowGutter } from '@/shared/ui/row-gutter'
import { OwnerSelectCell } from '@/shared/ui/owner-cell'
import { SearchableSelect } from '@/shared/ui/searchable-select'
import { InlineEditableCell } from '@/shared/ui/inline-editable-cell'
import { TableRow, useDragRowStyle } from '@/shared/ui/table'
import { TestCaseIdCell } from '@/features/test-cases/ui/test-case-id-cell'
import { VerdictBadge } from '@/features/test-cases/ui/verdict-badge'

const METHOD_OPTIONS = Object.entries(METHOD_LABEL).map(([value, label]) => ({ value, label }))
const PRIORITY_OPTIONS = Object.entries(PRIORITY_LABEL).map(([value, label]) => ({ value, label }))

export function TestCaseRow({
  testCase,
  rowNum,
  canEdit,
  dragDisabled,
  colStyles,
  typeOptions,
  selected,
  onToggleSelect,
  onOpen,
}: {
  testCase: TestCase
  rowNum: number
  canEdit: boolean
  dragDisabled: boolean
  colStyles: Record<TestCaseColKey, CSSProperties>
  /** The project's live Type catalog (BR2), unioned with the row's OWN value below (BR17) —
   *  fetched once for the whole tab, since Type is a project-wide catalog, not per-team. */
  typeOptions: { value: string; label: string }[]
  selected: boolean
  onToggleSelect: () => void
  onOpen: (testCase: TestCase) => void
}) {
  const update = useUpdateTestCase(testCase.id)
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: testCase.id, disabled: dragDisabled })
  const style = useDragRowStyle({ transform, transition, isDragging })

  /**
   * Owner OPTIONS come from THIS row's Team (BR8, matching the Detail page's own
   * `ownerOptionsFor` and Tasks tab's per-row `useTeamOwnerOptions`) — a Test Case's team is
   * read-only here (BR5) but still narrows who may be Owner, so the picker must ask per row
   * rather than once for the whole tab.
   */
  const ownerOptionsQuery = useTeamOwnerOptions(testCase.projectId, testCase.teamId)
  const ownerOptions = listResource(ownerOptionsQuery).rows

  const commitName = (raw: string) => {
    const next = raw.trim()
    if (next && next !== testCase.name) update.mutate({ name: next })
  }

  return (
    <TableRow ref={setNodeRef} style={style} className="px-3 text-ui-md">
      <RowGutter
        ref={setActivatorNodeRef}
        dragListeners={dragDisabled ? undefined : listeners}
        dragAttributes={dragDisabled ? undefined : attributes}
        dragDisabled={dragDisabled}
        stopPropagation
        checkbox={{
          checked: selected,
          onChange: onToggleSelect,
          ariaLabel: `Select test case ${testCase.testCaseKey}`,
        }}
      />
      <div
        style={colStyles.rank}
        className="shrink-0 px-2 text-right font-mono text-ui-xs text-muted-foreground tabular-nums"
      >
        {rowNum}
      </div>
      <div style={colStyles.id} className="flex shrink-0 items-center overflow-hidden px-2">
        <TestCaseIdCell testCaseKey={testCase.testCaseKey} onOpen={() => onOpen(testCase)} />
      </div>
      <div style={colStyles.name} className="min-w-0 flex-1 px-2">
        <InlineEditableCell
          value={testCase.name}
          canEdit={canEdit && !update.isPending}
          onCommit={commitName}
          className="block cursor-text text-ui-md font-medium break-words whitespace-normal text-foreground"
          inputClassName="w-full rounded border border-accent-border-strong px-1 py-0.5 text-ui-md text-foreground focus:outline-none"
          title={testCase.name}
          ariaLabel={`Test case ${testCase.testCaseKey} name`}
        />
      </div>
      <div style={colStyles.type} className="flex shrink-0 items-center overflow-hidden px-2">
        <div onClick={(e) => e.stopPropagation()} className="w-full">
          <SearchableSelect
            value={testCase.type}
            readOnly={!canEdit || update.isPending}
            ariaLabel={`Test case ${testCase.testCaseKey} type`}
            // BR17: unions the row's OWN Type with the live selectable list, so a historical value
            // surviving its own removal still renders and is still selectable back to itself —
            // same rule the Detail page's own Type select follows.
            options={
              typeOptions.some((o) => o.value === testCase.type)
                ? typeOptions
                : [...typeOptions, { value: testCase.type, label: testCase.type }]
            }
            onChange={(v) => v !== testCase.type && update.mutate({ type: v })}
          />
        </div>
      </div>
      <div style={colStyles.method} className="flex shrink-0 items-center overflow-hidden px-2">
        <div onClick={(e) => e.stopPropagation()} className="w-full">
          <SearchableSelect
            value={testCase.method}
            readOnly={!canEdit || update.isPending}
            ariaLabel={`Test case ${testCase.testCaseKey} method`}
            options={METHOD_OPTIONS}
            onChange={(v) =>
              v !== testCase.method && update.mutate({ method: v as TestCase['method'] })
            }
          />
        </div>
      </div>
      <div style={colStyles.priority} className="flex shrink-0 items-center overflow-hidden px-2">
        <div onClick={(e) => e.stopPropagation()} className="w-full">
          <SearchableSelect
            value={testCase.priority}
            readOnly={!canEdit || update.isPending}
            ariaLabel={`Test case ${testCase.testCaseKey} priority`}
            options={PRIORITY_OPTIONS}
            onChange={(v) =>
              v !== testCase.priority && update.mutate({ priority: v as TestCase['priority'] })
            }
          />
        </div>
      </div>
      <div style={colStyles.owner} className="flex shrink-0 items-center overflow-hidden px-2">
        <OwnerSelectCell
          ownerName={testCase.ownerName}
          assigneeId={testCase.ownerId}
          members={ownerOptions}
          canEdit={canEdit && !update.isPending}
          onChange={(userId) => update.mutate({ ownerId: userId })}
          ariaLabel={`Test case ${testCase.testCaseKey} owner`}
        />
      </div>
      <div style={colStyles.lastVerdict} className="flex shrink-0 items-center px-2">
        <VerdictBadge verdict={testCase.lastVerdict} />
      </div>
      <div style={colStyles.lastRun} className="flex shrink-0 items-center px-2">
        {/* Never `EMPTY_VALUE` here (BR10) — "Not run yet" is a different sentence from "unknown". */}
        <span className="text-ui-sm text-foreground">{testCase.lastRun ?? 'Not run yet'}</span>
      </div>
    </TableRow>
  )
}
