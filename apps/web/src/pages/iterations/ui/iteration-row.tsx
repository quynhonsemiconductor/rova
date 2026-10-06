import { TableRow } from '@/shared/ui/table'
import { type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { useUpdateIteration, type Iteration, type IterationState } from '@/features/iterations/api'
import { ITERATION_STATE_STYLE } from '@/features/iterations/status-colors'
import { notify } from '@/shared/lib/toast'
import { stripHtml } from '@/shared/lib/utils'
import { IdCell } from '@/entities/work-item/ui/id-cell'
import { DateField } from '@/shared/ui/date-field'
import { InlineEditableCell } from '@/shared/ui/inline-editable-cell'
import { SearchableSelect } from '@/shared/ui/searchable-select'
import { type ColKey } from '../model/columns'
import { entityDetailPath } from '@/shared/lib/entity-link'

/** Lifecycle order — forward transitions are gated server-side (Commit/Accept). */
const ITERATION_STATES: IterationState[] = ['planning', 'committed', 'accepted']

/**
 * IterationRow — one inline-editable Timeboxes row, mirroring ReleaseRow /
 * StatusRow: the row owns its per-row `useUpdateIteration` mutation so Name,
 * dates and Planned Velocity commit inline (same shared cells as Iteration
 * Status). Theme is rich text (edited on the detail page), so it stays a
 * read-only display here; State is gated (Commit/Accept/Rollover), so it renders
 * as a read-only StatusBadge rather than a free dropdown.
 */
export function IterationRow({
  iteration: it,
  canManage,
  colStyleFor,
  gutter,
  onOpen,
}: {
  iteration: Iteration
  canManage: boolean
  colStyleFor: (key: ColKey, base?: CSSProperties) => CSSProperties
  gutter: ReactNode
  onOpen: () => void
}) {
  const { t } = useTranslation('iterations')
  const update = useUpdateIteration(it.id)

  const commit = (patch: Partial<Iteration>, msg: string) =>
    update.mutate(patch as never, {
      onSuccess: () => notify.success(msg),
      onError: (err) => notify.error(err.message),
    })

  function saveName(raw: string) {
    const val = raw.trim()
    if (!val || val === it.name) return
    commit({ name: val }, t('row.nameUpdated'))
  }
  function saveTheme(raw: string) {
    const val = raw.trim()
    if (val === stripHtml(it.theme)) return
    commit({ theme: val || null }, t('row.themeUpdated'))
  }
  function saveVelocity(raw: string) {
    const val = raw.trim()
    const num = val === '' ? null : Number(val)
    if (num !== null && (isNaN(num) || num < 0)) {
      notify.error(t('row.velocityInvalid'))
      return
    }
    if (num !== it.plannedVelocity) commit({ plannedVelocity: num }, t('row.velocityUpdated'))
  }
  const saveStartDate = (val: string | null) =>
    commit({ startDate: val }, t('row.startDateUpdated'))
  const saveEndDate = (val: string | null) => commit({ endDate: val }, t('row.endDateUpdated'))
  function saveState(v: string) {
    if (v === it.state) return
    // The backend routes a state PATCH through the gated Commit/Accept actions
    // and rejects invalid transitions (surfaced as a toast error).
    commit({ state: v as IterationState }, t('row.stateUpdated'))
  }

  const stop = (e: React.MouseEvent) => e.stopPropagation()

  return (
    <TableRow className="px-3" style={{ minWidth: 'max-content' }}>
      {gutter}

      {/* ID — type glyph + per-project key (IT-<n>) */}
      <div
        style={colStyleFor('id', { flexShrink: 0 })}
        className="flex items-center px-2"
        onClick={stop}
      >
        <IdCell
          type="iteration"
          itemKey={it.iterationKey ?? '--'}
          onOpen={onOpen}
          href={entityDetailPath.iteration(it.id)}
        />
      </div>

      {/* Name — inline-editable */}
      <div style={colStyleFor('name', { flexShrink: 0 })} className="min-w-0 px-0" onClick={stop}>
        <InlineEditableCell
          fullCell
          value={it.name}
          canEdit={canManage}
          onCommit={saveName}
          ariaLabel="Name"
          title={it.name}
          className="block w-full break-words whitespace-normal text-foreground"
          style={{ fontSize: 12 }}
          inputClassName="w-full rounded border border-primary bg-transparent px-1 py-0.5 text-inherit text-foreground focus:outline-none"
        />
      </div>

      {/* Theme — inline-editable (shared InlineEditableCell, like Name). Full
          rich-text editing remains on the detail page. */}
      <div style={colStyleFor('theme', { flexShrink: 0 })} className="min-w-0 px-0" onClick={stop}>
        <InlineEditableCell
          fullCell
          value={stripHtml(it.theme)}
          canEdit={canManage}
          onCommit={saveTheme}
          ariaLabel="Theme"
          displayValue={
            <span className="block break-words whitespace-normal text-muted-foreground">
              {stripHtml(it.theme) || '--'}
            </span>
          }
          inputClassName="w-full rounded border-0 bg-transparent px-0.5 text-inherit text-foreground focus:outline-none"
        />
      </div>

      {/* Start Date — inline-editable */}
      <div style={colStyleFor('startDate', { flexShrink: 0 })} className="px-0" onClick={stop}>
        <DateField
          value={it.startDate}
          readOnly={!canManage}
          ariaLabel="Start date"
          onChange={canManage ? saveStartDate : undefined}
        />
      </div>

      {/* End Date — inline-editable */}
      <div style={colStyleFor('endDate', { flexShrink: 0 })} className="px-0" onClick={stop}>
        <DateField
          value={it.endDate}
          readOnly={!canManage}
          ariaLabel="End date"
          onChange={canManage ? saveEndDate : undefined}
        />
      </div>

      {/* Planned Velocity — inline-editable */}
      <div
        style={colStyleFor('plannedVelocity', { flexShrink: 0 })}
        className="px-0"
        onClick={stop}
      >
        <InlineEditableCell
          fullCell
          value={it.plannedVelocity != null ? String(it.plannedVelocity) : ''}
          canEdit={canManage}
          onCommit={saveVelocity}
          ariaLabel="Planned velocity"
          displayValue={
            <span className="block text-right font-mono text-muted-foreground tabular-nums">
              {it.plannedVelocity ?? '--'}
            </span>
          }
          inputClassName="w-full rounded border-0 bg-transparent px-0.5 text-right font-mono text-inherit text-foreground focus:outline-none"
        />
      </div>

      {/* Task Estimate — read-only rollup of child task estimate hours (IT-001). */}
      <div
        style={colStyleFor('taskEstimate', { flexShrink: 0 })}
        className="px-0 text-right"
        onClick={stop}
      >
        <span className="block font-mono text-muted-foreground tabular-nums">
          {it.taskEstimate ?? '--'}
        </span>
      </div>

      {/* State — same SearchableSelect enum-dropdown as Iteration Status / Backlog
          Flow State. Editable: the backend routes the change through the gated
          Commit / Accept lifecycle actions and rejects invalid transitions. */}
      <div style={colStyleFor('state', { flexShrink: 0 })} className="px-0" onClick={stop}>
        <SearchableSelect
          value={it.state}
          readOnly={!canManage}
          ariaLabel="Iteration state"
          options={ITERATION_STATES.map((s) => ({
            value: s,
            label: ITERATION_STATE_STYLE[s].label,
          }))}
          onChange={saveState}
        />
      </div>
    </TableRow>
  )
}
