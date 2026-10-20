import { EMPTY_VALUE } from '@/shared/lib/utils'
import { useMemo, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useSortable } from '@dnd-kit/sortable'
import { toast } from 'sonner'

import {
  useDataTable,
  useRowRerank,
  useDragRowStyle,
  RankCell,
  SelectableTable,
  TableRow,
} from '@/shared/ui/table'
import { PageToolbar } from '@/shared/ui/page-toolbar'
import { ColumnFieldsMenu } from '@/shared/ui/column-fields-menu'
import { InlineSelect } from '@/shared/ui/native-select'
import { Button } from '@/shared/ui/button'
import { EmptyState } from '@/shared/ui/empty-state'
import { PaginationFooter } from '@/shared/ui/pagination-footer'
import { TableTotalsRow } from '@/shared/ui/table-totals-row'
import { useClientPagination } from '@/shared/lib/hooks/use-client-pagination'
import { RowGutter } from '@/shared/ui/row-gutter'
import { RowExpandToggle } from '@/shared/ui/row-expand-toggle'
import { InlineEditableCell } from '@/shared/ui/inline-editable-cell'
import { SearchableSelect } from '@/shared/ui/searchable-select'
import { OwnerCell, OwnerSelectCell } from '@/shared/ui/owner-cell'
import { NESTED_ROW_INDENT } from '@/shared/config/layout'
import { IdCell } from '@/entities/work-item/ui/id-cell'
import { ScheduleStateBadge, TypeBadge } from '@/entities/work-item/ui/badges'
import { NUMERIC_CELL_CLASS } from '@/shared/lib/utils'
import { StateStepper } from '@/entities/work-item/ui/state-stepper'
import { SCHEDULE_STATE_STEPS } from '@/entities/work-item/ui/state-steps'
import {
  PRIORITY_LABEL,
  PRIORITY_VALUES,
  SCHEDULE_STATE_LABEL,
  ScheduleState,
} from '@/entities/work-item/model/types'
import { useTableSort, type SortDir } from '@/shared/lib/hooks/use-table-sort'
import { useReleaseOptions, type ReleaseOption } from '@/features/releases/api'
import {
  useProjectMemberOptions,
  useTeamOwnerOptions,
  type ProjectMemberOption,
} from '@/features/teams/api'
import {
  useRankAnyWorkItem,
  useTasks,
  useUpdateWorkItem,
  type UpdateWorkItemInput,
  type WorkItem,
} from '@/features/work-items/api'
import type { PortfolioChild } from '@/features/portfolio/api'
import { PORTFOLIO_CHILD_COLUMNS, type ChildColKey } from '../model/children-columns'
import { listResource } from '@/shared/lib/query/resource'
import { LoadErrorState } from '@/shared/ui/load-error-state'

/** Which field each sortable column compares on. */
type ChildSortField =
  | 'itemKey'
  | 'title'
  | 'priority'
  | 'estimate'
  | 'owner'
  | 'scheduleState'
  | 'iteration'
  | 'release'

const text = (value: string | null): string => value ?? ''

