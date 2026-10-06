/**
 * The child rows revealed under an expanded Portfolio row.
 *
 * Two levels, because the disclosure is the SAME affordance in both cases and only the
 * child shape differs (Rally's Portfolio Item tree):
 *   • an Epic discloses its child **Features**   → `usePortfolioChildFeatures`
 *   • a Feature discloses its linked **Stories / Defects** → `usePortfolioChildren`
 *
 * Modelled on Iteration Status' expanded child Tasks: the same shared
 * `RowExpandToggle` in the parent's ID cell, the same dashed child-row divider, the
 * same 2px hierarchy rail drawn as an INSET SHADOW rather than a left border — a
 * border would push every child cell 2px right and break alignment with the sticky
 * header. Child cells reuse the parent's `colStyleFor`, so resizing, reordering or
 * hiding a column moves the child cells with it for free.
 *
 * Mounted only while expanded, which is also what gates the fetch: both hooks are
 * `enabled` on a defined id, so an unmounted child list never queries. No page-level
 * expanded-id registry is needed.
 *
 * ── Both levels edit inline, through DIFFERENT APIs ──────────────────────────
 * Matching Iteration Status, where a disclosed child Task edits in place just like its
 * parent Story.
 *
 * A child **Feature** is a full `PortfolioItemResponseDto`, so it writes through
 * `useUpdatePortfolioItem` — the same hook and cells as a top-level row.
 *
 * A child **Story / Defect** is a work item, so it writes through `useUpdateWorkItem`.
 * That level used to be read-only because `PortfolioChildResponseDto` returned display
 * NAMES with no corresponding ids, leaving a picker nothing to bind its value to. The
 * joins were already in the query; only the names were selected. Surfacing
 * `projectId` / `releaseId` / `teamId` / `assigneeId` was the whole fix.
 *
 * Consequence worth knowing: the State column carries two vocabularies by depth —
 * portfolio state on a Feature, SCHEDULE state on a Story — and Percent Done stays empty
 * on a Story, because a single work item has no rollup of its own.
 */
import { useTranslation } from 'react-i18next'
import { type CSSProperties } from 'react'
import { useNavigate } from '@tanstack/react-router'

import {
  usePortfolioChildFeatures,
  usePortfolioChildren,
  useUpdatePortfolioItem,
  type PortfolioChild,
  type PortfolioItem,
  type PortfolioItemState,
} from '@/features/portfolio/api'
import { IdCell } from '@/entities/work-item/ui/id-cell'
import { PercentDoneBar } from '@/features/portfolio/ui/percent-done-bar'
import { portfolioStateColor } from '@/features/portfolio/status-colors'
import { InlineEditableCell } from '@/shared/ui/inline-editable-cell'
import { OwnerCell, OwnerSelectCell, type OwnerSelectMember } from '@/shared/ui/owner-cell'
import { ProjectCell } from '@/shared/ui/project-cell'
import { TeamCell } from '@/shared/ui/team-cell'
import { SearchableSelect } from '@/shared/ui/searchable-select'
import { ReleaseSelectCell, TeamSelectCell } from './attribute-cells'
import { type PortfolioCellOptions } from '../model/cell-options'
import { RowGutter } from '@/shared/ui/row-gutter'
import { Spinner } from '@/shared/ui/spinner'
import { NESTED_ROW_INDENT } from '@/shared/config/layout'
import { EMPTY_VALUE } from '@/shared/lib/utils'
import { useFieldCommit } from '@/shared/lib/hooks/use-field-commit'
import { type ColKey } from '../model/columns'
import { PORTFOLIO_STATES } from '../model/portfolio-states'
import { entityDetailPath } from '@/shared/lib/entity-link'

type ColStyleFor = (key: ColKey, base?: CSSProperties) => CSSProperties

