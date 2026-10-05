/**
 * Iteration Status Manage Filters field list — `P2-IS-FR-022/023/024`.
 *
 * FR-023: "Text-style filters are used for ID, Name, Plan Est, Task Est and To
 * Do." FR-024: "Dropdown-style filters are used for Type, Schedule State, Flow
 * State, Iteration, Blocked and Owner."
 *
 * Each key IS the server query parameter of `GET /v1/iterations/:id/status`, so
 * the page hands `applied` straight to the query. Every field is a SERVER
 * predicate (see `IterationStatusDrizzleRepository.listItems`); this screen used
 * to filter Schedule State / Owner / Blocked over already-fetched rows.
 *
 * TWO of FR-024's six dropdowns are deliberately absent, and both would be
 * controls that cannot answer anything:
 *
 *  • **Iteration.** The list is `iteration_id = <the selected iteration>` by
 *    definition (FR-017A), so every row carries the same Iteration. A dropdown
 *    over it can only return everything or nothing. The Iteration COLUMN stays —
 *    it is the inline control that MOVES an item (FR-032A) — but there is nothing
 *    for a filter to narrow. Changing which iteration is in scope is the
 *    iteration selector's job (FR-009).
 *  • **Flow State.** `work_items.flow_state` always mirrors `schedule_state`
 *    (BR-WI-01, enforced in the repository) and this grid's Flow State cell
 *    renders `item.scheduleState` for that reason. A Flow State dropdown would be
 *    the Schedule State dropdown twice, under two names, and a reader who set
 *    them to different values would get an empty grid with no way to see why.
 *    If the two values are ever allowed to diverge, add it then.
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  UNASSIGNED_OWNER,
  type FilterFieldDef,
  type FilterValues,
} from '@/features/work-items/model/manage-filters'
import type { IterationStatusFilters } from '@/features/iterations/api'
import { SCHEDULE_STATE_LABEL, SCHEDULE_STATE_VALUES } from '@/entities/work-item/model/types'
import { HEADER_META, type ColKey } from './columns'
import type { OwnerSelectMember } from '@/shared/ui/owner-cell'

/** Server query parameter names — see `IterationStatusQuerySchema`. */
export type IterationFilterKey =
  | 'itemKey'
  | 'title'
  | 'type'
  | 'scheduleState'
  | 'isBlocked'
  | 'assigneeId'
  | 'devOwnerId'
  | 'planEstimate'
  | 'taskEstimate'
  | 'toDo'
  | 'startDate'
  | 'targetEndDate'

/**
 * Column labels, read from the grid header's own metadata so a filter can never
 * be labelled differently from the column it filters.
 */
const COLUMN_LABEL = new Map<ColKey, string>(HEADER_META.map((c) => [c.key, c.label]))
const label = (key: ColKey): string => COLUMN_LABEL.get(key) ?? key

export interface IterationFilterSources {
  members: OwnerSelectMember[]
}

export function useIterationFilterFields({
  members,
}: IterationFilterSources): FilterFieldDef<IterationFilterKey>[] {
  const { t } = useTranslation('iteration-status')

  return useMemo(
    () => [
      { key: 'itemKey', label: label('id'), kind: 'text' },
      { key: 'title', label: label('name'), kind: 'text' },
      {
        key: 'type',
        label: t('toolbar.type'),
        kind: 'select',
        options: [
          { value: 'story', label: t('create.story') },
          { value: 'defect', label: t('create.defect') },
        ],
      },
      {
        // `defaultVisible` on the three filters this screen already shipped, so
        // adding Manage Filters cannot take a working control away from anyone.
        key: 'scheduleState',
        label: label('state'),
        kind: 'select',
        defaultVisible: true,
        options: SCHEDULE_STATE_VALUES.map((s) => ({ value: s, label: SCHEDULE_STATE_LABEL[s] })),
      },
      /**
       * `P2-IS-FR-024` also lists `Flow State` and `Iteration` as dropdown filters. Both are
       * deliberately ABSENT, and for the same reason their sort affordances are:
       *
       *  - Flow State IS Schedule State on this screen — the cell reads and writes `scheduleState`
       *    (`P3-QA-FR-016`: the two "mirror two-way in MVP"). A second dropdown over one column can
       *    be set to two different values at once, and the only honest result of that pair is an
       *    empty grid, which reads as a broken filter rather than as a contradiction.
       *  - Iteration cannot narrow anything: this grid is scoped to ONE iteration, so every row
       *    carries the same value.
       *
       * Raised with the BA. If they want the Flow State control anyway, it maps to `scheduleState`
       * and this is the one place to add it.
       */
      {
        key: 'isBlocked',
        label: label('block'),
        kind: 'select',
        defaultVisible: true,
        // 'true'/'false' as sent, deliberately: the API reads the two literals
        // rather than coercing, because `Boolean('false')` is true.
        options: [
          { value: 'true', label: t('toolbar.blocked') },
          { value: 'false', label: t('toolbar.notBlocked') },
        ],
      },
      {
        key: 'assigneeId',
        label: label('owner'),
        kind: 'select',
        defaultVisible: true,
        options: [
          { value: UNASSIGNED_OWNER, label: t('toolbar.unassigned') },
          ...members.map((m) => ({ value: m.userId, label: m.displayName ?? m.userId })),
        ],
      },
      {
        // `P2-IS-FR-024` (BA 2026-08-22) adds Dev Owner to the dropdown filters beside Owner. Same
        // option list — one candidate source for both fields — and the same `unassigned` sentinel,
        // because SQL equality never matches NULL.
        key: 'devOwnerId',
        label: label('devOwner'),
        kind: 'select',
        options: [
          { value: UNASSIGNED_OWNER, label: t('toolbar.unassigned') },
          ...members.map((m) => ({ value: m.userId, label: m.displayName ?? m.userId })),
        ],
      },
      { key: 'planEstimate', label: label('planEstimate'), kind: 'number' },
      { key: 'taskEstimate', label: label('taskEstimate'), kind: 'number' },
      { key: 'toDo', label: label('toDo'), kind: 'number' },
      // Phase 7 CO-01 — a TEXT filter over the ISO date, so `2026-10` narrows to a month.
      { key: 'startDate', label: label('startDate'), kind: 'text' },
      { key: 'targetEndDate', label: label('targetEndDate'), kind: 'text' },
    ],
    [t, members],
  )
}

/**
 * Applied values as the status query's filter shape. Every control's value is text, and every wire
 * field is text too — `type` / `scheduleState` are unions and `isBlocked` is the `'true' | 'false'`
 * enum — so the option lists above make the narrowing sound and it happens once, here.
 *
 * `isBlocked` is deliberately NOT converted to a boolean. It used to be, and the server then coerced
 * it back with `z.coerce.boolean()`, where `Boolean('false') === true` — so `false` asked for blocked
 * rows. One representation, carried through.
 */
export function toIterationStatusQuery(
  applied: FilterValues<IterationFilterKey>,
): IterationStatusFilters {
  return applied as Omit<IterationStatusFilters, 'q'>
}