/**
 * The Stories and Defects linked to a Feature — the BA's Children tab.
 *
 * This was a flat run of `<div>`s carrying ID, name and schedule state, against a spec asking for a
 * "full Backlog-style table". So it is the shared grid: `useDataTable` for resizable, reorderable
 * columns, `SelectableTable` for the shell every complex grid uses — the select-all gutter, the bulk
 * bar and the scroll body — and `useTableSort` for the same click-to-sort semantics. None of that
 * is reimplemented here; the point of the BA calling it "Backlog-style" is that it IS the same
 * table.
 *
 * DRAG-TO-RANK through `PATCH /v1/work-items/{id}/rank`, the work item's own rank endpoint — not
 * the portfolio one, which ranks Features among Features. An earlier revision left drag out on the
 * reasoning that a Story's rank "lives on the Backlog"; that was wrong twice over. The children
 * query already orders by `workItems.rank`, so the rows arrive in rank order, and `useRankAnyWorkItem`
 * writes exactly that column. The list was orderable all along and simply had no grip.
 *
 * `rank` had to be added to the child response for it: the repository already selected it for its
 * own ORDER BY and then dropped it in the row mapping, so the client received an ordered list it
 * had no way to reorder.
 *
 * Search is client-side over the loaded rows: the children of one Feature are a bounded set (the
 * endpoint returns them for that Feature alone), so there is no page to re-fetch and a server round
 * trip per keystroke would be slower and no more correct.
 *
 * INLINE EDIT and EXPAND-TO-TASKS are §5.2, FR-011 and FR-012 — specified, and until now unbuilt.
 * The tab's earlier comment argued editing away as "a second editing surface for the same fields",
 * but the SRS asks for it by name and the wire was already built to serve it: `PortfolioChildSchema`
 * returns `projectId` / `releaseId` / `assigneeId` beside the display names, with the comment "IDs
 * alongside the names, so the disclosed child rows can edit in place". The scenario covering both
 * (P5-PI-013) was never run, so this was missing rather than deliberately dropped.
 *
 * Every editable cell is the SAME primitive the Backlog uses for that field — `InlineEditableCell`
 * for Name and Est, `SearchableSelect` for Priority and Release, `OwnerSelectCell`, `StateStepper` —
 * so the two surfaces cannot disagree about how a field is edited. Iteration stays read-only text,
 * which §5.2 calls a deliberate scope trim.
 *
 * The editing stops at the CHILD row. A disclosed Task is read-only (§5.2, FR-012) — see
 * {@link ChildTaskRow} for why that is a decision rather than a gap.
 *
 * The toolbar is the shared `PageToolbar` — search, `Add New`, Filters and Show Fields — laid out
 * as Iteration Status lays it out, minus the KPI strip, which this tab has no metrics for. `Add
 * New` opens the Backlog creation flow (§5.2) and links the new item to this Feature.
 *
 * §114 asks for both a "pagination footer" and "a Totals row summing Plan Estimate", and FR-010 repeats
 * the pagination half. Both are here. The footer paginates on the CLIENT — the endpoint returns a
 * Feature's children in one response, so there is no page to fetch — and the totals foot the VISIBLE
 * rows, so the number cannot disagree with the rows above it.
 *
 * A previous revision left both out, reasoning that Iteration Status foots nothing and that the sum is
 * a roll-up the Details tab already reports. True of that grid, but §114 asks for it on THIS tab, and
 * the Epic Children tab beside it now foots its own three columns.
 */