/**
 * One child row shell — the leading gutter that makes the child's cells line up under
 * the parent's columns, then the caller's cells.
 *
 * Padding (`px-3`) and the gutter deliberately match `PortfolioRow` exactly; that pair
 * is what keeps a child cell under its own column heading. The dashed divider and
 * smaller type are the only intentional differences, marking the row as subordinate.
 */
function ChildRow({ children }: { children: React.ReactNode }) {
  return (
    // Height and type scale MATCH the parent row (`min-h-[35px]`, `text-ui-md`), not a
    // smaller variant. They diverged before, which made every editable control on a child
    // row visibly smaller than the identical control one row above — the inline-edit box
    // most obviously. Subordination is carried by the indent, the dashed divider and the
    // tinted rail; shrinking the controls as well just made them look like a different
    // component.
    <div
      // A stable hook for the AC-5 cap: "up to 5 linked items". Counting rendered rows is the only
      // way to assert a cap as a property rather than against a fixture's child count.
      data-child-preview-row=""
      className="flex min-h-[35px] items-center border-b border-dashed border-border-subtle px-3 text-ui-md text-muted-foreground hover:bg-primary-lighter"
    >
      {/* Mirrors the parent's gutter through the shared component (inert here — a child
          is not selectable and not rankable) so column 1 starts at the same x. */}
      <RowGutter dragDisabled />
      {children}
    </div>
  )
}

/**
 * A disclosed child Feature — the same row as a top-level Feature, one level in.
 *
 * Its own component (not a `.map()` body) because it owns a mutation hook: one
 * `useUpdatePortfolioItem` per row is what lets each row report its own success and
 * error, exactly as `PortfolioRow` and Iteration Status' `ChildTaskRow` do.
 */
