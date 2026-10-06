import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'

import { IdCell } from '@/entities/work-item/ui/id-cell'
import { InlineEditableCell } from '@/shared/ui/inline-editable-cell'
import { SearchableSelect, type SelectOption } from '@/shared/ui/searchable-select'
import { notify } from '@/shared/lib/toast'
import { StatusBadge } from '@/shared/ui/status-badge'
import { formatDateTime } from '@/shared/lib/utils'
import { CAPACITY_STATUS_STYLE } from '@/features/capacity-planning/status-colors'
import { useUpdateCapacityPlan, type CapacityPlan } from '@/features/capacity-planning/api'
import type { PlanColKey } from '../model/columns'
import { entityDetailPath } from '@/shared/lib/entity-link'

/**
 * One row of the Capacity Planning list, matching Rally's own: `ID`, `Name`, `Release`, `Status`,
 * `Last Updated`, `Teams in Plan`.
 *
 * Extracted from the page for the same reason `ReleaseRow` and `IterationRow` are: the row needs
 * the scaffold's selection gutter, and a page that also renders its rows inline ends up with two
 * places that must agree on column order.
 *
 * ONLY the ID cell navigates. Rally works that way and so does every other grid here (Timeboxes,
 * Releases, Iteration Status): a row-wide click fights the checkbox, the inline cells and text
 * selection, and it makes the row's one deliberate link look decorative.
 */
export function CapacityPlanRow({
  plan,
  canManage,
  releaseOptions,
  colStyleFor,
  gutter,
}: {
  plan: CapacityPlan
  /** `capacity:manage` — gates the inline rename. */
  canManage: boolean
  /**
   * The project's releases as `SearchableSelect` options, built ONCE by the page.
   *
   * Passed in rather than derived per row: the list is the same for every row, and mapping it
   * inside the row would rebuild it once per plan on every render.
   */
  releaseOptions: SelectOption[]
  colStyleFor: (key: PlanColKey, base?: React.CSSProperties) => React.CSSProperties
  /** Selection gutter node supplied by the list scaffold. */
  gutter: ReactNode
}) {
  const { t } = useTranslation('capacity')
  const navigate = useNavigate()
  // Per row, like `ReleaseRow`/`IterationRow`: the mutation belongs to the row being edited, and a
  // page-level one would need the row's id threaded back up through the commit handler.
  const updatePlan = useUpdateCapacityPlan()
  const open = () =>
    void navigate({ to: '/capacity-planning/$planId', params: { planId: plan.id } })

  async function saveName(next: string) {
    const name = next.trim()
    if (name === '' || name === plan.name) return
    try {
      await updatePlan.mutateAsync({ id: plan.id, patch: { name } })
    } catch (err) {
      notify.error(err instanceof Error ? err.message : t('renameFailed'))
    }
  }

  return (
    <div
      role="row"
      className="group flex min-h-[35px] w-full items-center border-b border-border-inner px-3 text-left text-ui-md transition-colors hover:bg-primary-lighter"
    >
      {gutter}

      <div style={colStyleFor('id', { flexShrink: 0 })} className="flex items-center px-2">
        {/* `CP-<n>`, minted per project. `—` when a pre-0076 row somehow escaped the backfill:
            the row still has to render, and a blank cell would look like a layout bug. */}
        <IdCell
          type="capacityPlan"
          itemKey={plan.planKey ?? '--'}
          onOpen={open}
          href={entityDetailPath.capacityPlan(plan.id)}
        />
      </div>

      {/* Name — inline-editable, exactly as the Timeboxes, Releases and Iteration Status grids
          make their Name column: click the text to rename, use the ID link to open. Drafts only;
          a published plan is frozen until it is reverted, so the cell renders read-only rather
          than accepting an edit the API would refuse. */}
      <div
        style={colStyleFor('name', { flexShrink: 0 })}
        className="min-w-0 px-0"
        onClick={(e) => e.stopPropagation()}
      >
        <InlineEditableCell
          fullCell
          value={plan.name}
          canEdit={canManage && plan.status === 'draft'}
          onCommit={saveName}
          ariaLabel={t('fields.name')}
          title={plan.name}
          className="block w-full font-medium break-words whitespace-normal text-foreground"
          style={{ fontSize: 12 }}
          inputClassName="w-full rounded border border-primary bg-transparent px-1 py-0.5 text-inherit text-foreground focus:outline-none"
        />
      </div>

      {/* Release — the same `SearchableSelect` cell the Backlog's Release column uses, so a release
          reads identically wherever it appears: the `RE-<n>: Name` label and the release glyph,
          not a bare string.
          Always `readOnly`: a plan is one per (project, release) and `updatePlan` deliberately
          cannot change `releaseId` — every number on the plan is scoped to that release, so
          re-pointing it would silently reinterpret the demand instead of moving it. */}
      <div
        style={colStyleFor('release', { flexShrink: 0 })}
        className="flex min-w-0 items-center overflow-hidden px-0"
      >
        <SearchableSelect
          readOnly
          value={plan.releaseId}
          ariaLabel={t('fields.release')}
          placeholder="--"
          options={releaseOptions}
          onChange={() => {}}
        />
      </div>

      <div style={colStyleFor('status', { flexShrink: 0 })} className="min-w-0 px-2">
        {/* The shared badge + the feature's own colour map, as on the detail header — this cell
            used to render the status as plain text, the only one in the app that did. */}
        <StatusBadge style={CAPACITY_STATUS_STYLE[plan.status]} />
      </div>

      <div
        style={colStyleFor('updatedAt', { flexShrink: 0 })}
        className="min-w-0 px-2 text-muted-foreground"
      >
        <span className="truncate">{formatDateTime(plan.updatedAt)}</span>
      </div>

      <div
        style={colStyleFor('teamCount', { flexShrink: 0 })}
        className="px-2 text-right text-muted-foreground tabular-nums"
      >
        {plan.teams.length}
      </div>
    </div>
  )
}