export function FeatureChildrenTable({
  children,
  projectId,
  canEdit = false,
  isLoading = false,
  onAddItem,
}: {
  children: PortfolioChild[]
  /** The Feature's project — scopes the Release and Owner option lists. */
  projectId: string | undefined
  /** `portfolio:edit`. FR-011 gates inline editing on it. */
  canEdit?: boolean
  isLoading?: boolean
  /** §5.2's `Add Item` — opens the Backlog creation flow. Absent = the button is not rendered. */
  onAddItem?: () => void
}) {
  // Two namespaces: the tab's own copy, and `work-items` for the priority labels — those already
  // exist there and a portfolio-local copy would be a second vocabulary for one enum.
  const { t } = useTranslation(['portfolio', 'work-items'])
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  // Filters live in the toolbar's collapsible panel, as they do on Iteration Status. Type is the
  // useful one here: a Feature's children are Stories AND Defects, and the Type column is gone.
  const [typeFilter, setTypeFilter] = useState<'all' | 'story' | 'defect'>('all')
  const [stateFilter, setStateFilter] = useState<string>('all')
  const { sortField, sortDir, toggle } = useTableSort<ChildSortField>()

  const table = useDataTable<PortfolioChild, unknown, ChildColKey>(PORTFOLIO_CHILD_COLUMNS, {
    storageKey: 'rally-portfolio-children-columns', // legacy physical name, do not rename
    // The select gutter is 48px and precedes every column; without it the computed table width is
    // short by exactly that and the horizontal scroll region ends early.
    leadingWidth: 48,
    sort: {
      col: sortField ?? '',
      dir: sortDir ?? 'asc',
      onSort: (c) => toggle(c as ChildSortField),
    },
  })

  // Column sizing comes straight from the shared engine — see `useDataTable().colStyles`. This
  // page used to rebuild the map with a `{ flex: 1, minWidth }` base that `styleFor` discarded.
  const colStyles = table.colStyles

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const rows = children.filter(
      (child) =>
        (needle === '' ||
          child.itemKey.toLowerCase().includes(needle) ||
          child.title.toLowerCase().includes(needle)) &&
        (typeFilter === 'all' || child.type === typeFilter) &&
        (stateFilter === 'all' || child.scheduleState === stateFilter),
    )
    return sortChildren(rows, sortField, sortDir)
  }, [children, search, typeFilter, stateFilter, sortField, sortDir])

  // Option lists for the editable cells, scoped to the Feature's own project — the same two
  // queries the Backlog row uses, so the choices offered here are the choices offered there.
  // The REFERENCE feed, not `useReleaseRecords`: this table only labels and chooses a release,
  // and the administrative list is `release:view` — which a project Editor does not hold.
  const { data: releases = [] } = useReleaseOptions(projectId)
  /**
   * The NAME source for an owner already set — the project reference feed, project-wide.
   *
   * It is no longer the OFFER list: `WID-FR-017` scopes Owner candidates to the record's Team, and
   * this project-wide feed is the NO-TEAM branch of that rule, which offers project Admins and
   * deliberately no Editors. Handing it to every child row therefore withheld exactly the active Team
   * members a Story is normally assigned to — the same defect reported on Iteration Status. Each row
   * asks for its own team's candidates instead (see `ChildRow`), and this stays as the id-to-name
   * lookup, which must stay WIDE or a set owner outside the offer list reads as unassigned.
   */
  const { data: members = [] } = useProjectMemberOptions(projectId)

  /**
   * Drag-to-rank over the WORK ITEM's rank, through the endpoint the Backlog uses.
   *
   * Disabled while a column sort or a filter is active: in either case the visible order is not
   * rank, so the neighbours a drop computes would not be the neighbours the server has. Also
   * disabled without `portfolio:edit`, matching the inline edits beside it.
   */
  const rank = useRankAnyWorkItem()
  const listIsRankOrdered = sortField === null && typeFilter === 'all' && stateFilter === 'all'
  const dragDisabled = !canEdit || !listIsRankOrdered
  const rerank = useRowRerank({
    items: visible,
    disabled: dragDisabled,
    onReorder: ({ id, beforeId, afterId }) =>
      rank.mutate(
        {
          id,
          projectId: projectId ?? '',
          beforeId: beforeId ?? undefined,
          afterId: afterId ?? undefined,
        },
        { onError: (err) => toast.error(err.message) },
      ),
  })

  // FR-012: which rows have their Tasks disclosed. A Set rather than a per-row flag so collapsing
  // one row cannot disturb another, and so the state survives a re-sort.
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set())
  const toggleExpanded = (id: string) =>
    setExpandedIds((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  /**
   * §114's pagination footer, on the CLIENT.
   *
   * `/portfolio-items/{id}/children` returns a Feature's children in one response, so there is no page
   * to fetch — the footer paginates what is already here, exactly as Projects and the workspace member
   * list do through the same hook.
   *
   * Fed the FILTERED set, so narrowing the search re-pages instead of leaving the reader on an empty
   * page 3 (`useClientPagination` clamps the page for that reason).
   */
  const pagination = useClientPagination(rerank.items, 25)

  /** §114: "a Totals row summing Plan Estimate", over the rows on screen. */
  const totalEstimate = visible.reduce((sum, child) => sum + (child.storyPoints ?? 0), 0)

  const activeFilterCount = (typeFilter !== 'all' ? 1 : 0) + (stateFilter !== 'all' ? 1 : 0)

  // The states this Feature's children are actually in, so the filter never offers a value that
  // would empty the list. Derived from the unfiltered set, or selecting one would shrink its own
  // option list to a single entry.
  const childStates = useMemo(
    () => [...new Set(children.map((c) => c.scheduleState))].sort(),
    [children],
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The same chrome Iteration Status puts above its grid: search, Add New, Filters and Show
          Fields in one shared `PageToolbar`. This tab had a bare `SearchInput` and no way to reach
          the other three, so the two surfaces looked unrelated above the table as well as in it. */}
      <PageToolbar
        search={{
          value: search,
          onChange: setSearch,
          placeholder: t('detail.children.search'),
          ariaLabel: t('detail.children.search'),
          width: 220,
        }}
        actions={
          canEdit && onAddItem ? (
            <Button size="sm" onClick={onAddItem}>
              <Plus size={14} /> {t('detail.children.addItem')}
            </Button>
          ) : undefined
        }
        activeFilterCount={activeFilterCount}
        defaultFiltersOpen={activeFilterCount > 0}
        filters={
          <>
            <label className="flex items-center gap-1.5 text-ui-sm font-semibold text-muted-foreground">
              {t('detail.children.filterType')}
              <InlineSelect
                value={typeFilter}
                aria-label={t('detail.children.filterType')}
                onChange={(e) => setTypeFilter(e.target.value as 'all' | 'story' | 'defect')}
                className="w-auto"
              >
                <option value="all">{t('detail.children.allTypes')}</option>
                <option value="story">
                  {t('work-items:type.story', { defaultValue: 'Story' })}
                </option>
                <option value="defect">
                  {t('work-items:type.defect', { defaultValue: 'Defect' })}
                </option>
              </InlineSelect>
            </label>
            <label className="flex items-center gap-1.5 text-ui-sm font-semibold text-muted-foreground">
              {t('detail.children.filterState')}
              <InlineSelect
                value={stateFilter}
                aria-label={t('detail.children.filterState')}
                onChange={(e) => setStateFilter(e.target.value)}
                className="w-auto"
              >
                <option value="all">{t('detail.children.allStates')}</option>
                {childStates.map((s) => (
                  <option key={s} value={s}>
                    {SCHEDULE_STATE_LABEL[s as ScheduleState] ?? s}
                  </option>
                ))}
              </InlineSelect>
            </label>
          </>
        }
        fields={<ColumnFieldsMenu {...table.fieldsMenuProps} />}
      />

      <SelectableTable
        className="rounded border border-border-strong"
        rows={pagination.pageItems}
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
          onSort: (c) => toggle(c as ChildSortField),
        }}
        dnd={{
          dndContextProps: rerank.dndContextProps,
          sortableContextProps: rerank.sortableContextProps,
        }}
        loading={isLoading}
        skeleton={{ rows: 4, cols: PORTFOLIO_CHILD_COLUMNS.length }}
        // §114: "a Totals row summing Plan Estimate". Footed over the VISIBLE rows — the search and
        // both filters narrow them — so the total always describes what is on screen.
        totals={
          visible.length > 0 ? (
            <TableTotalsRow
              columns={PORTFOLIO_CHILD_COLUMNS}
              colStyles={colStyles}
              leading={<RowGutter dragDisabled />}
              label={t('detail.children.totals', { count: visible.length })}
              values={{ estimate: String(totalEstimate) }}
            />
          ) : undefined
        }
        footer={visible.length > 0 ? <PaginationFooter {...pagination.footerProps} /> : undefined}
        empty={
          visible.length === 0 ? (
            <EmptyState
              title={
                children.length === 0 ? t('detail.children.empty') : t('detail.children.noMatches')
              }
            />
          ) : undefined
        }
        renderRow={(child) => (
          <ChildRow
            key={child.id}
            child={child}
            // Position in the WHOLE filtered list, not on this page: the Rank column would restart
            // at 1 on page 2 otherwise.
            rowNum={rerank.items.indexOf(child) + 1}
            colStyles={colStyles}
            canEdit={canEdit}
            dragDisabled={dragDisabled}
            expanded={expandedIds.has(child.id)}
            onToggleExpand={() => toggleExpanded(child.id)}
            expandLabel={t('detail.children.expandTasks', { key: child.itemKey })}
            releases={releases}
            members={members}
            onOpen={() =>
              void navigate({ to: '/item/$itemKey', params: { itemKey: child.itemKey } })
            }
            onOpenTask={(itemKey) => void navigate({ to: '/item/$itemKey', params: { itemKey } })}
          />
        )}
      />
    </div>
  )
}