function ChildFeatureRow({
  feature,
  colStyleFor,
  members,
  canEdit,
  options,
  projectKeyFor,
  onOpen,
}: {
  feature: PortfolioItem
  colStyleFor: ColStyleFor
  members: OwnerSelectMember[]
  canEdit: boolean
  /** Release/Team options for THIS child's project, which may differ from its Epic's. */
  options: PortfolioCellOptions
  /** The `KeyChip` glyph for a project id — a lookup for the READ-ONLY Project cell. */
  projectKeyFor: (projectId: string) => string | null
  onOpen: (id: string) => void
}) {
  const { t } = useTranslation('portfolio')
  const update = useUpdatePortfolioItem()

  const { save: commit } = useFieldCommit(update)

  function save(patch: Parameters<typeof update.mutate>[0]['patch'], success: string) {
    commit({ id: feature.id, patch }, success)
  }

  return (
    <ChildRow>
      {/* Rank is BLANK on a child Feature — FR-038 and §60: "their order is contextual to the parent
          preview", so a number here would claim a position in a list this row is not part of. The cell
          is still rendered, or every column after it shifts left. */}
      <div className="px-2" style={colStyleFor('rank')} />

      <div className={`flex items-center pr-2 ${NESTED_ROW_INDENT}`} style={colStyleFor('id')}>
        <IdCell
          type={feature.type}
          itemKey={feature.itemKey}
          onOpen={() => onOpen(feature.id)}
          href={entityDetailPath.portfolioItem(feature.id)}
        />
      </div>

      <div
        className="min-w-0 px-0"
        style={colStyleFor('name')}
        onClick={(e) => e.stopPropagation()}
      >
        <InlineEditableCell
          fullCell
          value={feature.name}
          canEdit={canEdit}
          onCommit={(v) => {
            const next = v.trim()
            if (next && next !== feature.name) save({ name: next }, t('row.nameUpdated'))
          }}
          ariaLabel={t('columns.name')}
          title={feature.name}
          className="block w-full break-words whitespace-normal text-foreground"
        />
      </div>

      <div
        className="min-w-0 px-0"
        style={colStyleFor('state')}
        onClick={(e) => e.stopPropagation()}
      >
        <SearchableSelect
          variant="cell"
          value={feature.state}
          readOnly={!canEdit}
          ariaLabel={t('filters.state')}
          options={PORTFOLIO_STATES.map((s) => ({ value: s, label: t(`states.${s}`) }))}
          triggerContent={
            <span style={{ color: portfolioStateColor(feature.state) }}>
              {t(`states.${feature.state}`)}
            </span>
          }
          onChange={(v) => {
            if (v && v !== feature.state)
              save({ state: v as PortfolioItemState }, t('row.stateUpdated'))
          }}
        />
      </div>

      <div
        className="flex min-w-0 items-center overflow-hidden px-0"
        style={colStyleFor('release')}
        onClick={(e) => e.stopPropagation()}
      >
        <ReleaseSelectCell
          releaseId={feature.releaseId}
          releaseName={feature.releaseName}
          releases={options.releases}
          canEdit={canEdit}
          ariaLabel={t('detail.fields.release')}
          onChange={(v) => {
            if (v !== feature.releaseId) save({ releaseId: v }, t('row.releaseUpdated'))
          }}
        />
      </div>

      {/* A child Feature carries its OWN rollup, so both progress bars are real here. */}
      <div className="min-w-0 px-2" style={colStyleFor('percentDonePoints')}>
        <PercentDoneBar
          metric="points"
          health={feature.health}
          progress={feature.progress}
          rollup={feature.rollup}
        />
      </div>
      <div className="min-w-0 px-2" style={colStyleFor('percentDoneCount')}>
        <PercentDoneBar
          metric="count"
          health={feature.health}
          progress={feature.progress}
          rollup={feature.rollup}
        />
      </div>

      {/* Project — READ-ONLY, exactly as on the root row above it (§3.1: "Project is read-only
          for both types"). This was a `ProjectSelectCell` PATCHing `projectId`, i.e. a
          cross-project MOVE offered on a row the SRS describes as an inline PREVIEW. */}
      <div className="min-w-0 px-2" style={colStyleFor('project')}>
        <ProjectCell
          projectKey={projectKeyFor(feature.projectId)}
          projectName={feature.projectName}
        />
      </div>
      <div
        className="flex min-w-0 items-center overflow-hidden px-0"
        style={colStyleFor('team')}
        onClick={(e) => e.stopPropagation()}
      >
        <TeamSelectCell
          teamId={feature.teamId}
          teamName={feature.teamName}
          teams={options.teams}
          canEdit={canEdit}
          ariaLabel={t('detail.fields.team')}
          onChange={(v) => {
            if (v !== feature.teamId) save({ teamId: v }, t('row.teamUpdated'))
          }}
        />
      </div>

      <div
        className="min-w-0 overflow-hidden px-0"
        style={colStyleFor('owner')}
        onClick={(e) => e.stopPropagation()}
      >
        <OwnerSelectCell
          ownerName={feature.ownerName}
          assigneeId={feature.ownerId}
          members={members}
          canEdit={canEdit}
          ariaLabel={t('detail.fields.owner')}
          onChange={(v) => {
            if (v !== feature.ownerId) save({ ownerId: v }, t('row.ownerUpdated'))
          }}
        />
      </div>
    </ChildRow>
  )
}

/**
 * A disclosed Story / Defect — a READ-ONLY preview, exactly as §61 defines it.
 *
 * "Type, ID, Name, Release, Project, Team, Owner are shown; **State and the two Percent Done columns
 * are intentionally left blank in this preview** … the preview rows themselves are not inline-editable
 * and do not navigate anywhere on click." §252 and AC-5 say the same twice more, and give the reason:
 * the Children tab and the item's own detail cover both in depth, and here they were judged clutter.
 *
 * It used to be a fully editable row — a schedule-state picker, an inline name editor, Release, Team
 * and Owner selects, and an ID that navigated. Five controls in a five-row preview, none of which the
 * spec asks for, and the State one showed a SECOND vocabulary in a column whose parent rows show
 * portfolio states.
 *
 * Percent Done was already blank for its own reason (a single work item has no rollup), which is the
 * same conclusion the spec reaches.
 */
