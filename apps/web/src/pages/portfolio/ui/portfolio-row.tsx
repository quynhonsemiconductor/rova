import { type CSSProperties, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  useUpdatePortfolioItem,
  type PortfolioItem,
  type PortfolioItemState,
} from '@/features/portfolio/api'
import { IdCell } from '@/entities/work-item/ui/id-cell'
import { OwnerSelectCell, type OwnerSelectMember } from '@/shared/ui/owner-cell'
import { PercentDoneBar } from '@/features/portfolio/ui/percent-done-bar'
import { InlineEditableCell } from '@/shared/ui/inline-editable-cell'
import { useSortable } from '@dnd-kit/sortable'

import { RowGutter } from '@/shared/ui/row-gutter'
import { useDragRowStyle, TableRow } from '@/shared/ui/table'
import { EMPTY_VALUE } from '@/shared/lib/utils'
import { RankCell } from '@/shared/ui/table'
import { portfolioStateColor } from '@/features/portfolio/status-colors'
import { RowExpandToggle } from '@/shared/ui/row-expand-toggle'
import { BRAND } from '@/shared/config/brand'
import { SearchableSelect } from '@/shared/ui/searchable-select'
import { useFieldCommit } from '@/shared/lib/hooks/use-field-commit'
import { type ColKey } from '../model/columns'
import { PORTFOLIO_STATES } from '../model/portfolio-states'
import { hasChildren } from '../model/children'
import { PortfolioChildRows } from './portfolio-child-rows'
import { ReleaseSelectCell, TeamSelectCell } from './attribute-cells'
import { ProjectCell } from '@/shared/ui/project-cell'
import { type PortfolioCellOptions } from '../model/cell-options'
import { entityDetailPath } from '@/shared/lib/entity-link'

/**
 * One Portfolio grid row.
 *
 * EVERY writable field edits in place, each through the shared cell for its attribute
 * type: Name, State, Epic, Release, Team, Owner, Preliminary Estimate and Refined
 * Estimate. `canEdit` is decided per ROW rather than per page: this list is
 * cross-project, so the answer differs between rows and a page-level flag would either
 * hide actions the user has elsewhere or offer ones they do not.
 *
 * What is NOT editable, and why — both are constraints, not omissions:
 *   • **Project** — read-only for every row and every role. §3.1's field table: "Inherited from
 *     the current Project context at creation and read-only afterward for both Feature and Epic";
 *     its inline-edit line: "Project is read-only for both types". The PATCH still accepts
 *     `projectId` and the service still implements the move (`applyProjectMove` resets the Team
 *     and drops a Release or parent Epic belonging to the old project), but nothing in the SPA
 *     reaches it — see `shared/ui/project-cell.tsx` for why the editable cell was deleted rather
 *     than gated.
 *   • **Percent Done ×2** — derived server-side from child rollups. There is nothing to
 *     write; you change them by accepting child work.
 *
 * Epic, Release and Team read as empty on an Epic ROW and offer no picker: all three are
 * Feature-only by CHECK constraint, so a write there is one the database refuses.
 *
 * Every attribute column renders through the SHARED cell for its attribute type rather
 * than a local `<span>` — the Backlog's `SearchableSelect` cell for the Release, the
 * square chip for the Team, `OwnerSelectCell` for the person. A span per column is how a grid drifts: the glyph,
 * the truncation, the disabled-dash colour and the link affordance all have to match the
 * other 8 grids, and only the shared component guarantees that.
 *
 * This grid does NOT drag. §14 lists "drag-and-drop Rank reordering" under Not included and §37 makes
 * Rank "up/down reorder buttons only", so the gutter carries the selection checkbox alone and the
 * reorder controls live in the Rank cell beside the number they change. The row still renders its own
 * `RowGutter` from `gutterProps`, which is now just a checkbox plus the width every grid shares.
 */
