import { type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'

import { IdCell } from '@/entities/work-item/ui/id-cell'
import { MetricValue } from '@/shared/ui/metric-value'
import { TeamCell } from '@/shared/ui/team-cell'
import { SearchableSelect } from '@/shared/ui/searchable-select'
import { RowExpandToggle } from '@/shared/ui/row-expand-toggle'
import { WarningIndicator } from '@/shared/ui/warning-indicator'
import { BRAND } from '@/shared/config/brand'
import { cn } from '@/shared/lib/utils'
import type { CapacityPlanItem, CapacityWarning } from '@/features/capacity-planning/api'
import { useCapacityWarningText } from '@/features/capacity-planning/warning-labels'
import { EstimateTierIcon } from './estimate-tier-badge'
import { CapacityItemActions } from './capacity-item-actions'
import { type ItemColKey } from '../model/columns'
import { entityDetailPath } from '@/shared/lib/entity-link'

/**
 * One Feature on Rally's Items tab.
 *
 * The item-level counterpart to `AllocationRow`, which shows one team's slice. Both exist
 * because Rally reports a Feature's rollup ONCE on this tab while the team grid attributes it
 * per team — the same Feature legitimately shows different numbers on the two surfaces, and the
 * row that says which is which is the one the reader is looking at.
 *
 * Reuses `IdCell`, `CompositeBar` and `EstimateTierBadge` so a Feature reads identically here,
 * on the team grid, and on the Portfolio page.
 */
export function CapacityItemRow({
  item,
  position,
  primaryTeamName,
  belowCutline,
  expanded = false,
  onToggleExpanded,
  anySplitFeature = false,
  teamKeyOf = () => null,
  onRemove,
  onUnassign,
  onAllocate,
  onMove,
  onMoveUp,
  onMoveDown,
  onAssign,
  assignOptions = [],
  dragHandle,
  colStyleFor,
  onOpenFeature,
}: {
  item: CapacityPlanItem
  /** 1-based rank position within this plan — the order the cutline accumulates down. */
  position: number
  /** Name of the team that owns this Feature, resolved by the page from the plan's teams. */
  primaryTeamName: string | null
  /** Below the plan's cutline: this Feature does not fit the plan's total capacity. */
  belowCutline: boolean
  /** Whether this Feature's per-team rows are showing. */
  expanded?: boolean
  /** Omitted where nothing can be nested — the toggle then renders as a spacer. */
  onToggleExpanded?: () => void
  /**
   * Whether ANY Feature on the plan is split across teams, i.e. whether this grid has a disclosure
   * column at all. Resolved by the page, because a row cannot see its siblings — without it every ID on
   * a plan with no splits carried 12px of blank space in front of it.
   */
  anySplitFeature?: boolean
  /** Team id → key, resolved by the page from the project's teams: the chip's two letters. */
  teamKeyOf?: (teamId: string | null | undefined) => string | null
  /** Removes the Feature from the plan. Omitted for a reader without `capacity:manage`. */
  onRemove?: () => void
  /** Clears every team assignment but keeps the Feature on the plan — Rally's second removal verb. */
  onUnassign?: () => void
  /** Opens the Allocate dialog for THIS Feature — splitting it across teams. */
  onAllocate?: () => void
  /** Opens Rally's `Move To Another Plan` for THIS Feature. */
  onMove?: () => void
  /** The BA's one-position reorder, within the PLAN's rank list. Absent at the ends. */
  onMoveUp?: () => void
  onMoveDown?: () => void
  /**
   * Assigns the Feature to one team, or to none. Omitted where the reader cannot manage the plan,
   * which turns the cell back into text.
   */
  onAssign?: (teamId: string | null) => void
  /** Teams on the plan, plus `Unassign` — built once by the page. */
  assignOptions?: { value: string; label: string }[]
  /** The rank grip, rendered by the page so the row need not know about dnd-kit. */
  dragHandle?: ReactNode
  colStyleFor: (key: ItemColKey, base?: CSSProperties) => CSSProperties
  onOpenFeature: (portfolioItemId: string) => void
}) {
  const { t } = useTranslation('capacity')
  /**
   * The BA's two rules, resolved to the text it specifies and split by the column each belongs to.
   *
   * Read from the API's `warnings` rather than recomputed here: the same rule function decides them
   * for the team grid and every allocation row, and a second implementation in the client would be
   * free to disagree with the number beside it.
   */
  const warningText = useCapacityWarningText()
  const labelFor = (code: CapacityWarning) =>
    item.warnings.includes(code) ? warningText([code])[0] : null
  const rollupWarning = labelFor('rollup_exceeds_estimated')
  const estimateWarning = labelFor('feature_missing_estimate')

  return (
    <div
      className={cn(
        'group flex min-h-[35px] items-center border-b border-border-inner px-3 text-ui-md transition-colors hover:bg-primary-lighter',
        // Dimmed, not hidden: the commitment is real and still editable, and Rally's line
        // informs rather than gates.
        belowCutline && 'opacity-60',
      )}
      data-below-cutline={belowCutline || undefined}
    >
      {/* Rally's `+/-`. Empty on every row today: it reports what changed since the plan was
          PUBLISHED, and nothing holds a published snapshot yet, so the BA keeps it "neutral before
          Publish". Present rather than added later, because a column that appears shifts every
          other one. */}
      <div style={colStyleFor('marker', { flexShrink: 0 })} className="px-0" aria-hidden />

      {/* Rank + grip. Rally ranks by dragging the row and only "when the grid is set to the default
          sort order", which is the plan's own rank order — the same rule `useRowRerank` enforces on
          the Backlog, so the grip simply disappears under any other sort. */}
      <div
        style={colStyleFor('rank', { flexShrink: 0 })}
        className="flex items-center justify-end gap-1 px-2 text-muted-foreground tabular-nums"
      >
        {dragHandle}
        {position}
      </div>

      {/* The disclosure chevron sits with the ID, which is where every other grid in the app puts it
          (Iteration Status, Portfolio, the Teams tab's own team rows). It was in the NAME cell, whose
          width-preserving spacer then indented every Name 16px off its own heading — a gap with nothing
          in it on the rows that do not split.

          Disclosed only when there IS something nested: a Feature on one team has no breakdown to show,
          and an inert toggle on every row teaches the reader to ignore all of them. */}
      <div
        style={colStyleFor('id', { flexShrink: 0 })}
        className="flex min-w-0 items-center gap-1 px-2"
      >
        <RowExpandToggle
          expanded={expanded}
          onToggle={onToggleExpanded ?? (() => {})}
          label={
            expanded
              ? t('items.collapseTeams', { item: item.itemKey })
              : t('items.expandTeams', { item: item.itemKey })
          }
          disclosable={onToggleExpanded !== undefined && item.teamIds.length > 1}
          // Nothing to reserve when NO Feature on the plan is split: the column would be blank space in
          // front of every ID, lining up with nothing.
          reserveSpace={anySplitFeature}
        />
        <IdCell
          itemKey={item.itemKey}
          type="feature"
          onOpen={() => onOpenFeature(item.portfolioItemId)}
          href={entityDetailPath.portfolioItem(item.portfolioItemId)}
        />
      </div>

      <div style={colStyleFor('name', { flexShrink: 0 })} className="min-w-0 px-2">
        <span className="break-words whitespace-normal text-foreground" title={item.name}>
          {item.name}
        </span>
      </div>

      <div style={colStyleFor('assignment', { flexShrink: 0 })} className="min-w-0 px-2">
        {/* Rally's Planned Team Assignment: the team(s) this Feature is planned against in THIS
            plan. Unassigned carries a warning — it is demand with nowhere to go, and Rally flags
            it the same way. Allocated to SEVERAL teams, Rally shows the COUNT rather than one
            team's name, because no single name would be the answer; the nested rows below say
            which teams they are. */}
        {item.teamIds.length <= 1 && onAssign !== undefined ? (
          /* Rally: "You can select the project from this field to assign a portfolio item to a
             single project." A SPLIT Feature is read-only here — no single team is the answer, and
             Rally sends those edits through the Allocate dialog. The BA adds `Unassign` as the
             first option, which is the only way back to the yellow unassigned state. */
          <SearchableSelect
            value={item.primaryTeamId ?? ''}
            ariaLabel={t('items.assignmentLabel', { item: item.itemKey })}
            options={assignOptions}
            onChange={(v) => onAssign(v === '' || v === null ? null : v)}
            /* The trigger says `Not assigned`, in the BA's yellow, while the MENU offers `Unassign`.
               They are the same row of the list but not the same sentence: one is a state the plan is
               in, the other an action you can take — and without this the cell rendered the option's
               own label, so an unassigned Feature read as the verb "Unassign". */
            triggerContent={
              item.primaryTeamId === null ? (
                <span className="flex items-center gap-1" style={{ color: BRAND.warning }}>
                  <AlertTriangle size={12} />
                  <span className="text-ui-sm">{t('items.notAssigned')}</span>
                </span>
              ) : (
                /* The SAME `TeamCell` the Team column beside it renders. Left to the select's own
                   option label, an assigned team came out at `text-ui-sm` in the trigger and
                   `text-ui-xs` in the Team cell — one team, two sizes, in one row. */
                <TeamCell teamKey={teamKeyOf(item.primaryTeamId)} name={primaryTeamName} />
              )
            }
          />
        ) : item.primaryTeamId === null && item.teamIds.length === 0 ? (
          <span className="flex items-center gap-1" style={{ color: BRAND.warning }}>
            <AlertTriangle size={12} />
            <span className="text-ui-sm">{t('items.notAssigned')}</span>
          </span>
        ) : item.teamIds.length > 1 ? (
          /* A COUNT, which is the only honest answer for a split Feature — no single team name is it,
             and the nested rows beneath name them all.

             `2 teams`, not Rally's bare boxed `2`: SRS §155 is explicit that "the parent row shows
             `N teams`", and it says out loud what the box only implied. The bare digit needed its
             tooltip to be legible at all, which a screen reader never reached and a printout lost. */
          <span className="text-ui-sm text-foreground">
            {t('items.teamCount', { count: item.teamIds.length })}
          </span>
        ) : (
          /* Read-only (a published plan, or no `capacity:manage`): the same `TeamCell` the Team column
             beside it uses, so one team does not render two ways in one row. */
          <TeamCell teamKey={teamKeyOf(item.primaryTeamId)} name={primaryTeamName} />
        )}
      </div>

      {/* The BA's `Team`: who OWNS this Feature outside the plan. Distinct from the planned assignment
          beside it, and the pair is the point — a Feature owned by one team and planned against another
          is exactly the case a planner needs to see.

          The shared `TeamCell`, chip and all — the same rendering as the assignment cell beside it, the
          rail, Portfolio, Release Tracking and Epic Children. A brief glyph-less variant here made the
          derived column look different from the editable one, but the difference a reader needs is
          carried by the headings and by the picker's own chevron, not by drawing one team two ways. */}
      <div style={colStyleFor('team', { flexShrink: 0 })} className="min-w-0 px-2">
        <TeamCell teamKey={teamKeyOf(item.teamId)} name={item.teamName} />
      </div>

      {/* Rally's `Dependencies` count, drawn as Rally draws it: a small bordered CHIP holding the
          number, at the left of its column — not a bare right-aligned digit. The chip is what makes it
          read as a count of linked things rather than as another of the three metric columns beside it.

          `0`, not a dash: the BA's catalog says "it shows `0` until dependency modelling is added", and
          zero is the truthful count for a domain that models none — a dash would read as "unknown". */}
      <div style={colStyleFor('dependencies', { flexShrink: 0 })} className="px-2">
        <span className="inline-flex min-w-6 justify-center rounded border border-border-strong px-1 text-ui-xs text-muted-foreground tabular-nums">
          0
        </span>
      </div>

      {/* Three numeric columns, no bar: Rally draws none on this tab, and it is right not to —
          a Feature has no capacity, so a bar here would imply a ceiling that does not exist.
          Rollup → Estimated → Complete, which is Rally's order: the total, then what is planned
          against it, then what is done. */}
      {/* The BA's two Feature-level warnings, each ON the column it is about: `Rollup exceeds
          Estimated` beside Rollup, `Point Estimated missing` beside Estimated. Rendering both in one
          place would leave a planner guessing which number to fix. They were absent entirely until
          the API started returning item-level warnings — there was nothing here to reason from. */}
      <div
        style={colStyleFor('rollup', { flexShrink: 0 })}
        className="flex items-center justify-end gap-1 px-2"
      >
        <WarningIndicator labels={rollupWarning === null ? [] : [rollupWarning]} />
        <MetricValue value={item.rollup} pct={null} />
      </div>
      <div
        style={colStyleFor('estimated', { flexShrink: 0 })}
        className="flex items-center justify-end gap-1.5 px-2"
      >
        <WarningIndicator labels={estimateWarning === null ? [] : [estimateWarning]} />
        {/* The breakdown makes this the SAME three-row tooltip a team's sub-table shows, rather than a
            bare glyph: the tab can now say which tier produced the number and what the others were. */}
        <EstimateTierIcon tier={item.tier} breakdown={item.estimateBreakdown} />
        <span className="tabular-nums">{item.estimated}</span>
      </div>
      <div style={colStyleFor('complete', { flexShrink: 0 })} className="px-2 text-right">
        <MetricValue value={item.complete} pct={null} />
      </div>

      {/* Rally's per-item menu. `Remove From Plan` drops every team's allocation of the Feature; a
          trash can in a team's sub-table would instead remove it from ONE team while leaving it on
          the plan, which is a different decision and one Rally makes through the assignment
          field. */}
      <div
        style={colStyleFor('actions', { flexShrink: 0 })}
        className="flex items-center justify-center px-1"
      >
        {/* The shared gear, rendered identically in a team's sub-table on the Teams tab. */}
        <CapacityItemActions
          itemKey={item.itemKey}
          hasTeams={item.teamIds.length > 0}
          onMoveUp={onMoveUp}
          onMoveDown={onMoveDown}
          onAllocate={onAllocate}
          onMove={onMove}
          onUnassign={onUnassign}
          onRemove={onRemove}
        />
      </div>
    </div>
  )
}