function ChildWorkItemRow({
  child,
  colStyleFor,
  options,
  projectKeyFor,
}: {
  child: PortfolioChild
  colStyleFor: ColStyleFor
  /**
   * The child's own project's Teams, for the team KEY.
   *
   * The child payload names its team but does not carry the key, and `TeamAvatar` falls back to
   * initials — so the same team drew `TG` on a preview row and `GA` (from key `GAMMA`) on its parent
   * one line up. Same team, two glyphs. The key is resolved here rather than added to the DTO because
   * the page has already fetched it for the parent row's picker.
   */
  options: PortfolioCellOptions
  /** The project KEY for a project id — same reason as the team key. */
  projectKeyFor: (projectId: string) => string | null
}) {
  const teamKey = options.teams.find((tm) => tm.id === child.teamId)?.key ?? null
  const projectKey = projectKeyFor(child.projectId)
  /** A plain text cell, for the columns that have no entity component of their own. */
  const cell = (col: ColKey, value: string | null) => (
    <div className="min-w-0 px-2 break-words whitespace-normal" style={colStyleFor(col)}>
      {value ?? EMPTY_VALUE}
    </div>
  )

  /**
   * The related-entity columns render through the SAME components the parent rows use, in their
   * read-only form: `ProjectCell`, `TeamCell`, `OwnerCell`, and `ReleaseSelectCell`'s name-only branch.
   *
   * They were bare text, so a preview row lost every glyph its parent carried — no release badge, no
   * team chip, no avatar — and read as a different kind of table. Subordination here is carried by the
   * tint and the indent, which is the rule the row already follows; dropping the glyphs was carrying it
   * twice.
   */
  const entityCell = (col: ColKey, content: React.ReactNode) => (
    <div className="flex min-w-0 items-center px-2" style={colStyleFor(col)}>
      {content}
    </div>
  )

  return (
    <ChildRow>
      {/* Blank Rank: a preview row has no position of its own to report (§466 says the same of a
          child Feature). The cell is still rendered, or every column after it would shift left. */}
      <div className="px-2" style={colStyleFor('rank')} />

      <div className={`flex items-center pr-2 ${NESTED_ROW_INDENT}`} style={colStyleFor('id')}>
        {/* `IdCell` with NO `onOpen`: §61 is explicit that these rows do not navigate, and the
            handler-less form renders the same glyph and 12px key as a plain muted span. The pair was
            hand-rolled here with a 16px badge and a 10px key, which is why a preview ID read smaller
            than its parent's. */}
        <IdCell type={child.type} itemKey={child.itemKey} />
      </div>

      {cell('name', child.title)}
      {/* State: deliberately blank. */}
      <div className="px-2" style={colStyleFor('state')} />
      {entityCell(
        'release',
        <ReleaseSelectCell
          releaseName={child.releaseName}
          releases={[]}
          canEdit={false}
          ariaLabel=""
          onChange={() => {}}
        />,
      )}
      {/* Percent Done ×2: blank, for the same reason and by the same rule. */}
      <div className="px-2" style={colStyleFor('percentDonePoints')} />
      <div className="px-2" style={colStyleFor('percentDoneCount')} />
      {entityCell(
        'project',
        <ProjectCell projectKey={projectKey} projectName={child.projectName} />,
      )}
      {entityCell('team', <TeamCell teamKey={teamKey} name={child.teamName} />)}
      {entityCell('owner', <OwnerCell name={child.ownerName} />)}
    </ChildRow>
  )
}

/**
 * Rally's inline preview shows at most five linked items (SRS:61, FR-006, AC-5).
 *
 * A cap, not pagination: the disclosure answers "what is under here" at a glance, and the Children
 * tab is where the full, sortable, searchable list lives.
 */
const CHILD_PREVIEW_LIMIT = 5

