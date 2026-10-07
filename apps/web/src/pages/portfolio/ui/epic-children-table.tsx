import { EMPTY_VALUE } from '@/shared/lib/utils'
import { Fragment, useCallback, useMemo, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { useSortable } from '@dnd-kit/sortable'
import { toast } from 'sonner'

import {
  useDataTable,
  useRowRerank,
  useDragRowStyle,
  SelectableTable,
  RankCell,
  TableRow,
} from '@/shared/ui/table'
import { TableTotalsRow } from '@/shared/ui/table-totals-row'
import { useProjectTeams } from '@/features/teams/api'
import { portfolioStateColor } from '@/features/portfolio/status-colors'
import { Plus } from 'lucide-react'

import { Button } from '@/shared/ui/button'
import { PageToolbar } from '@/shared/ui/page-toolbar'
import { ColumnFieldsMenu } from '@/shared/ui/column-fields-menu'
import { InlineSelect } from '@/shared/ui/native-select'
import { EmptyState } from '@/shared/ui/empty-state'
import { RowGutter } from '@/shared/ui/row-gutter'
import { RowExpandToggle } from '@/shared/ui/row-expand-toggle'
import { TeamCell } from '@/shared/ui/team-cell'
import { OwnerCell } from '@/shared/ui/owner-cell'
import { IdCell } from '@/entities/work-item/ui/id-cell'
import { useTableSort, type SortDir } from '@/shared/lib/hooks/use-table-sort'
import {
  useRankPortfolioItem,
  usePortfolioChildren,
  type PortfolioItem,
} from '@/features/portfolio/api'
import { EPIC_CHILD_COLUMNS, type EpicChildColKey } from '../model/children-columns'
import { entityDetailPath } from '@/shared/lib/entity-link'

type EpicSortField = 'itemKey' | 'name' | 'team' | 'state' | 'owner'

const text = (value: string | null): string => value ?? ''

/**
 * An Epic's child FEATURES, with the roll-ups the BA lists: Rank, ID, Name, Team, State, Complete,
 * Rollup, Estimated, Owner.
 *
 * A different question from a Feature's Children, which are Stories and Defects — so a different
 * column set, not a parameter on one table. An Epic owns no story-level work directly; its numbers are
 * its Features' roll-ups, which is why Complete/Rollup/Estimated appear here where the Feature's tab
 * shows Priority/Iteration.
 *
 * The SHELL, though, is the one every complex grid uses: `SelectableTable` owns the select-all
 * gutter, the bulk bar and the dnd wrapper, exactly as it does for Backlog, Iteration Status and the
 * Work Item Tasks tab. This tab used a bare `DataTableFrame` instead, so it had no selection, no
 * drag and no skeleton — while the Portfolio LIST, rendering the same entity through the same rank
 * endpoint, had all three.
 *
 * `Complete` is `completedPoints` (COMPLETED_SCHEDULE_STATES) rather than `acceptedPoints`: on a
 * capacity-shaped reading, Complete means the team FINISHED it. The Portfolio's own Percent Done
 * columns use the accepted-only rule, and the two are documented as the D1 distinction — mixing them
 * in one grid would put two different meanings under one heading.
 *
 * `Rank` is the row's position in the list, not the LexoRank string, which sorts as text and means
 * nothing to a reader.
 */
export function EpicChildrenTable({
  features,
  projectId,
  canEdit = false,
  isLoading = false,
  onAddFeature,
}: {
  features: PortfolioItem[]
  /**
   * The Epic's project, for the team KEY behind each child's team chip.
   *
   * The child payload names the team and carries its id but no key, and `TeamAvatar` falls back to the
   * name's initials — so one team drew `TG` here and `GA` (from key `GAMMA`) on the grid this tab was
   * opened from.
   */
  projectId?: string
  canEdit?: boolean
  isLoading?: boolean
  /**
   * Create a Feature under THIS Epic. Omitted when the caller cannot create.
   *
   * An Epic's children are Features, so this tab's Add New makes a Feature — the same rule
   * the Feature Children tab follows for its own Story/Defect children.
   */
  onAddFeature?: () => void
}) {
  const { t } = useTranslation('portfolio')
  const navigate = useNavigate()
  const { data: projectTeams = [] } = useProjectTeams(projectId)
  const teamKeyOf = useCallback(
    (teamId: string | null | undefined) =>
      teamId == null ? null : (projectTeams.find((tm) => tm.id === teamId)?.key ?? null),
    [projectTeams],
  )
  const [search, setSearch] = useState('')
  const [stateFilter, setStateFilter] = useState<string>('all')
  /**
   * Which Feature rows are showing their leaf preview.
   *
   * §404: "Feature rows can expand to preview up to five leaf Story/Defect rows." Children are
   * fetched per Feature on first expand rather than up front — an Epic with twenty Features would
   * otherwise fire twenty queries to render a tab where most rows are never opened.
   */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const toggleExpanded = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])
  const { sortField, sortDir, toggle } = useTableSort<EpicSortField>()

  const table = useDataTable<PortfolioItem, unknown, EpicChildColKey>(EPIC_CHILD_COLUMNS, {
    storageKey: 'rally-portfolio-epic-children-columns',
    // The select/drag gutter is 48px wide and sits before every column; without it the computed
    // table width is short by exactly that, and the horizontal scroll region ends early.
    leadingWidth: 48,
    sort: {
      col: sortField ?? '',
      dir: sortDir ?? 'asc',
      onSort: (c) => toggle(c as EpicSortField),
    },
  })

  // Column sizing comes straight from the shared engine — see `useDataTable().colStyles`.
  const colStyles = table.colStyles

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const rows = features.filter(
      (feature) =>
        (needle === '' ||
          feature.itemKey.toLowerCase().includes(needle) ||
          feature.name.toLowerCase().includes(needle)) &&
        (stateFilter === 'all' || feature.state === stateFilter),
    )
    return sortFeatures(rows, sortField, sortDir)
  }, [features, search, stateFilter, sortField, sortDir])

  /** The states these Features are actually in, so the filter never offers an empty result. */
  const featureStates = useMemo(() => [...new Set(features.map((f) => f.state))].sort(), [features])

  /**
   * Drag-to-rank, through the same endpoint the Portfolio list uses.
   *
   * Disabled while a column sort is active — the visible order would no longer be rank, so a drop
   * would compute neighbours from a list the server does not share — and disabled without
   * `portfolio:edit`. The Rank column numbers rows 1..N; before this it numbered an order the
   * reader could not change from here.
   */
  const rank = useRankPortfolioItem()
  const dragDisabled = sortField !== null || !canEdit
  const rerank = useRowRerank({
    items: visible,
    disabled: dragDisabled,
    onReorder: ({ id, beforeId, afterId }) =>
      rank.mutate({ id, beforeId, afterId }, { onError: (err) => toast.error(err.message) }),
  })

  /** Footed over the VISIBLE rows, so the totals cannot disagree with the rows above them. */
  const totals = visible.reduce(
    (acc, feature) => ({
      complete: acc.complete + feature.rollup.completedPoints,
      rollup: acc.rollup + feature.rollup.rollupPoints,
      estimated: acc.estimated + feature.estimate.points.value,
    }),
    { complete: 0, rollup: 0, estimated: 0 },
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* The same toolbar the Feature Children tab uses — search, Add New, Filters, Show Fields.
          Add New creates a FEATURE, because that is what an Epic's children are; the Feature
          Children tab's own Add New creates a Story/Defect for the same reason. This tab
          previously had no Add New at all, on the reasoning that a child Feature is made from
          the Portfolio list — but that is one more navigation for the level the user is already
          looking at, and P5-PI-FR-032 puts Epic Detail on the Feature detail template, which
          has one. */}
      <PageToolbar
        actions={
          canEdit && onAddFeature ? (
            <Button size="sm" onClick={onAddFeature}>
              <Plus size={14} /> {t('create.titleFeature')}
            </Button>
          ) : undefined
        }
        search={{
          value: search,
          onChange: setSearch,
          placeholder: t('detail.children.searchFeatures'),
          ariaLabel: t('detail.children.searchFeatures'),
          width: 220,
        }}
        activeFilterCount={stateFilter !== 'all' ? 1 : 0}
        defaultFiltersOpen={stateFilter !== 'all'}
        filters={
          <label className="flex items-center gap-1.5 text-ui-sm font-semibold text-muted-foreground">
            {t('detail.children.filterState')}
            <InlineSelect
              value={stateFilter}
              aria-label={t('detail.children.filterState')}
              onChange={(e) => setStateFilter(e.target.value)}
              className="w-auto"
            >
              <option value="all">{t('detail.children.allStates')}</option>
              {featureStates.map((state) => (
                <option key={state} value={state}>
                  {t(`states.${state}`, { defaultValue: state })}
                </option>
              ))}
            </InlineSelect>
          </label>
        }
        fields={<ColumnFieldsMenu {...table.fieldsMenuProps} />}
      />

      <SelectableTable
        className="rounded border border-border-strong"
        rows={rerank.items}
        // NOT selectable: there is no bulk action on either children tab, in the SRS or in the code,
        // so a checkbox column produced a bulk bar reading "1 selected · Clear" and offering nothing —
        // a control whose only outcome is undoing itself. `leadingExtra` keeps the header's leading
        // width, because the rows still render a gutter for the drag grip.
        selectable={false}
        leadingExtra={<RowGutter dragDisabled />}
        headerProps={{ ...table.headerProps, colStyles }}
        sort={{
          col: sortField ?? '',
          dir: sortDir ?? 'asc',
          onSort: (c) => toggle(c as EpicSortField),
        }}
        dnd={{
          dndContextProps: rerank.dndContextProps,
          sortableContextProps: rerank.sortableContextProps,
        }}
        loading={isLoading}
        skeleton={{ rows: 4, cols: EPIC_CHILD_COLUMNS.length }}
        // Inside the frame, not after it: rendered as a sibling the row scrolled horizontally
        // while the totals stayed put, so the numbers drifted out from under their columns.
        totals={
          visible.length > 0 ? (
            <TableTotalsRow
              columns={EPIC_CHILD_COLUMNS}
              colStyles={colStyles}
              leading={<RowGutter dragDisabled />}
              label={t('detail.children.totals', { count: visible.length })}
              labelColKey="name"
              values={{
                complete: String(totals.complete),
                rollup: String(totals.rollup),
                estimated: String(totals.estimated),
              }}
            />
          ) : undefined
        }
        empty={
          visible.length === 0 ? (
            <EmptyState
              title={
                features.length === 0 ? t('detail.children.empty') : t('detail.children.noMatches')
              }
            />
          ) : undefined
        }
        renderRow={(feature) => (
          <Fragment key={feature.id}>
            <EpicChildRow
              teamKeyOf={teamKeyOf}
              feature={feature}
              rowNum={rerank.items.indexOf(feature) + 1}
              colStyles={colStyles}
              dragDisabled={dragDisabled}
              onOpen={() =>
                void navigate({ to: '/portfolio/$itemId', params: { itemId: feature.id } })
              }
              stateLabel={t(`states.${feature.state}`, { defaultValue: feature.state })}
              expanded={expanded.has(feature.id)}
              onToggleExpanded={() => toggleExpanded(feature.id)}
              expandLabel={expanded.has(feature.id) ? t('row.collapseItems') : t('row.expandItems')}
            />
            {expanded.has(feature.id) && <FeatureLeafPreview featureId={feature.id} />}
          </Fragment>
        )}
      />
    </div>
  )
}