/**
 * One linked Story/Defect, editable in place (FR-011) and expandable to its Tasks (FR-012).
 *
 * Each control is the primitive the Backlog uses for that same field, so a reader who learns to
 * edit an estimate on one screen already knows how to do it on the other. Every cell stops click
 * propagation: the row itself opens the full Work Item Detail (§5.2), and an edit must not
 * navigate away mid-keystroke.
 */
function ChildRow({
  child,
  rowNum,
  colStyles,
  canEdit,
  dragDisabled,
  expanded,
  onToggleExpand,
  expandLabel,
  releases,
  members,
  onOpen,
  onOpenTask,
}: {
  child: PortfolioChild
  /** 1-based position in the visible list — what the Rank column shows. */
  rowNum: number
  colStyles: Record<ChildColKey, CSSProperties>
  canEdit: boolean
  dragDisabled: boolean
  expanded: boolean
  onToggleExpand: () => void
  expandLabel: string
  // The real query types, not structural stand-ins: a hand-written `{ userId; displayName?; email? }`
  // would silently accept a feed missing the fields `OwnerSelectCell` reads. `ProjectMemberOption` is
  // the REFERENCE projection — `ProjectMember` is the administrative roster and must not reach a picker.
  releases: ReleaseOption[]
  members: ProjectMemberOption[]
  onOpen: () => void
  /** Opens a disclosed Task's own detail — same destination as any other ID cell in the app. */
  onOpenTask: (itemKey: string) => void
}) {
  const { t } = useTranslation(['portfolio', 'work-items'])
  /**
   * The Owner OFFER list for THIS child, scoped to its own Team (`WID-FR-017` / `WIC-FR-006A`).
   *
   * `members` above is the project-wide reference feed and stays the NAME source; using it to OFFER
   * meant every row got the rule's no-Team branch — project Admins, no Editors — so an active Team
   * member could not be chosen. Rows sharing a team share one query key, and a child with no team
   * asks for nothing, which is the rule's own answer ("No Team offers only Unassigned").
   */
  const { data: ownerOffers = [] } = useTeamOwnerOptions(child.projectId, child.teamId ?? null)
  const update = useUpdateWorkItem(child.id)
  const patch = (body: UpdateWorkItemInput) => update.mutate(body)
  const stop = (event: React.MouseEvent) => event.stopPropagation()
  const {
    setNodeRef,
    setActivatorNodeRef,
    listeners,
    attributes,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: child.id, disabled: dragDisabled })
  const dragStyle = useDragRowStyle({ transform, transition, isDragging })

  const ownerName = (() => {
    const member = members.find((m) => m.userId === child.assigneeId)
    return member?.displayName ?? member?.email ?? null
  })()

  return (
    <div ref={setNodeRef} style={dragStyle}>
      <TableRow
        // `min-w-max` (not an inline style) so the row is as wide as its columns and the
        // horizontal scroll region covers all of them.
        // `min-h-[35px]` with `items-center`, exactly as Iteration Status sizes its rows: a
        // MINIMUM, not a fixed height, so the row grows when a long Name or ID wraps, and the
        // cells stay vertically centred within whatever height that produces.
        className="px-3"
        fitContent
        interactive
        onClick={onOpen}
      >
        {/* Grip + checkbox, the same gutter every drag grid renders — the grip was missing here
            entirely, so the list arrived in rank order with no way to change it. */}
        <RowGutter
          ref={setActivatorNodeRef}
          dragListeners={dragDisabled ? undefined : listeners}
          dragAttributes={dragDisabled ? undefined : attributes}
          dragDisabled={dragDisabled}
          stopPropagation
        />
        <RankCell rowNum={rowNum} style={colStyles.rank} />
        {/* The expand chevron sits with the ID, where the removed Type column used to hold it.
            `IdCell` already renders the type badge, which is what that column duplicated. */}
        {/* The expand chevron sits with the ID, where the removed Type column used to hold it. */}
        <div style={colStyles.id} className="flex min-w-0 items-center gap-1 px-2" onClick={stop}>
          <RowExpandToggle expanded={expanded} onToggle={onToggleExpand} label={expandLabel} />
          <IdCell type={child.type} itemKey={child.itemKey} onOpen={onOpen} />
        </div>
        {/* `overflow-hidden`, as Iteration Status's Name cell has: it is what CONTAINS the
            editor. A flex child's `w-full` resolves against its parent, and without this the
            parent could be widened by its own content, so a long Name opened an input wider
            than the column and spilled across the cells beside it. */}
        <div style={colStyles.name} className="min-w-0 overflow-hidden px-0" onClick={stop}>
          <InlineEditableCell
            value={child.title}
            canEdit={canEdit}
            fullCell
            ariaLabel={t('detail.children.editName', { key: child.itemKey })}
            onCommit={(raw) => {
              const next = raw.trim()
              if (next && next !== child.title) patch({ title: next })
            }}
            className="block break-words whitespace-normal text-foreground"
            // No `inputClassName`: the shared `FULL_CELL_INPUT` already sizes the editor to the
            // cell. Overriding it dropped that `w-full`, so a long Name opened an input wider than
            // its column and spilled across the ones beside it.
            title={child.title}
          />
        </div>
        {/* Priority is Defect-only (§5.2); a Story shows the same `--` the Backlog shows. */}
        <div
          style={colStyles.priority}
          className="flex min-w-0 items-center overflow-hidden px-0"
          onClick={stop}
        >
          {child.type === 'defect' ? (
            <SearchableSelect
              value={child.priority ?? ''}
              readOnly={!canEdit}
              ariaLabel={t('detail.children.editPriority', { key: child.itemKey })}
              // `PRIORITY_VALUES` / `PRIORITY_LABEL` from the entity layer — the SAME source the
              // Backlog's priority cell uses. A local list here would be a second enum to keep in
              // step with `work_item_priority`, and the `work-items:priority.*` i18n block is not
              // that source: it still carries a `critical` key that migration 0011 remapped to
              // `urgent`, so it would have offered a value the column no longer has.
              options={PRIORITY_VALUES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
              // Cast to the UPDATE input's union, not to `WorkItem['priority']`: the read model
              // types this field as a bare `string` (the response DTO does not narrow it), so
              // `WiPriority` would not constrain anything. Same cast the Backlog cell uses.
              onChange={(v) => patch({ priority: v as UpdateWorkItemInput['priority'] })}
            />
          ) : (
            <span className="px-2 font-mono text-ui-xs text-foreground-disabled">--</span>
          )}
        </div>
        <div
          style={colStyles.estimate}
          className="flex items-center px-0 [&>*]:w-full"
          onClick={stop}
        >
          <InlineEditableCell
            value={child.storyPoints != null ? String(child.storyPoints) : ''}
            canEdit={canEdit}
            fullCell
            ariaLabel={t('detail.children.editEstimate', { key: child.itemKey })}
            onCommit={(raw) => {
              const next = raw.trim() === '' ? null : Number(raw)
              if (next !== null && (Number.isNaN(next) || next < 0)) return
              if (next !== (child.storyPoints ?? null)) patch({ storyPoints: next })
            }}
            // A dash, not 0: an unestimated Story is not a Story worth zero points.
            displayValue={child.storyPoints ?? EMPTY_VALUE}
            className="block text-right font-mono text-muted-foreground tabular-nums"
            inputClassName="w-full rounded border border-primary bg-transparent px-0.5 text-right font-mono text-inherit text-foreground focus:outline-none"
          />
        </div>
        <div
          style={colStyles.owner}
          className="flex min-w-0 items-center overflow-hidden px-0"
          onClick={stop}
        >
          <OwnerSelectCell
            ownerName={ownerName}
            assigneeId={child.assigneeId}
            members={ownerOffers}
            canEdit={canEdit}
            onChange={(userId) => patch({ assigneeId: userId })}
          />
        </div>
        <div
          style={colStyles.scheduleState}
          className="flex min-w-0 items-center overflow-hidden px-2"
          onClick={stop}
        >
          <StateStepper
            steps={SCHEDULE_STATE_STEPS}
            value={child.scheduleState as ScheduleState}
            canEdit={canEdit}
            onChange={(next) =>
              patch({ scheduleState: next as UpdateWorkItemInput['scheduleState'] })
            }
            ariaLabel={t('detail.children.editState', { key: child.itemKey })}
          />
        </div>
        {/* Iteration stays READ-ONLY text — §5.2 calls that a deliberate scope trim. */}
        {/* Read-only text that WRAPS, like the Name beside it — an iteration name is user-typed
            and can be long, and truncating it hid the end behind a tooltip nobody opens. */}
        <div style={colStyles.iteration} className="min-w-0 px-2">
          <span className="break-words whitespace-normal text-muted-foreground">
            {child.iterationName ?? EMPTY_VALUE}
          </span>
        </div>
        <div
          style={colStyles.release}
          className="flex min-w-0 items-center overflow-hidden px-0"
          onClick={stop}
        >
          <SearchableSelect
            value={child.releaseId ?? ''}
            readOnly={!canEdit}
            ariaLabel={t('detail.children.editRelease', { key: child.itemKey })}
            placeholder={EMPTY_VALUE}
            options={[
              { value: '', label: EMPTY_VALUE },
              ...releases.map((r) => ({
                value: r.id,
                label: r.releaseKey ? `${r.releaseKey}: ${r.name}` : r.name,
                searchText: `${r.releaseKey ?? ''} ${r.name}`,
                icon: <TypeBadge type="release" size={16} />,
              })),
            ]}
            onChange={(v) => patch({ releaseId: v || null })}
          />
        </div>
        {/* Task hours belong to Tasks, not to the Story/Defect — blank here, filled on the
            disclosed rows below. The cells still render: every row must carry one cell per column
            or the two fall out of step, which is exactly what happened when these three columns
            were added to the header and only the sub-row was given cells for them. */}
        <div style={colStyles.taskEstimate} className="px-2" />
        <div style={colStyles.toDo} className="px-2" />
        <div style={colStyles.actual} className="px-2" />
      </TableRow>

      {expanded && (
        <ChildTaskRows
          workItemId={child.id}
          colStyles={colStyles}
          members={members}
          onOpenTask={onOpenTask}
        />
      )}
    </div>
  )
}