export function PortfolioChildRows({
  item,
  colStyleFor,
  members,
  canEditProject,
  optionsFor,
  projectKeyFor,
}: {
  item: PortfolioItem
  /** The parent grid's resolved per-column style, so child cells track column layout. */
  colStyleFor: ColStyleFor
  /** Workspace roster for the Owner picker, fetched once by the page. */
  members: OwnerSelectMember[]
  /**
   * Edit rights for a given project — resolved per CHILD, not inherited from the parent
   * row: a child Feature may sit in a different project than the Epic above it on this
   * cross-project grid.
   */
  canEditProject: (projectId: string) => boolean
  /** Release/Team options by project, resolved per child for the same reason. */
  optionsFor: (projectId: string) => PortfolioCellOptions
  /** The `KeyChip` glyph for a project id — a lookup for the READ-ONLY Project cells. */
  projectKeyFor: (projectId: string) => string | null
}) {
  const { t } = useTranslation('portfolio')
  const navigate = useNavigate()
  const isEpic = item.type === 'epic'

  // Only one of the two fires: the other is handed `undefined` and stays disabled.
  const features = usePortfolioChildFeatures(isEpic ? item.id : undefined)
  const children = usePortfolioChildren(isEpic ? undefined : item.id)
  const { isLoading } = isEpic ? features : children

  const openPortfolioItem = (id: string) =>
    void navigate({ to: '/portfolio/$itemId', params: { itemId: id } })

  const rows = isEpic
    ? (features.data ?? []).map((f) => (
        <ChildFeatureRow
          key={f.id}
          feature={f}
          colStyleFor={colStyleFor}
          members={members}
          canEdit={canEditProject(f.projectId)}
          options={optionsFor(f.projectId)}
          projectKeyFor={projectKeyFor}
          onOpen={openPortfolioItem}
        />
      ))
    : (children.data ?? [])
        .slice(0, CHILD_PREVIEW_LIMIT)
        .map((c) => (
          <ChildWorkItemRow
            key={c.id}
            child={c}
            colStyleFor={colStyleFor}
            options={optionsFor(c.projectId)}
            projectKeyFor={projectKeyFor}
          />
        ))

  /**
   * How many linked items the preview is NOT showing.
   *
   * "If more than 5 items are linked, a static `+N more - see Children tab` line is shown; it is
   * not clickable" (SRS:61, FR-006, AC-5). A disclosure that listed every child turned a quick
   * peek into an unbounded list inside the grid — the Children tab is the place that pages.
   *
   * Only the Story/Defect preview is capped. An Epic's disclosure reveals its child FEATURES
   * (§11.3), which the BA does not cap, and a Feature count per Epic is bounded by planning
   * rather than by delivery volume.
   */
  const hiddenChildren = isEpic
    ? 0
    : Math.max(0, (children.data?.length ?? 0) - CHILD_PREVIEW_LIMIT)

  return (
    <div className="bg-surface-hover shadow-[inset_2px_0_0_var(--primary-lighter)]">
      {isLoading ? (
        <div className="flex items-center gap-1.5 py-1.5 pl-11 text-ui-xs text-foreground-subtle">
          <Spinner size="sm" />
          {t('row.loadingChildren')}
        </div>
      ) : rows.length === 0 ? (
        <div className="py-1.5 pl-11 text-ui-xs text-foreground-subtle">
          {isEpic ? t('row.noChildFeatures') : t('row.noChildItems')}
        </div>
      ) : (
        <>
          {rows}
          {hiddenChildren > 0 && (
            /* STATIC, and deliberately not a link: "it is not clickable" (AC-5). Making it one
               would offer a second route to the Children tab from a row whose own click target is
               the ID cell, and the BA is explicit that the preview navigates nowhere. */
            <div className="py-1.5 pl-11 text-ui-xs text-foreground-subtle">
              {t('row.morePreviewItems', { count: hiddenChildren })}
            </div>
          )}
        </>
      )}
    </div>
  )
}