/**
 * One child Feature.
 *
 * Owns its `useSortable` + `<RowGutter>` the way every other `SelectableTable` row does, so the grip
 * and checkbox line up with the header's select-all across all of them.
 */
/** §404's cap. Five leaf rows, then a line pointing at the Feature that owns the rest. */
const LEAF_PREVIEW_LIMIT = 5

/**
 * The ≤5 leaf Story/Defect preview under one Feature row (§404).
 *
 * DELIBERATE DIVERGENCE FROM RALLY on the cap. Rally's expandable rows have no documented limit;
 * §404 caps at five and we keep the cap, because the alternative here is an unbounded list nested
 * inside a grid. The list page's equivalent preview solves that by pointing overflow at the Children
 * tab ("+N more - see Children tab", SRS:61/FR-006/AC-5) — but this IS the Children tab, so that
 * escape hatch would be circular. Overflow points at the Feature's own detail page instead, which is
 * where the full paged list lives.
 *
 * A deliberately NARROW preview: ID, Name, State. The Epic tab's own columns are Feature roll-ups
 * (Complete / Rollup / Estimated) and a Story has no roll-up, so reusing that geometry would print a
 * row of `--` under every Feature and read as missing data rather than as a different kind of row.
 *
 * See 09_Gap_Audit/PHASE_5_6_DECISION_MATRIX.md#P5-PI-8
 */
