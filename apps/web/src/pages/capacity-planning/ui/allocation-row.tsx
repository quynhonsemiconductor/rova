import { TableRow } from '@/shared/ui/table'
import { useMemo, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'

import { useUpdateAllocation, type CapacityAllocation } from '@/features/capacity-planning/api'
import { IdCell } from '@/entities/work-item/ui/id-cell'
import { CompositeBar } from '@/shared/ui/composite-bar'
import { CapacityBarTooltip } from './capacity-bar-tooltip'
import { MetricValue } from '@/shared/ui/metric-value'
import { portfolioStateColor } from '@/features/portfolio/status-colors'
import { InlineEditableCell } from '@/shared/ui/inline-editable-cell'
import { EMPTY_VALUE } from '@/shared/lib/utils'
import { notify } from '@/shared/lib/toast'
import { useCapacityWarningText } from '@/features/capacity-planning/warning-labels'
import { type AllocColKey } from '../model/columns'
import { EstimateTierIcon } from './estimate-tier-badge'
import { CapacityItemActions } from './capacity-item-actions'
import { entityDetailPath } from '@/shared/lib/entity-link'

/**
 * One allocated Feature inside its team's sub-table (or the Unallocated bucket's).
 *
 * Laid out against `AllocColKey`, the nested table's own columns — see
 * `TeamAllocationsTable` for why the child grid does not reuse the parent's headers.
 *
 * The Estimated cell edits in place. A Feature row has NO capacity of its own, so its bar
 * scales against its own largest value and only the two Feature rules can fire: Rally's
 * missing-estimate error and rollup-exceeds-estimated. `computeCapacityWarnings` returns
 * exactly those for `kind: 'feature'`, so there is no separate code path here.
 */
export function AllocationRow({
  planId,
  allocation,
  canManage,
  colStyleFor,
  onOpenFeature,
  rankPosition,
  ownerTeamName,
  contributorTeamNames,
  hasTeams,
  onAllocate,
  onMove,
  onMoveUp,
  onMoveDown,
  onUnassign,
  onRemove,
}: {
  planId: string
  allocation: CapacityAllocation
  canManage: boolean
  colStyleFor: (key: AllocColKey, base?: CSSProperties) => CSSProperties
  onOpenFeature: (portfolioItemId: string) => void
  /** The Feature's 1-based position in the plan's rank order, resolved by the table. */
  rankPosition: number | null
  /**
   * The team holding this Feature's PLAN assignment, when it is not this row's team. Drives `from`.
   */
  ownerTeamName: string | null
  /** The other teams this Feature is allocated to, when this row IS the assignment. Drives `to`. */
  contributorTeamNames: string[]
  /** Whether the Feature holds any team at all — gates `Remove All Assignments`. */
  hasTeams: boolean
  /**
   * The same three verbs the Features tab offers, so Rally's gear reads the same next to a Feature
   * wherever it is seen. Omitted (and the gear then hidden) on a published plan.
   */
  onAllocate?: () => void
  onMove?: () => void
  /** The BA's one-position reorder, swapping with the adjacent row INSIDE this team only. */
  onMoveUp?: () => void
  onMoveDown?: () => void
  onUnassign?: () => void
  onRemove?: () => void
}) {
  const { t } = useTranslation('capacity')
  /**
   * Rally's `Allocation` cell, to its documented rules:
   *
   *   • "assigned to the current project with no other point/count allocations to other projects" —
   *     the field is BLANK.
   *   • "assigned to the current project, but have point/count allocations to another project" — the
   *     other project's name "displays with a prefix of `to`".
   *   • "assigned to a different project, but have point/count allocations for the current project" —
   *     the assigned project's name "displays with a prefix of `from`".
   *   • "If the portfolio item is allocated to multiple projects, the number of allocated projects
   *     display."
   *
   * "Assigned" is the PLAN's assignment — Planned Team Assignment, our primary allocation — not the
   * Feature's team outside the plan. Those two disagree as soon as a planner changes the assignment
   * inside a plan, and Rally's cell follows the plan.
   */
  const sharing = useMemo(() => {
    if (allocation.teamId === null) return null
    // This row IS the assignment: report what was allocated AWAY, or nothing.
    if (allocation.isPrimary) {
      if (contributorTeamNames.length === 0) return null
      return contributorTeamNames.length === 1
        ? {
            text: `${t('row.to')} ${contributorTeamNames[0]}`,
            title: t('row.allocatedTo', { team: contributorTeamNames[0] }),
          }
        : {
            // Rally prints the COUNT rather than a list once there is more than one.
            text: t('row.allocatedCount', { count: contributorTeamNames.length }),
            title: t('row.allocatedTo', { team: contributorTeamNames.join(', ') }),
          }
    }
    // This row is a contributor: report who the work came FROM.
    if (ownerTeamName === null) return null
    return {
      text: `${t('row.from')} ${ownerTeamName}`,
      title: t('row.allocatedFrom', { team: ownerTeamName }),
    }
  }, [allocation.teamId, allocation.isPrimary, contributorTeamNames, ownerTeamName, t])

  // The Feature state vocabulary lives in the portfolio namespace — the same labels the Portfolio
  // page shows, so a state cannot read one way there and another way inside a plan.
  const { t: tPortfolio } = useTranslation('portfolio')
  const warningText = useCapacityWarningText()
  const update = useUpdateAllocation()
  const { metrics } = allocation

  function commit(raw: string) {
    const trimmed = raw.trim()
    /**
     * Emptying the cell RE-COPIES the Feature's current top-down estimate (§185), it does not commit 0.
     *
     * `value: null` on the wire, which used to clear the row to NULL and hand it back to a resolving
     * read. There is no NULL to write since 0101 — the value is fixed — but the gesture still means
     * "charge whatever this Feature is estimated at", evaluated now. Always sent: the row may already
     * hold the estimate as a stale copy, and re-copying is exactly how a planner re-baselines it.
     */
    if (trimmed === '') {
      update.mutate(
        { id: planId, allocationId: allocation.id, value: null },
        {
          onSuccess: () => notify.success(t('row.allocationRecopied')),
          onError: (err) => notify.error(err.message),
        },
      )
      return
    }
    const next = Number(trimmed)
    if (!Number.isFinite(next) || next < 0) {
      notify.error(t('row.capacityInvalid'))
      return
    }
    if (next === allocation.value) return
    update.mutate(
      { id: planId, allocationId: allocation.id, value: next },
      {
        onSuccess: () => notify.success(t('row.allocationUpdated')),
        onError: (err) => notify.error(err.message),
      },
    )
  }

  return (
    <TableRow className="px-2 py-0.5" compact>
      {/* The gear LEADS here, which is the BA's placement for this table and the one table where it
          does: "the only place this row's allocation is changed" is the row's subject, not a trailing
          afterthought. Same component the Features tab renders, so the verbs cannot diverge. */}
      <div
        style={colStyleFor('actions', { flexShrink: 0 })}
        className="flex items-center justify-center px-0"
        onClick={(e) => e.stopPropagation()}
      >
        <CapacityItemActions
          itemKey={allocation.itemKey}
          hasTeams={hasTeams}
          onMoveUp={onMoveUp}
          onMoveDown={onMoveDown}
          onAllocate={onAllocate}
          onMove={onMove}
          onUnassign={onUnassign}
          onRemove={onRemove}
        />
      </div>

      {/* The FEATURE's plan-wide rank, not a position in this team's list: a planner reading one
          team still wants to know where each Feature sits in the plan's priority order. */}
      <div
        style={colStyleFor('rank', { flexShrink: 0 })}
        className="px-2 text-right text-muted-foreground tabular-nums"
      >
        {rankPosition ?? EMPTY_VALUE}
      </div>

      <div style={colStyleFor('id', { flexShrink: 0 })} className="min-w-0 px-2">
        <IdCell
          type="feature"
          itemKey={allocation.itemKey}
          onOpen={() => onOpenFeature(allocation.portfolioItemId)}
          href={entityDetailPath.portfolioItem(allocation.portfolioItemId)}
        />
      </div>

      {/* Just the name. It carried a `Primary` chip and, on the other rows, a star that promoted a
          contributor team — real Rally has neither in this column. Rally marks the primary on the
          Features tab's `Planned Team Assignment` field and routes split edits through the Allocate
          dialog (§180), which is where that radio now lives: the Features-tab cell is read-only for a
          split Feature, so the dialog is the only place a split's primary can be chosen. */}
      <div
        style={colStyleFor('name', { flexShrink: 0 })}
        className="flex min-w-0 items-center px-2"
      >
        <span className="break-words whitespace-normal text-foreground" title={allocation.name}>
          {allocation.name}
        </span>
      </div>

      {/* The FEATURE's own state — Rally's `State` column on this table. Read-only here: the state
          belongs to the Feature and is edited on the Portfolio page, not inside a plan. */}
      <div
        style={colStyleFor('state', { flexShrink: 0 })}
        className="flex min-w-0 items-center px-2"
      >
        {/* PLAIN TEXT, no chip: Rally's capacity plan prints the state as coloured text, and a pill
            here read as a control the cell does not offer — the state belongs to the Feature and is
            edited on Portfolio, not inside a plan.
            The colour still comes from the shared portfolio map, so `Developing` is the same hue here
            as on the Portfolio page; only the background and outline are gone. */}
        <span
          className="break-words whitespace-normal"
          style={{ color: portfolioStateColor(allocation.state) }}
        >
          {tPortfolio(`states.${allocation.state}`)}
        </span>
      </div>

      {/* The `Allocation` column: where this row's work came FROM. The allocated points live in the
          trailing `Estimate` tooltip and are edited in `Estimated`. */}
      <div
        style={colStyleFor('allocation', { flexShrink: 0 })}
        className="flex min-w-0 items-center px-2"
      >
        {/**
         * `EMPTY_VALUE` when there is no relationship to report — the row sits under the Feature's OWN
         * team with nothing allocated away, or under the Unallocated bucket, where there is no
         * assignment for the cell to be relative to.
         *
         * This cell rendered NOTHING in that case, on the reading that Rally leaves the field blank
         * because the value is a relationship rather than a quantity. P5-CP-025 rules against it: an
         * empty cell in a table where every neighbour carries a value reads as "not loaded", and this
         * app answers an absent value one way everywhere (`EMPTY_VALUE`). Note the BA writes the dash
         * as `—` in prose and the string here is `--` — see `EMPTY_VALUE`'s own docblock, which is
         * deliberate and not a transcription slip.
         */}
        {sharing === null ? (
          <span className="text-ui-sm text-muted-foreground">{EMPTY_VALUE}</span>
        ) : (
          <span
            className="text-ui-sm break-words whitespace-normal text-muted-foreground italic"
            title={sharing.title}
          >
            {sharing.text}
          </span>
        )}
      </div>

      {/* `Dependencies`. Rally's column "shows the number of dependencies that are assigned to each
          portfolio item", so it is a COUNT — `0` here as on the Features tab, not the dash the BA's
          catalog suggests for this table: a dash reads as "unknown" where Rally reads "none". */}
      <div
        style={colStyleFor('dependencies', { flexShrink: 0 })}
        className="px-2 text-right text-muted-foreground tabular-nums"
      >
        0
      </div>

      <div style={colStyleFor('progress', { flexShrink: 0 })} className="min-w-0 px-2">
        <CompositeBar
          complete={metrics.complete}
          rollup={metrics.rollup}
          estimated={metrics.estimated}
          capacity={metrics.capacity}
          warningLabels={warningText(metrics.warnings)}
          tooltip={
            <CapacityBarTooltip
              complete={metrics.complete}
              rollup={metrics.rollup}
              estimated={metrics.estimated}
              capacity={metrics.capacity}
            />
          }
        />
      </div>

      {/* No percentages: a Feature has no capacity of its own to be a share OF — the ceiling
          belongs to the team whose sub-table this is. */}
      <div style={colStyleFor('complete', { flexShrink: 0 })} className="px-2 text-right">
        <MetricValue value={metrics.complete} pct={null} />
      </div>
      <div style={colStyleFor('rollup', { flexShrink: 0 })} className="px-2 text-right">
        <MetricValue value={metrics.rollup} pct={null} />
      </div>
      {/* `Estimated` is the row's charge AND its editor: typing here commits a number a planner chose
          (`manual`), emptying it re-copies the Feature's estimate (`feature_estimate`). Rally edits the
          allocation through its assignment dialog; we put it on the number it changes, which is the
          same cell a reader is already looking at. */}
      <div
        style={colStyleFor('estimated', { flexShrink: 0 })}
        className="min-w-0 px-0"
        onClick={(e) => e.stopPropagation()}
      >
        <InlineEditableCell
          fullCell
          value={String(allocation.value)}
          canEdit={canManage}
          onCommit={commit}
          ariaLabel={t('row.allocationLabel', { feature: allocation.itemKey })}
          displayValue={
            <span className="block w-full text-right">
              <MetricValue value={metrics.estimated} pct={null} />
            </span>
          }
          className="block w-full text-right"
          inputClassName="w-full rounded border border-primary bg-transparent px-1 py-0.5 text-right text-inherit text-foreground focus:outline-none"
        />
      </div>

      {/* Rally's trailing `Estimate` glyph and its panel — Allocated / Refined / Preliminary, the one in
          force ticked and the other two struck through, matched to a screenshot of the real product's
          team tab.
          §185-186's source (`Manual` / `Feature Estimate`) is a finer distinction than Rally draws and
          has no row of its own in that panel, so it rides the glyph's accessible name instead. */}
      <div
        style={colStyleFor('tier', { flexShrink: 0 })}
        className="flex items-center justify-center px-1"
      >
        <EstimateTierIcon
          tier={allocation.tier}
          // `allocated` is THIS row's committed value — the number the Estimated cell shows beside it.
          breakdown={{ allocated: allocation.value, ...allocation.estimateBreakdown }}
          sourceNote={t(`sources.${allocation.source}`)}
        />
      </div>
    </TableRow>
  )
}
