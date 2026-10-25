import { useCallback, type CSSProperties } from 'react'
import { Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { DataTableFrame } from '@/shared/ui/table/data-table-frame'
import { useDataTable } from '@/shared/ui/table'
import { EmptyState } from '@/shared/ui/empty-state'
import type { CapacityAllocation } from '@/features/capacity-planning/api'
import { CAPACITY_ALLOCATION_COLUMNS, type AllocColKey } from '../model/columns'
import { AllocationRow } from './allocation-row'

/**
 * The nested table of Features allocated to one team — Rally's sub-table under an expanded row.
 *
 * A real table, not a run of rows borrowing the parent's columns: Rally renders it with its own
 * header, and it has to, because the columns mean different things one level down. The parent's
 * `Features` is a count and its `Capacity` is the ceiling a planner typed; a child row has neither
 * — it has an `Allocation`, the slice of that ceiling this Feature was promised. Continuing the
 * parent's headers put a child's allocation under a header reading "Capacity".
 *
 * Built from the same `useDataTable` + `DataTableFrame` as every grid in the app, so it resizes,
 * reorders and lays out identically to the table it sits inside. Every instance shares one storage
 * key on purpose: these are all the same table, so widening `Name` under one team widens it under
 * the next.
 */
export function TeamAllocationsTable({
  planId,
  allocations,
  canManage,
  onOpenFeature,
  rankPositionOf,
  sharingOf,
  onAddFeatures,
  itemActions,
}: {
  planId: string
  allocations: CapacityAllocation[]
  canManage: boolean
  onOpenFeature: (portfolioItemId: string) => void
  /**
   * The Feature's 1-based position in the PLAN's rank order.
   *
   * Resolved by the page from the plan's item list rather than counted inside this table: a team's
   * rows are a subset of the plan, so counting locally would number them 1..n and claim a priority
   * order this team does not own.
   */
  rankPositionOf: (portfolioItemId: string) => number | null
  /**
   * Who else holds this Feature: the team carrying its PLAN assignment when that is not this table's,
   * and the other teams it was allocated to when this table's team holds the assignment.
   *
   * Resolved by the page — a nested table only sees its own rows, so it cannot tell whether a Feature
   * is shared, and Rally's `Allocation` cell is entirely about that.
   */
  sharingOf: (portfolioItemId: string) => { owner: string | null; contributors: string[] }
  /**
   * Rally's `Add Items to Project Plan`: adds Features already assigned to THIS team.
   *
   * Below the list rather than above it, which is where Rally puts it and where the BA's catalog
   * puts it too — the button belongs to the group it appends to, and a header-level control would
   * read as belonging to the plan.
   *
   * Omitted for a reader who cannot manage the plan, which is also how the row hides its editors.
   */
  onAddFeatures?: () => void
  /**
   * Rally's per-item gear for these rows, resolved by the page.
   *
   * A resolver rather than three callbacks: the verbs act on a Feature, and the page already owns
   * the handlers the Features tab uses — passing them per row here keeps ONE definition of what
   * `Remove From Plan` does instead of a second copy for the nested table. Undefined means the plan
   * is read-only and no gear is drawn.
   */
  itemActions?: (allocation: CapacityAllocation) => {
    hasTeams: boolean
    onAllocate?: () => void
    onMove?: () => void
    onMoveUp?: () => void
    onMoveDown?: () => void
    onUnassign?: () => void
    onRemove?: () => void
  }
}) {
  const { t } = useTranslation('capacity')
  const table = useDataTable<CapacityAllocation, unknown, AllocColKey>(
    CAPACITY_ALLOCATION_COLUMNS,
    { storageKey: 'rally-capacity-allocation-columns' }, // legacy physical name, do not rename
  )
  const colStyleFor = useCallback(
    (key: AllocColKey, base?: CSSProperties) => table.styleFor(key, base),
    [table],
  )

  return (
    // Indented and rule-bounded so the nesting is visible without a connector line: the left
    // border reads as "everything to the right of this belongs to the row above".
    // The right padding RESERVES the Team row's last two columns — `Capacity` (100) and its actions
    // lane (48) — because the BA requires this child table to end before Capacity: team-level capacity
    // has to stay visually separate from Feature-level progress. Without it the child ran to the
    // grid's outer edge and its `Estimated` sat under the parent's `Capacity` heading.
    <div className="border-b border-border-inner bg-surface-subtle/40 py-1 pr-[148px] pl-8">
      <div className="border-l-2 border-border-subtle pl-2">
        <DataTableFrame
          header={table.headerProps}
          padClassName="px-2"
          empty={
            allocations.length === 0 ? <EmptyState title={t('row.noAllocations')} /> : undefined
          }
        >
          {allocations.map((allocation) => (
            <AllocationRow
              key={allocation.id}
              planId={planId}
              allocation={allocation}
              canManage={canManage}
              colStyleFor={colStyleFor}
              onOpenFeature={onOpenFeature}
              rankPosition={rankPositionOf(allocation.portfolioItemId)}
              ownerTeamName={sharingOf(allocation.portfolioItemId).owner}
              contributorTeamNames={sharingOf(allocation.portfolioItemId).contributors}
              {...(itemActions?.(allocation) ?? { hasTeams: false })}
            />
          ))}
        </DataTableFrame>

        {onAddFeatures !== undefined && (
          <button
            type="button"
            onClick={onAddFeatures}
            className="flex items-center gap-1 px-2 py-1.5 text-ui-sm text-primary-light underline-offset-2 hover:underline"
          >
            <Plus size={12} /> {t('addFeatures.actionForTeam')}
          </button>
        )}
      </div>
    </div>
  )
}