function FeatureLeafPreview({ featureId }: { featureId: string }) {
  const { t } = useTranslation('portfolio')
  const { data, isLoading } = usePortfolioChildren(featureId)

  const children = data ?? []
  const shown = children.slice(0, LEAF_PREVIEW_LIMIT)
  const hidden = Math.max(0, children.length - LEAF_PREVIEW_LIMIT)

  return (
    <div className="bg-surface-hover px-3 shadow-[inset_2px_0_0_var(--primary-lighter)]">
      {isLoading ? (
        <div className="py-1.5 pl-11 text-ui-xs text-foreground-subtle">
          {t('row.loadingChildren')}
        </div>
      ) : shown.length === 0 ? (
        <div className="py-1.5 pl-11 text-ui-xs text-foreground-subtle">
          {t('row.noChildItems')}
        </div>
      ) : (
        <>
          {shown.map((child) => (
            <div key={child.id} className="flex items-center gap-2 py-1 pl-11 text-ui-xs">
              {/* `IdCell` with no `onOpen`, and NO State column — the same treatment the list page's
                  leaf preview gets, where State and both Percent Done cells are deliberately blank
                  (§61/AC-5). A preview answers "what is under here"; the columns are the Children
                  tab's job. Copying that rule rather than inventing one for this surface also keeps
                  the two previews of the same entity looking like the same thing. */}
              <IdCell type={child.type} itemKey={child.itemKey} />
              <span className="min-w-0 flex-1 truncate text-foreground" title={child.title}>
                {child.title}
              </span>
            </div>
          ))}
          {hidden > 0 && (
            <div className="py-1.5 pl-11 text-ui-xs text-foreground-subtle">
              {t('row.moreLeafItems', { count: hidden })}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function EpicChildRow({
  feature,
  rowNum,
  colStyles,
  dragDisabled,
  onOpen,
  stateLabel,
  teamKeyOf,
  expanded,
  onToggleExpanded,
  expandLabel,
}: {
  feature: PortfolioItem
  rowNum: number
  colStyles: Record<EpicChildColKey, CSSProperties>
  dragDisabled: boolean
  onOpen: () => void
  stateLabel: string
  /** Team id → key, so this row's chip matches the same team's chip on every other surface. */
  teamKeyOf: (teamId: string | null | undefined) => string | null
  expanded: boolean
  onToggleExpanded: () => void
  /** Accessible name for the disclosure — the caller owns the vocabulary, as `RowExpandToggle` asks. */
  expandLabel: string
}) {
  const {
    setNodeRef,
    setActivatorNodeRef,
    listeners,
    attributes,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: feature.id, disabled: dragDisabled })
  const dragStyle = useDragRowStyle({ transform, transition, isDragging })

  return (
    <TableRow
      ref={setNodeRef}
      // `min-w-max` is a class; the drag style is genuinely dynamic and comes from the shared
      // `useDragRowStyle`, so this row cannot drift from the other six drag grids.
      className="px-3"
      fitContent
      style={dragStyle}
    >
      <RowGutter
        ref={setActivatorNodeRef}
        dragListeners={dragDisabled ? undefined : listeners}
        dragAttributes={dragDisabled ? undefined : attributes}
        dragDisabled={dragDisabled}
        stopPropagation
      />
      <RankCell rowNum={rowNum} style={colStyles.rank} />
      {/* Disclosure in the ID cell, which is where every other grid in this app puts it — it lived
          in the Name cell once and its spacer indented every name 16px off its own heading. */}
      <div style={colStyles.id} className="flex items-center gap-1 px-2">
        <RowExpandToggle expanded={expanded} onToggle={onToggleExpanded} label={expandLabel} />
        <IdCell
          type={feature.type}
          itemKey={feature.itemKey}
          onOpen={onOpen}
          href={entityDetailPath.portfolioItem(feature.id)}
        />
      </div>
      <div style={colStyles.name} className="min-w-0 px-2" title={feature.name}>
        <span className="break-words whitespace-normal text-foreground">{feature.name}</span>
      </div>
      {/* The shared cells, so a child Feature's Team and Owner carry the same square
          `TeamAvatar` and round `OwnerAvatar` the Portfolio grid and the Feature Children tab
          render. Both were bare text — the one column pair still reading as plain strings while
          every neighbouring surface showed a glyph. */}
      <div style={colStyles.team} className="flex min-w-0 items-center px-2">
        <TeamCell teamKey={teamKeyOf(feature.teamId)} name={feature.teamName ?? null} />
      </div>
      <div style={colStyles.state} className="min-w-0 px-2">
        <span
          className="break-words whitespace-normal"
          style={{ color: portfolioStateColor(feature.state) }}
        >
          {stateLabel}
        </span>
      </div>
      <div
        style={colStyles.complete}
        className="px-2 text-right text-muted-foreground tabular-nums"
      >
        {feature.rollup.completedPoints}
      </div>
      <div style={colStyles.rollup} className="px-2 text-right text-muted-foreground tabular-nums">
        {feature.rollup.rollupPoints}
      </div>
      {/* The RESOLVED estimate, not the raw `refinedEstimate` column.
          That column is NOT NULL DEFAULT 0 and 0 means "not forecast" — it falls through to the
          Preliminary size mapping everywhere else — so a Feature sized only by a T-shirt read 0 here
          and in the totals row below, while its own detail page showed the mapped number. The API
          resolves the tier once and ships both units. */}
      <div
        style={colStyles.estimated}
        className="px-2 text-right text-muted-foreground tabular-nums"
      >
        {feature.estimate.points.tier === 'none' ? EMPTY_VALUE : feature.estimate.points.value}
      </div>
      <div style={colStyles.owner} className="flex min-w-0 items-center px-2">
        <OwnerCell name={feature.ownerName ?? null} />
      </div>
    </TableRow>
  )
}

function sortFeatures(
  rows: PortfolioItem[],
  field: EpicSortField | null,
  dir: SortDir | null,
): PortfolioItem[] {
  // No sort = the API's RANK order, which is what the `Rank` column numbers.
  if (field === null) return rows
  const sign = (dir ?? 'asc') === 'asc' ? 1 : -1
  const byText = (a: string, b: string) => sign * a.localeCompare(b)

  return [...rows].sort((a, b) => {
    switch (field) {
      case 'itemKey':
        return byText(a.itemKey, b.itemKey)
      case 'name':
        return byText(a.name, b.name)
      case 'team':
        return byText(text(a.teamName), text(b.teamName))
      case 'state':
        return byText(a.state, b.state)
      case 'owner':
        return byText(text(a.ownerName), text(b.ownerName))
    }
  })
}