/**
 * A disclosed child's Tasks, READ-ONLY (FR-012).
 *
 * Fetched per expanded row rather than up front: a Feature can link many children and each of them
 * has its own task list, so loading all of them to render none would be the expensive default.
 *
 * Read-only is the spec, and it is also the honest boundary — a Task's hours belong to the Work
 * Item Detail's Tasks tab, which owns the totals that roll up from them.
 */
function ChildTaskRows({
  workItemId,
  colStyles,
  members,
  onOpenTask,
}: {
  workItemId: string
  colStyles: Record<ChildColKey, CSSProperties>
  /** A task carries `assigneeId`, not a name — the roster resolves it, as the Tasks tab does. */
  members: ProjectMemberOption[]
  onOpenTask: (itemKey: string) => void
}) {
  const { t } = useTranslation('portfolio')
  const tasksQuery = useTasks(workItemId)
  // A resource: `data ?? []` printed `detail.children.noTasks` for a failed read, under a Feature
  // child whose own hour rollup rests on that same list.
  const taskFeed = listResource(tasksQuery)
  const tasks = taskFeed.rows
  const isLoading = taskFeed.isLoading

  if (isLoading) {
    return (
      <div className="border-b border-border-inner bg-surface-subtle px-3 py-2">
        <span className={`text-ui-xs text-foreground-subtle ${NESTED_ROW_INDENT}`}>
          {t('detail.children.tasksLoading')}
        </span>
      </div>
    )
  }

  if (taskFeed.phase === 'error') {
    return (
      <div className="border-b border-border-inner bg-surface-subtle">
        <LoadErrorState error={taskFeed.error} size="sm" className="py-3" />
      </div>
    )
  }

  if (taskFeed.phase === 'empty') {
    return (
      <div className="border-b border-border-inner bg-surface-subtle px-3 py-2">
        <span className={`text-ui-xs text-foreground-subtle ${NESTED_ROW_INDENT}`}>
          {t('detail.children.noTasks')}
        </span>
      </div>
    )
  }

  return (
    <>
      {tasks.map((task: WorkItem) => (
        <ChildTaskRow
          key={task.id}
          task={task}
          colStyles={colStyles}
          members={members}
          onOpen={() => onOpenTask(task.itemKey)}
        />
      ))}
    </>
  )
}