export function PortfolioRow({
  item,
  rowNum,
  canRank,
  canEdit,
  members,
  canEditProject,
  options,
  optionsFor,
  projectKeyFor,
  revealed = false,
  colStyleFor,
  gutterProps,
  onOpen,
}: {
  item: PortfolioItem
  /** 1-based position in the list, page offset included — the `Rank` column's value. */
  rowNum: number
  /**
   * The BA's up/down reorder handlers (§37, FR-005), absent at the ends of the list and while a
   * column sort is active — the running order means nothing under any other sort.
   */
  /** Highlighted because the user was just sent here — see the scaffold's `revealRowId`. */
  revealed?: boolean
  canEdit: boolean
  /** Workspace roster for the Owner picker; fetched once by the page, not per row. */
  members: OwnerSelectMember[]
  /**
   * Edit rights for an arbitrary project, for the DISCLOSED child rows. `canEdit` above
   * answers only for this row's own project; a child Feature may sit in another one on
   * this cross-project grid, so the children need the lookup rather than the answer.
   */
  canEditProject: (projectId: string) => boolean
  /** Epic/Release/Team options for THIS row's project. */
  options: PortfolioCellOptions
  /**
   * The `KeyChip` glyph for a project id, for the read-only Project column here and on the
   * disclosed child rows.
   *
   * A LOOKUP, not an option list. It replaced `projects: ProjectOption[]`, which was described as
   * "move destinations — workspace-wide, since a move targets a DIFFERENT project" and fed a
   * `ProjectSelectCell` that no longer exists (§3.1: "Project is read-only for both types"). The
   * item DTO carries `projectName` but no key, so the page resolves it once for every row.
   */
  projectKeyFor: (projectId: string) => string | null
  /** The same lookup by project, for the disclosed child rows. */
  optionsFor: (projectId: string) => PortfolioCellOptions
  colStyleFor: (key: ColKey, base?: CSSProperties) => CSSProperties
  /** Gutter configuration from the list scaffold; the row renders the gutter itself. */
  /** Drag-to-rank allowed for THIS row: rank order active, and edit rights on its project. */
  canRank: boolean
  gutterProps: {
    stopPropagation: true
    checkbox?: { checked: boolean; onChange: () => void; ariaLabel: string }
  }
  onOpen: (id: string) => void
}) {
  const { t } = useTranslation('portfolio')
  const { progress, rollup } = item
  const update = useUpdatePortfolioItem()
  /**
   * Disclosure state, held per ROW rather than as a page-level id set.
   *
   * The child list is only mounted while open, and both child queries are `enabled` on a
   * defined id, so "closed" already means "not fetched" — a registry in the page would
   * add a second source of truth for the same fact. Same shape as Iteration Status.
   */
  const [expanded, setExpanded] = useState(false)
  const {
    setNodeRef,
    setActivatorNodeRef,
    listeners,
    attributes,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id })
  const dragStyle = useDragRowStyle({ transform, transition, isDragging })
  const expandable = hasChildren(item)

  // Shared commit helper: fire the mutation with the standard success/error toasts.
  const { save: commit } = useFieldCommit(update)

  function save(patch: Parameters<typeof update.mutate>[0]['patch'], success: string) {
    commit({ id: item.id, patch }, success)
  }

  return (
    <>
      <TableRow
        ref={setNodeRef}
        className="px-3"
        // Named so a test can find the row the user was just sent to, and so a screen reader is
        // not told about a purely visual hint.
        data-revealed={revealed || undefined}
        // The drag transform and the reveal highlight share one `style`: the shared
        // `useDragRowStyle` supplies transform/transition/opacity, and the reveal colour is layered
        // on top so a row that is both dragged and revealed keeps both.
        style={{ ...dragStyle, backgroundColor: revealed ? BRAND.accentBg : undefined }}
        /** An explicit handle for tests, which is what they should locate rows by. */
        data-portfolio-row={item.id}
      >
        <RowGutter
          ref={setActivatorNodeRef}
          dragListeners={listeners}
          dragAttributes={attributes}
          dragDisabled={!canRank}
          {...gutterProps}
        />

        {/* Rank, with the up/down controls (§37, FR-005). Its own cell rather than the gutter: the
            number is a column FR-002 names, and the buttons belong next to what they change. */}
        <RankCell rowNum={rowNum} style={colStyleFor('rank', { flexShrink: 0 })} />

        {/* ID — the disclosure chevron sits to the LEFT of the type glyph (Rally parity,
          same placement as Iteration Status), then the same TypeBadge + key cell as
          US/DE/RE carrying EP-/FE-. A row with nothing to disclose gets a same-width
          spacer instead of a dead chevron, so every ID cell still starts at one x. */}
        <div
          style={colStyleFor('id', { flexShrink: 0 })}
          className="flex items-center gap-1.5 px-2"
        >
          {expandable ? (
            <RowExpandToggle
              expanded={expanded}
              onToggle={() => setExpanded(!expanded)}
              label={
                expanded
                  ? t(item.type === 'epic' ? 'row.collapseFeatures' : 'row.collapseItems')
                  : t(item.type === 'epic' ? 'row.expandFeatures' : 'row.expandItems')
              }
            />
          ) : (
            <span className="w-3 shrink-0" aria-hidden />
          )}
          <IdCell
            type={item.type}
            itemKey={item.itemKey}
            onOpen={() => onOpen(item.id)}
            href={entityDetailPath.portfolioItem(item.id)}
          />
        </div>

        <div
          style={colStyleFor('name', { flexShrink: 0 })}
          className="min-w-0 px-0"
          onClick={(e) => e.stopPropagation()}
        >
          <InlineEditableCell
            fullCell
            value={item.name}
            canEdit={canEdit}
            onCommit={(v) => {
              const next = v.trim()
              if (next && next !== item.name) save({ name: next }, t('row.nameUpdated'))
            }}
            ariaLabel={t('columns.name')}
            title={item.name}
            className="block w-full break-words whitespace-normal text-foreground"
          />
        </div>

        <div
          style={colStyleFor('state', { flexShrink: 0 })}
          className="min-w-0 px-0"
          onClick={(e) => e.stopPropagation()}
        >
          {/* The state reads as a BADGE, like every other entity's does — `StatusBadge` had no usages
              under `pages/portfolio/**` at all, so the one vocabulary with eleven values was the one
              rendered as bare text. The select is still the editor; only its trigger changes. */}
          <SearchableSelect
            variant="cell"
            value={item.state}
            readOnly={!canEdit}
            ariaLabel={t('filters.state')}
            options={PORTFOLIO_STATES.map((s) => ({ value: s, label: t(`states.${s}`) }))}
            // Plain COLOURED TEXT, no chip: Rally prints a portfolio state as text, and a pill inside a
            // picker's trigger read as a second control. The colour comes from the one shared phase map,
            // so the state means the same here, on the child rows, in the rail and inside a plan.
            triggerContent={
              <span style={{ color: portfolioStateColor(item.state) }}>
                {t(`states.${item.state}`)}
              </span>
            }
            onChange={(v) => {
              if (v && v !== item.state)
                save({ state: v as PortfolioItemState }, t('row.stateUpdated'))
            }}
          />
        </div>

        {/* Release — the Backlog's release cell (glyph + `RE-1: name`). */}
        <div
          style={colStyleFor('release', { flexShrink: 0 })}
          className="flex min-w-0 items-center overflow-hidden px-0"
          onClick={(e) => e.stopPropagation()}
        >
          <ReleaseSelectCell
            releaseId={item.releaseId}
            releaseName={item.releaseName}
            releases={options.releases}
            canEdit={canEdit && item.type !== 'epic'}
            ariaLabel={t('detail.fields.release')}
            onChange={(v) => {
              if (v !== item.releaseId) save({ releaseId: v }, t('row.releaseUpdated'))
            }}
          />
        </div>

        {/* Percent Done by Plan Estimate — accepted points over rolled-up points.
          Coloured by the item's Rally status, not by the ratio: see PercentDoneBar. */}
        <div style={colStyleFor('percentDonePoints', { flexShrink: 0 })} className="min-w-0 px-2">
          <PercentDoneBar
            metric="points"
            health={item.health}
            progress={progress}
            rollup={rollup}
          />
        </div>

        {/* Percent Done by Count — accepted children over total children. */}
        <div style={colStyleFor('percentDoneCount', { flexShrink: 0 })} className="min-w-0 px-2">
          <PercentDoneBar metric="count" health={item.health} progress={progress} rollup={rollup} />
        </div>

        {/* Project — READ-ONLY, for every row and every role.
          §3.1's field table says "Inherited from the current Project context at creation and
          read-only afterward for both Feature and Epic", and its inline-edit line repeats it:
          "Project is read-only for both types". This cell used to be a `SearchableSelect` that
          PATCHed `projectId` — a cross-project MOVE that also reset the row's Team and dropped a
          Release or parent Epic belonging to the old project — under a comment claiming §3.1
          required it editable. It required the opposite. No `stopPropagation` wrapper any more
          either: with nothing to click, the cell should open the row like the rest of it. */}
        <div style={colStyleFor('project', { flexShrink: 0 })} className="min-w-0 px-2">
          <ProjectCell projectKey={projectKeyFor(item.projectId)} projectName={item.projectName} />
        </div>

        {/* Team — square key-chip + name (circle = person, square = team). Picker over the
          teams LINKED to this project: an unlinked team is not a legal assignment. */}
        <div
          style={colStyleFor('team', { flexShrink: 0 })}
          className="flex min-w-0 items-center overflow-hidden px-0"
          onClick={(e) => e.stopPropagation()}
        >
          {/* An EPIC has no Team, and §46 says what belongs here instead: "Epic has no Team and shows
              child Feature count where applicable". It rendered a disabled picker resolving to `--`,
              which read as "no team assigned" for a level that cannot have one. The count is already
              on the wire and already drives the disclosure chevron. */}
          {item.type === 'epic' ? (
            /* ITALIC, and at the same 11px the team cells beside it use: `1 Feature` is a COUNT standing
               in for a value this level does not have, and in upright text the same size as a team name
               it read as a team called "1 Feature". Italic is how the rest of the app marks a derived
               stand-in (the `↳ Allocation` child rows do the same). */
            <span className="truncate px-2 text-ui-sm text-muted-foreground italic">
              {item.childFeatureCount > 0
                ? t('row.childFeatureCount', { count: item.childFeatureCount })
                : EMPTY_VALUE}
            </span>
          ) : (
            <TeamSelectCell
              teamId={item.teamId}
              teamName={item.teamName}
              teams={options.teams}
              canEdit={canEdit}
              ariaLabel={t('detail.fields.team')}
              onChange={(v) => {
                if (v !== item.teamId) save({ teamId: v }, t('row.teamUpdated'))
              }}
            />
          )}
        </div>

        {/* Owner — the shared person cell: searchable member picker when the caller may
          edit THIS row's project, initials chip + name when not. Same component as
          Iteration Status / Team Status / Projects. */}
        <div
          style={colStyleFor('owner', { flexShrink: 0 })}
          className="min-w-0 overflow-hidden px-0"
          onClick={(e) => e.stopPropagation()}
        >
          <OwnerSelectCell
            ownerName={item.ownerName}
            assigneeId={item.ownerId}
            members={members}
            canEdit={canEdit}
            ariaLabel={t('detail.fields.owner')}
            onChange={(v) => {
              if (v !== item.ownerId) save({ ownerId: v }, t('row.ownerUpdated'))
            }}
          />
        </div>
      </TableRow>

      {/* Children — an Epic discloses its Features, a Feature its Stories/Defects. A
          SIBLING of the row, not a descendant: the row is the dnd-kit sortable node, so
          nesting the children inside it would drag them with the parent. */}
      {expanded && (
        <PortfolioChildRows
          item={item}
          colStyleFor={colStyleFor}
          members={members}
          canEditProject={canEditProject}
          optionsFor={optionsFor}
          projectKeyFor={projectKeyFor}
        />
      )}
    </>
  )
}