/**
 * One disclosed Task — READ-ONLY, per §5.2 and FR-012.
 *
 * "Each row can expand to reveal its linked Tasks, read-only: ID, Name, state badge, Owner,
 * Estimate, To Do/Actual hours." The BA draws the line deliberately, and draws it in the same
 * breath as the opposite rule for the row above: acceptance item 10 reads "Children-tab rows are
 * inline-editable on the confirmed fields and expandable to show linked Tasks read-only." §5.2's
 * column list marks each child column "(inline edit)" and then marks these rows read-only. Four
 * separate statements, one contrast — not an omission.
 *
 * A previous revision made these editable, arguing the read-only line predated Task hours being
 * editable elsewhere. That was wrong: the contrast is stated, not implied, so the argument was
 * against a decision rather than a gap. Editing a Task belongs on the Work Item Detail's Tasks
 * tab, which owns the totals that roll up from these hours.
 *
 * `state badge`, not a stepper, for the same reason — the BA names the control.
 *
 * ONE CELL PER COLUMN in the parent's order, so a resize or reorder moves both rows together.
 */
function ChildTaskRow({
  task,
  colStyles,
  members,
  onOpen,
}: {
  task: WorkItem
  colStyles: Record<ChildColKey, CSSProperties>
  members: ProjectMemberOption[]
  onOpen: () => void
}) {
  const owner = members.find((m) => m.userId === task.assigneeId)

  const hourCell = (value: number | string | null | undefined, style: CSSProperties) => (
    <div style={style} className={`px-2 ${NUMERIC_CELL_CLASS} text-muted-foreground`}>
      {value ?? '--'}
    </div>
  )

  return (
    // Grows with a wrapped Name or ID, exactly as the parent row does.
    <TableRow className="px-3 text-ui-sm" compact fitContent nested>
      <RowGutter dragDisabled />
      {/* A Task has no rank of its own — it follows its parent. Empty, but present, or the sub-row
          falls out of step with the header. */}
      <div style={colStyles.rank} className="px-2" />
      <div style={colStyles.id} className={`flex min-w-0 items-center pr-2 ${NESTED_ROW_INDENT}`}>
        <IdCell type={task.type} itemKey={task.itemKey} onOpen={onOpen} />
      </div>
      <div style={colStyles.name} className="min-w-0 overflow-hidden px-2" title={task.title}>
        <span className="break-words whitespace-normal text-muted-foreground">{task.title}</span>
      </div>
      {/* A Task has no Priority, and no Plan Estimate — that is the parent's points value. */}
      <div style={colStyles.priority} className="px-2" />
      <div style={colStyles.estimate} className="px-2" />
      {/* The shared read-only cell, so a disclosed Task's Owner carries the same round avatar as
          the parent row directly above it. Read-only does not mean glyph-less — the Epic Children
          tab's Owner is read-only too and shows one. The STATE beside it stays a
          `ScheduleStateBadge` rather than the parent's `StateStepper`: §5.2 names it a "state
          badge" for these rows specifically, and a stepper would also imply it is editable. */}
      <div style={colStyles.owner} className="flex min-w-0 items-center px-2">
        <OwnerCell name={owner?.displayName ?? owner?.email ?? null} />
      </div>
      <div style={colStyles.scheduleState} className="flex min-w-0 items-center px-2">
        <ScheduleStateBadge state={task.scheduleState} />
      </div>
      {/* A Task inherits its parent's Iteration and Release — not its own fields to show. */}
      <div style={colStyles.iteration} className="px-2" />
      <div style={colStyles.release} className="px-2" />
      {hourCell(task.estimateHours, colStyles.taskEstimate)}
      {hourCell(task.todoHours, colStyles.toDo)}
      {hourCell(task.actualHours, colStyles.actual)}
    </TableRow>
  )
}

/** Client-side sort: the children of one Feature arrive whole, so there is nothing to re-fetch. */
function sortChildren(
  rows: PortfolioChild[],
  field: ChildSortField | null,
  dir: SortDir | null,
): PortfolioChild[] {
  if (field === null) return rows
  const direction: SortDir = dir ?? 'asc'
  const sign = direction === 'asc' ? 1 : -1
  const byText = (a: string, b: string) => sign * a.localeCompare(b)

  return [...rows].sort((a, b) => {
    switch (field) {
      case 'itemKey':
        return byText(a.itemKey, b.itemKey)
      case 'title':
        return byText(a.title, b.title)
      case 'priority':
        return byText(a.priority, b.priority)
      case 'estimate':
        return sign * ((a.storyPoints ?? 0) - (b.storyPoints ?? 0))
      case 'owner':
        return byText(text(a.ownerName), text(b.ownerName))
      case 'scheduleState':
        return byText(a.scheduleState, b.scheduleState)
      case 'iteration':
        return byText(text(a.iterationName), text(b.iterationName))
      case 'release':
        return byText(text(a.releaseName), text(b.releaseName))
    }
  })
}
