/**
 * One capacity plan: its fields, its teams with their capacity, and the Features allocated
 * to each of them.
 *
 * `Breakdown` sits OUTSIDE the `canManage` toolbar on purpose. It reads numbers and changes
 * nothing, so a published plan — read-only until reverted — must still offer it; gating it
 * behind manage rights would hide the plan's totals from exactly the audience a published
 * plan exists for.
 */
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useDetailBack } from '@/shared/lib/use-detail-back'
import { Pencil, Send, Trash2, Undo2, Users } from 'lucide-react'

import { EmptyState } from '@/shared/ui/empty-state'
import { LoadErrorState } from '@/shared/ui/load-error-state'
import { valueResource } from '@/shared/lib/query/resource'
import { useExpandedIds } from './model/expanded-ids'
import { SkeletonList } from '@/shared/ui/skeleton'
import { DataTableFrame } from '@/shared/ui/table/data-table-frame'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'

import { useDataTable, useRowRerank } from '@/shared/ui/table'
import { useTableSort } from '@/shared/lib/hooks/use-table-sort'
import {
  isRankOrder,
  sortCapacityItems,
  type CapacityItemSortField,
} from '@/features/capacity-planning/sort-items'
import { DetailLayout } from '@/shared/ui/detail'
import { Button } from '@/shared/ui/button'
import { ConfirmDialog } from '@/shared/ui/confirm-dialog'
import { notify } from '@/shared/lib/toast'
import { useProjectPermissions } from '@/features/access/api'
import { useProjectTeams } from '@/features/teams/api'
import {
  useAddCapacityTeam,
  useUpdateCapacityPlan,
  useRemoveCapacityTeam,
  useCapacityPlan,
  useDeleteCapacityPlan,
  usePublishPlan,
  useRevertPlan,
  type CapacityAllocation,
  type CapacityPlanItem,
  type CapacityPlanTeam,
} from '@/features/capacity-planning/api'
import { usePlanItemActions } from '@/features/capacity-planning/use-plan-item-actions'
import { usePlanLookups } from '@/features/capacity-planning/use-plan-lookups'
import {
  sortCapacityTeams,
  type CapacityTeamSortField,
} from '@/features/capacity-planning/sort-teams'
import { CutlineDivider } from '@/shared/ui/cutline-divider'
import {
  CAPACITY_ITEM_COLUMNS,
  CAPACITY_TEAM_COLUMNS,
  type ItemColKey,
  type TeamColKey,
} from './model/columns'
import { CapacityItemRow } from './ui/capacity-item-row'
import { PlanHeaderStatus } from './ui/plan-header-status'
import { ItemAllocationRow } from './ui/item-allocation-row'
import { SortableItemRow } from './ui/sortable-item-row'
import { PlanAssignmentCounts, PlanSummaryMetrics } from './ui/plan-summary-metrics'
import { CapacityTeamRow } from './ui/capacity-team-row'
import { TeamAllocationsTable } from './ui/team-allocations-table'
import { TeamCapacityRail } from './ui/team-capacity-rail'
import { AddFeaturesModal } from './ui/add-features-modal'
import { FeaturesToolbar } from './ui/features-toolbar'
import { AllocateFeatureModal } from './ui/allocate-feature-modal'
import { MoveToPlanModal } from './ui/move-to-plan-modal'
import { TypeBadge } from '@/entities/work-item/ui/badges'
import { TeamAvatar } from '@/shared/ui/team-cell'
import { ActionMenu, ActionMenuItem } from '@/shared/ui/action-menu'
import { SelectionModal } from '@/shared/ui/selection-modal'
import { useRankPortfolioItem } from '@/features/portfolio/api'
import { entityLinkFor } from '@/shared/lib/entity-link'
import { CapacityForecastModal } from './ui/capacity-forecast-modal'
import { PublishPlanModal } from './ui/publish-plan-modal'
import { EditCapacityPlanModal } from './ui/edit-capacity-plan-modal'

export function CapacityPlanDetailPage() {
  const { t } = useTranslation('capacity')
  const navigate = useNavigate()
  const back = useDetailBack({ to: '/capacity-planning' })
  const { planId } = useParams({ from: '/auth/capacity-planning/$planId' })
  const [tab, setTab] = useState('teams')
  /** Which Feature the Allocate dialog is splitting, or null when it is closed. */
  const [allocateFor, setAllocateFor] = useState<string | null>(null)
  /** Rally's `Move To Another Plan`, for one Feature. */
  const [moveFor, setMoveFor] = useState<string | null>(null)
  const [showEdit, setShowEdit] = useState(false)
  const [showTeams, setShowTeams] = useState(false)
  /**
   * Which `Add Features` dialog is open, and for whom.
   *
   * `{ teamId: null }` is Rally's plan-level `Add Items`; a team id is its `Add Items to Project
   * Plan`, which lands the rows already assigned. One piece of state because the dialog is one
   * component — two booleans would allow both open at once.
   */
  const [addFeaturesFor, setAddFeaturesFor] = useState<{
    teamId: string | null
    teamName?: string | null
  } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // The team whose forecast is open, by plan-team id. One modal for every row rather than a
  // modal per row: only one can be open, and mounting N dialogs to show one is waste.
  const [forecastTeamId, setForecastTeamId] = useState<string | null>(null)
  const [showPublish, setShowPublish] = useState(false)
  const [confirmRevert, setConfirmRevert] = useState(false)
  // Teams whose allocated Features are shown, and which Features show their per-team breakdown.
  const [expandedTeams, toggleTeam] = useExpandedIds()
  const [expandedItems, toggleItem] = useExpandedIds()

  // `valueResource`, not `{ data }` alone: a 500/403 left `plan` undefined and the guard below
  // printed `detail.notFound` — "Capacity plan not found." — a claim the record does not exist,
  // about a request that never landed. The list page already separated the two. See resource.ts.
  const planQuery = useCapacityPlan(planId)
  const planResource = valueResource(planQuery)
  const plan = planResource.value
  const isLoading = planResource.isLoading

  /**
   * The header's name field, seeded from the plan and re-seeded whenever the plan's own name
   * changes — so a refetch or another user's rename lands here instead of being overwritten by a
   * stale draft.
   */
  const planName = plan?.name ?? ''
  const [draftName, setDraftName] = useState(planName)
  const [seededName, setSeededName] = useState(planName)
  // Adjusted during RENDER, not in an effect — the pattern `SelectionModal` uses: a setState inside
  // an effect costs an extra commit and a cascading render, and this only has to notice that the
  // plan's own name changed (a refetch, or someone else's rename).
  if (planName !== seededName) {
    setSeededName(planName)
    setDraftName(planName)
  }
  const { can } = useProjectPermissions(plan?.projectId)
  // A published plan is read-only until reverted, so the whole surface follows the API's
  // own rule rather than offering edits the server will refuse.
  const canManage = can('capacity:manage') && plan?.status === 'draft'

  // The PROJECT's teams, not every workspace team: a plan covers one project's release,
  // so those are the teams that can meaningfully carry its capacity. (The API validates
  // only workspace membership, deliberately looser, so a team helping across projects can
  // still be added by a caller that knows its id.)
  const { data: teams = [] } = useProjectTeams(plan?.projectId)
  const addTeam = useAddCapacityTeam()
  const removeTeam = useRemoveCapacityTeam()
  const rankItem = useRankPortfolioItem()

  /**
   * Rank drag on the Features tab — the same `useRowRerank` the Backlog and Portfolio grids use.
   *
   * Rally ranks by dragging a row "when the grid is set to the default sort order", and changing a
   * rank on one page changes it everywhere: a plan's Feature order IS the portfolio rank, so this
   * persists through the portfolio endpoint rather than a plan-local order.
   */
  /**
   * Plan items shaped for the shared rerank hook, which keys on `id`.
   *
   * A plan item is identified by `portfolioItemId` — it has no id of its own, because the plan holds
   * it through allocation rows. Mapping here keeps that difference out of the shared hook, and the
   * spread preserves every field the row still needs to render.
   */
  /**
   * The Features tab's own filters — Rally's `Show Filters` on this tab.
   *
   * Client-side, like every other narrowing on this page: the plan arrives whole, so there is no
   * page to re-fetch and no server filter to ask for.
   */
  const [itemTeamFilter, setItemTeamFilter] = useState('all')
  /** The OWNING team facet — the `Team` column, not the plan assignment beside it. */
  const [itemOwnerFilter, setItemOwnerFilter] = useState('all')
  const itemFilterCount = (itemTeamFilter === 'all' ? 0 : 1) + (itemOwnerFilter === 'all' ? 0 : 1)

  /**
   * The owning teams the plan's Features actually come from — the only values worth offering.
   *
   * This facet used to be `Project`, which stopped being a column when the BA's `Team` replaced it.
   * A filter over a column the grid no longer shows narrows the list for reasons nothing on screen
   * explains, so it moved with the column rather than outliving it.
   */
  const itemOwners = useMemo(() => {
    const names = new Map<string, string>()
    for (const item of plan?.items ?? []) {
      if (item.teamId !== null) names.set(item.teamId, item.teamName ?? '--')
    }
    return [...names].map(([id, name]) => ({ id, name }))
  }, [plan?.items])

  /**
   * Per team: how many of its allocated Features breach their OWN rule (`Rollup > Estimated`).
   *
   * The BA's attention badge sits beside each team's Features count and promises
   * `{N} Feature(s) require attention` (Capacity SRS:121), so N has to be a count of FEATURES. The
   * row was passing `team.metrics.warnings.length` instead — the team's own warnings, which include
   * capacity rules that say nothing about any Feature.
   *
   * Counted from `plan.items`, which already carries each Feature's resolved warnings from the
   * service, so the number beside the count and the triangles inside the disclosure come from one
   * source and cannot disagree.
   */
  const featuresNeedingAttentionByTeam = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of plan?.items ?? []) {
      if (!item.warnings.includes('rollup_exceeds_estimated')) continue
      for (const teamId of item.teamIds) counts.set(teamId, (counts.get(teamId) ?? 0) + 1)
    }
    return counts
  }, [plan?.items])

  const visibleItems = useMemo(
    () =>
      (plan?.items ?? []).filter((item) => {
        if (itemOwnerFilter !== 'all' && item.teamId !== itemOwnerFilter) return false
        if (itemTeamFilter === 'all') return true
        // "Unassigned" means no team holds it — the state this tab warns about.
        if (itemTeamFilter === 'unassigned') return item.teamIds.length === 0
        return item.teamIds.includes(itemTeamFilter)
      }),
    [plan?.items, itemTeamFilter, itemOwnerFilter],
  )

  /**
   * Every derived view over the plan — names by id, rank positions, sharing, per-team demand and the
   * three allocation buckets. One hook because both grids read the same lookups and none of them is
   * fetched: they are all views over the single payload the detail endpoint returns.
   */
  const {
    teamNameById,
    rankPositionOf,
    planRankOf,
    cutlineBeforeId,
    belowCutlineIds,
    sharingOf,
    allocationsByItem,
    allocationsByTeam,
  } = usePlanLookups(plan)

  /**
   * The Features tab's own sort, independent of the Teams tab's.
   *
   * Rally sorts every column here, and the two tabs answer different questions, so a shared sort state
   * would make switching tabs reorder the other one.
   */
  const {
    sortField: itemSortField,
    sortDir: itemSortDir,
    toggle: toggleItemSort,
  } = useTableSort<CapacityItemSortField>()

  /** Rank ascending is the ONLY order the cutline and the drag grip are defined in. */
  const inRankOrder = isRankOrder(itemSortField, itemSortDir)

  const sortedItems = useMemo(
    () =>
      sortCapacityItems(visibleItems, itemSortField, itemSortDir, (teamId) =>
        teamId === null ? null : (teamNameById.get(teamId) ?? null),
      ),
    [visibleItems, itemSortField, itemSortDir, teamNameById],
  )

  const rankableItems = useMemo(
    () => sortedItems.map((i) => ({ ...i, id: i.portfolioItemId })),
    [sortedItems],
  )

  const rerank = useRowRerank({
    items: rankableItems,
    // Rally ranks by dragging only "when the grid is set to the default sort order": under any other
    // sort the row's neighbours are not its rank neighbours, so a drop would rank it against rows it
    // does not sit between. The grip disappears rather than lying about what it will do.
    disabled: !canManage || !inRankOrder,
    onReorder: ({ id, beforeId, afterId }) =>
      rankItem.mutate({ id, beforeId, afterId }, { onError: (err) => notify.error(err.message) }),
  })

  /**
   * The BA's `Move up` / `Move down`, for either scope.
   *
   * `order` is the list the move happens INSIDE: the plan's rank order on the Features tab, and one
   * team's rows in its sub-table — the BA is explicit that a nested move swaps "with the adjacent row
   * inside the same Team only". Both persist through the SAME portfolio rank endpoint the drag uses,
   * because a plan's Feature order IS the portfolio rank; a plan-local order would disagree with the
   * Backlog the moment either changed.
   *
   * Returns `undefined` at the ends of the list, which is what removes the menu item rather than
   * offering one that cannot act. `beforeId`/`afterId` are the rows the item lands BETWEEN, so a move
   * up targets the pair one position higher.
   */
  const moveHandlers = useCallback(
    (portfolioItemId: string, order: readonly string[]) => {
      if (!canManage) return {}
      const at = order.indexOf(portfolioItemId)
      if (at === -1) return {}
      const run = (beforeId: string | null, afterId: string | null) => () =>
        rankItem.mutate(
          { id: portfolioItemId, beforeId, afterId },
          { onError: (err) => notify.error(err.message) },
        )
      return {
        ...(at > 0 ? { onMoveUp: run(at >= 2 ? order[at - 2] : null, order[at - 1]) } : {}),
        ...(at < order.length - 1
          ? { onMoveDown: run(order[at + 1], at + 2 < order.length ? order[at + 2] : null) }
          : {}),
      }
    },
    [canManage, rankItem],
  )

  /** The plan's teams as picker options, with Rally's/BA's `Unassign` first. */
  /**
   * Team id → team KEY, from the project's own teams.
   *
   * The plan payload names its teams but carries no key, and `TeamAvatar` falls back to the name's
   * initials — so `Team Gamma` drew `TG` here and `GA` (from key `GAMMA`) on the Portfolio grid, for one
   * team. The page already fetches the project's teams for the Add Teams dialog, so the key costs
   * nothing but this lookup.
   */
  const teamKeyOf = useCallback(
    (teamId: string | null | undefined) =>
      teamId == null ? null : (teams.find((tm) => tm.id === teamId)?.key ?? null),
    [teams],
  )

  const assignOptions = useMemo(
    () => [
      { value: '', label: t('items.unassign') },
      ...(plan?.teams ?? []).map((pt) => ({
        value: pt.teamId,
        label: pt.teamName ?? '--',
        // The square team glyph every other team picker in the app carries (Portfolio's
        // `TeamSelectCell`, the iteration and project pickers). Initials rather than a key, because the
        // plan payload names its teams but does not carry their keys.
        icon: <TeamAvatar teamKey={teamKeyOf(pt.teamId)} name={pt.teamName} size={16} />,
      })),
    ],
    [plan?.teams, t, teamKeyOf],
  )
  const revert = useRevertPlan()
  // Only for the pending flag on the toolbar button; the modal owns the publish call itself.
  const publish = usePublishPlan()
  const deletePlan = useDeleteCapacityPlan()
  const updatePlan = useUpdateCapacityPlan()
  // Publishing writes back to Feature rows, so it takes its OWN permission rather than
  // riding `capacity:manage` — a planner who may edit a draft is not automatically someone
  // who may stamp a release onto other people's Features.
  const canPublish = can('capacity:publish')

  // Client-side: the plan endpoint returns every team in one payload, so there is no page to
  // re-fetch and no server sort to ask for. Same `useTableSort` toggle semantics as every other
  // grid in the app, so clicking a header behaves identically here.
  const { sortField, sortDir, toggle } = useTableSort<CapacityTeamSortField>()

  const table = useDataTable<CapacityPlanTeam, unknown, TeamColKey>(CAPACITY_TEAM_COLUMNS, {
    storageKey: 'rally-capacity-team-columns',
    leadingWidth: 36,
    sort: {
      col: sortField ?? '',
      dir: sortDir ?? 'asc',
      onSort: (c) => toggle(c as CapacityTeamSortField),
    },
  })
  const colStyleFor = useCallback(
    (key: TeamColKey, base?: React.CSSProperties) => table.styleFor(key, base),
    [table],
  )
  // Its own column layout and storage key: the Items tab shows different columns, and sharing a
  // key would let one tab's resize silently rearrange the other.
  const itemTable = useDataTable<CapacityPlanItem, unknown, ItemColKey>(CAPACITY_ITEM_COLUMNS, {
    storageKey: 'rally-capacity-item-columns',
    sort: {
      col: itemSortField ?? '',
      dir: itemSortDir ?? 'asc',
      onSort: (c) => toggleItemSort(c as CapacityItemSortField),
    },
  })
  const itemColStyleFor = useCallback(
    (key: ItemColKey, base?: React.CSSProperties) => itemTable.styleFor(key, base),
    [itemTable],
  )

  const sortedTeams = useMemo(
    () =>
      sortCapacityTeams(plan?.teams ?? [], sortField, sortDir, (teamId) =>
        (plan?.allocations ?? []).reduce((n, a) => (a.teamId === teamId ? n + 1 : n), 0),
      ),
    [plan?.teams, plan?.allocations, sortField, sortDir],
  )

  const openFeature = useCallback(
    (portfolioItemId: string) =>
      void navigate({ to: '/portfolio/$itemId', params: { itemId: portfolioItemId } }),
    [navigate],
  )

  /**
   * Commits the header's inline rename.
   *
   * Held as a draft rather than written per keystroke: a PATCH per character would race the
   * refetch and make the field fight the cursor. Blank or unchanged reverts to the plan's name.
   */
  async function commitName() {
    const name = draftName.trim()
    if (name === '' || name === plan?.name) {
      setDraftName(plan?.name ?? '')
      return
    }
    try {
      await updatePlan.mutateAsync({ id: planId, patch: { name } })
    } catch (err) {
      notify.error(err instanceof Error ? err.message : t('renameFailed'))
      setDraftName(plan?.name ?? '')
    }
  }

  async function removePlan() {
    try {
      await deletePlan.mutateAsync(planId)
      notify.success(t('delete.planDone'))
      // Back to the list: the page we are on no longer describes anything.
      void navigate({ to: '/capacity-planning' })
    } catch (err) {
      notify.error(err instanceof Error ? err.message : t('delete.failed'))
    } finally {
      setConfirmDelete(false)
    }
  }

  /**
   * Rally's Feature-level verbs, shared by both grids.
   *
   * In a hook because the Features tab and a team's sub-table perform the SAME writes — the page was
   * the only thing holding them together, and one definition is what stops `Remove From Plan`
   * meaning different things on the two tabs.
   */
  const { removeFeature, assignFeature, unassignFeature, itemActionsFor } = usePlanItemActions({
    plan,
    planId,
    canManage,
    onAllocate: setAllocateFor,
    onMove: setMoveFor,
  })

  /**
   * The nested table's gear props: the shared verbs, plus a reorder scoped to THAT table's rows.
   *
   * A factory per sub-table rather than one resolver, because the scope is the argument — the BA's
   * nested move swaps "inside the same Team only", so each table has to pass its own row order.
   */
  const subTableActions = useCallback(
    () =>
      itemActionsFor === undefined
        ? undefined
        : (allocation: CapacityAllocation) => ({
            ...itemActionsFor(allocation),
            /**
             * PLAN-WIDE, not within the team whose rows these are.
             *
             * The BA scoped a nested move to "the adjacent row inside the same Team only", but rank is
             * GLOBAL — Rally: "changing rank in one page changes it across all pages" — so a move that
             * looked team-local still moved the Feature past whatever sat beside it in the plan. The
             * honest affordance is the one that says what it does: one order, moved by one place.
             */
            ...moveHandlers(
              allocation.portfolioItemId,
              (plan?.items ?? []).map((i) => i.portfolioItemId),
            ),
          }),
    [itemActionsFor, moveHandlers, plan?.items],
  )

  /**
   * Applies the dialog's selection as a DIFF against the plan's current teams.
   *
   * Removals first: a plan cannot hold a team twice, and doing them in one pass keeps the
   * intermediate states out of the cache.
   *
   * Dropping a team no longer fails when it carries demand — the API re-parks its rows as unassigned,
   * which is the BA's rule and the only outcome that leaves the demand reassignable. Those rows then
   * surface in the plan's Unallocated bucket, so nothing a planner committed disappears from view.
   */
  async function saveTeams(ids: string[]) {
    const onPlan = new Set((plan?.teams ?? []).map((pt) => pt.teamId))
    const next = new Set(ids)
    for (const teamId of [...onPlan].filter((id) => !next.has(id))) {
      await removeTeam.mutateAsync({ id: planId, teamId })
    }
    for (const teamId of ids.filter((id) => !onPlan.has(id))) {
      await addTeam.mutateAsync({ id: planId, teamId })
    }
  }

  if (isLoading) return <SkeletonList rows={6} />
  // Error BEFORE absence: one `phase` discriminant, so the two can never both be true.
  if (planResource.phase === 'error') return <LoadErrorState error={planResource.error} />
  if (!plan) return <EmptyState title={t('detail.notFound')} />

  const unitLabel = t(`units.${plan.unit}`)

  // Resolved from the plan on every render rather than held in state, so a refetch that
  // changes a team's capacity cannot leave the open modal showing a stale row.
  const forecastTeam = plan.teams.find((team) => team.teamId === forecastTeamId) ?? null

  return (
    <>
      <DetailLayout
        onBack={back}
        // The same three-part lead every detail surface in the app uses: glyph, key, title. The
        // glyph was missing here, so this was the one detail header whose key arrived unannounced.
        badge={<TypeBadge type="capacityPlan" />}
        itemKey={plan.planKey ?? undefined}
        copyLink={entityLinkFor('capacityPlan', plan.id, plan.planKey, plan.name)}
        title={
          // Editable in place, like a work item's title — a plan's name is the field most often
          // wrong at creation, and the alternative was opening Edit Plan Details for one word.
          // Read-only once published, which is the API's rule for every field on the plan.
          canManage ? (
            <input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={() => void commitName()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitName()
                // Escape abandons the edit rather than committing it, matching every inline cell.
                if (e.key === 'Escape') setDraftName(plan.name)
              }}
              className="w-full rounded border-0 bg-transparent px-1 py-0.5 text-base font-semibold text-white placeholder-white/60 focus:bg-white/10 focus:outline-none"
              aria-label={t('fields.name')}
            />
          ) : (
            plan.name
          )
        }
        status={<PlanHeaderStatus plan={plan} />}
        // No counts on the tabs: Rally does not badge them here, and the numbers are already on
        // the page — the team grid's row count and the summary panel's assigned/unassigned split
        // say the same thing without competing with the tab labels.
        tabs={[
          { key: 'teams', label: t('detail.tabs.teams') },
          // Rally's Features tab: the same plan seen by Feature rather than by team, and the only
          // surface its cutline belongs on.
          { key: 'items', label: t('detail.tabs.items') },
        ]}
        /* Rally's Actions menu, in Rally's order: `Edit Plan Details`, `Publish`/`Unpublish`,
           `Delete Plan`. Publishing lived on the toolbar here until this slice, which is
           not where Rally keeps it ("Select the Actions menu and select Publish") — and a plan is
           published once, so a permanent button spent the primary slot on a verb used at the very
           end. The verbs that change what the plan CONTAINS stay on the tab toolbars, because a
           planner reaches for those repeatedly while building it.
           Rally's `Export` is deliberately NOT here: it is out of scope for now. */
        actions={
          canPublish || can('capacity:manage') ? (
            <ActionMenu ariaLabel={t('detail.actionsLabel')} onDark>
              {/* Drafts only — the API refuses an edit to a published plan, so offering it would
                  collect changes the server will reject. */}
              {plan.status === 'draft' && can('capacity:manage') && (
                <ActionMenuItem
                  icon={<Pencil size={13} />}
                  label={t('edit.title')}
                  onClick={() => setShowEdit(true)}
                />
              )}
              {canPublish &&
                (plan.status === 'draft' ? (
                  <ActionMenuItem
                    icon={<Send size={13} />}
                    label={t('publish.action')}
                    disabled={publish.isPending}
                    onClick={() => setShowPublish(true)}
                  />
                ) : (
                  /* Rally's word is `Unpublish`, and it is the gate on every other edit: a
                     published plan is read-only until this runs. */
                  <ActionMenuItem
                    icon={<Undo2 size={13} />}
                    label={t('publish.revert.action')}
                    disabled={revert.isPending}
                    onClick={() => setConfirmRevert(true)}
                  />
                ))}
              {can('capacity:manage') && (
                <ActionMenuItem
                  icon={<Trash2 size={13} />}
                  label={t('delete.planAction')}
                  destructive
                  onClick={() => setConfirmDelete(true)}
                />
              )}
            </ActionMenu>
          ) : undefined
        }
        /* Rally's summary ROW, above the tabs: what the plan is planning on the left, how it
           measures up on the right. The measurements are a bordered panel rather than KPI cards,
           because the four figures are one reading of the plan and each needs the swatch of the
           bar segment it names. */
        summary={
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border-inner px-4 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-ui-xs text-muted-foreground">{t('summary.itemType')}</span>
              {/* A plan of Features and a plan of Epics look identical otherwise. Ours only plans
                  Features today, so this states a fact rather than offering a choice. */}
              <span className="rounded-full border border-border-subtle bg-surface-subtle px-2 py-px text-ui-xs font-semibold text-foreground">
                {t('items.featureType')}
              </span>
              <PlanAssignmentCounts plan={plan} />
            </div>
            <PlanSummaryMetrics plan={plan} unitLabel={unitLabel} />
          </div>
        }
        activeTab={tab}
        onTabChange={setTab}
      >
        {/* FULL WIDTH — no fields panel. Rally's capacity plan has none, and with one the eight
            team columns did not fit: the grid gained a horizontal scrollbar and Capacity, the base
            every percentage is taken from, fell off the right edge. Everything the panel held now
            lives in the header (window, target load), in the summary panel (unit, totals) or in the
            grid itself (per-team capacity, which the panel was repeating). */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-card">
          {/* The rail is a SIBLING of the toolbar-plus-grid column, not of the grid alone: Rally runs the
              divider from the tab strip down, with the rail's heading level with the toolbar and its
              column headings level with the grid's. With the rail inside the grid's own row, every band
              in it sat one row lower than the table it is read against. */}
          {/* `bg-page` on the ROW, `bg-card` on each panel: the strip of page grey left showing between
              them is the gutter the product draws between the Feature list and the rail. */}
          <div className="bg-page flex min-h-0 flex-1 overflow-hidden">
            {/* `min-w-0` so the left column may shrink under the rail: without it a flex child refuses to
                go below its content width and pushes the rail off the viewport. */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-card">
              {/* Rally's page actions, per tab: the Features tab gets `Show Filters` / `Show Fields`
                  beside its add button, the Teams tab has neither in Rally and keeps a plain row. */}
              {tab === 'items' ? (
                <FeaturesToolbar
                  canManage={canManage}
                  onAddFeatures={() => setAddFeaturesFor({ teamId: null })}
                  activeFilterCount={itemFilterCount}
                  ownerFilter={itemOwnerFilter}
                  onOwnerFilterChange={setItemOwnerFilter}
                  ownerTeams={itemOwners}
                  assignmentFilter={itemTeamFilter}
                  onAssignmentFilterChange={setItemTeamFilter}
                  planTeams={plan.teams}
                  fieldsMenuProps={itemTable.fieldsMenuProps}
                />
              ) : (
                <div className="flex items-center gap-2 border-b border-border-inner px-4 py-2">
                  {canManage && (
                    <Button size="sm" onClick={() => setShowTeams(true)}>
                      <Users size={13} /> {t('teams.action')}
                    </Button>
                  )}
                </div>
              )}

              {tab === 'items' ? (
                <DataTableFrame
                  header={itemTable.headerProps}
                  padClassName="px-3"
                  empty={
                    plan.items.length === 0 ? (
                      <EmptyState
                        icon={<Users size={28} className="text-border-strong" />}
                        title={t('items.empty')}
                      />
                    ) : undefined
                  }
                >
                  {/* Rally ranks by dragging the row, and only in the plan's own rank order —
                        which is the only order this grid offers, so the grip is always live for a
                        planner. Persisted through the PORTFOLIO rank: "when you change the rank of
                        an item in one page, you are changing the rank across all pages". */}
                  <DndContext {...rerank.dndContextProps}>
                    <SortableContext {...rerank.sortableContextProps}>
                      {rerank.items.map((item, index) => (
                        <SortableItemRow
                          key={item.portfolioItemId}
                          id={item.portfolioItemId}
                          disabled={!canManage}
                          label={t('items.dragLabel', { item: item.itemKey })}
                        >
                          {(dragHandle) => (
                            <div>
                              {/* Matched by ID, not by position: the rendered list is filtered, so an
                                    index into it can name a different Feature than the plan's own
                                    order does. Rank order only, which is the sort the cutline is
                                    defined in. */}
                              {inRankOrder && cutlineBeforeId === item.portfolioItemId && (
                                <CutlineDivider label={t('cutline.label')} />
                              )}
                              <CapacityItemRow
                                item={item}
                                // The plan's rank, never the row's position in a filtered list.
                                position={planRankOf.get(item.portfolioItemId) ?? index + 1}
                                primaryTeamName={teamNameById.get(item.primaryTeamId ?? '') ?? null}
                                belowCutline={
                                  inRankOrder && belowCutlineIds.has(item.portfolioItemId)
                                }
                                expanded={expandedItems.has(item.portfolioItemId)}
                                // The disclosure column exists only if something on the plan can
                                // actually disclose.
                                anySplitFeature={plan.items.some((i) => i.teamIds.length > 1)}
                                teamKeyOf={teamKeyOf}
                                onToggleExpanded={() => toggleItem(item.portfolioItemId)}
                                onRemove={canManage ? () => void removeFeature(item) : undefined}
                                onUnassign={
                                  canManage ? () => void unassignFeature(item) : undefined
                                }
                                onAllocate={
                                  canManage ? () => setAllocateFor(item.portfolioItemId) : undefined
                                }
                                onMove={
                                  canManage ? () => setMoveFor(item.portfolioItemId) : undefined
                                }
                                // Plan-wide scope here: the Features tab IS the plan's rank order.
                                {...moveHandlers(
                                  item.portfolioItemId,
                                  plan.items.map((i) => i.portfolioItemId),
                                )}
                                onAssign={
                                  canManage
                                    ? (teamId) => void assignFeature(item, teamId)
                                    : undefined
                                }
                                assignOptions={assignOptions}
                                dragHandle={dragHandle}
                                colStyleFor={itemColStyleFor}
                                onOpenFeature={openFeature}
                              />
                              {/* Rally: "each allocated project is listed as a row underneath the portfolio
                        item". PLAIN nested rows here, not a sub-table: unlike the team grid, these
                        children fill the SAME columns as their parent (one team's slice of
                        Complete / Rollup / Estimated), so a second header would repeat the one
                        above it. */}
                              {expandedItems.has(item.portfolioItemId) &&
                                (allocationsByItem.get(item.portfolioItemId) ?? []).map(
                                  (allocation) => (
                                    <ItemAllocationRow
                                      key={allocation.id}
                                      allocation={allocation}
                                      teamName={teamNameById.get(allocation.teamId ?? '') ?? null}
                                      teamKey={teamKeyOf(allocation.teamId)}
                                      colStyleFor={itemColStyleFor}
                                    />
                                  ),
                                )}
                            </div>
                          )}
                        </SortableItemRow>
                      ))}
                    </SortableContext>
                  </DndContext>
                </DataTableFrame>
              ) : (
                <DataTableFrame
                  header={table.headerProps}
                  padClassName="px-3"
                  empty={
                    plan.teams.length === 0 ? (
                      <EmptyState
                        icon={<Users size={28} className="text-border-strong" />}
                        title={t('detail.noTeams')}
                      />
                    ) : undefined
                  }
                >
                  {sortedTeams.map((team) => (
                    <div key={team.id}>
                      <CapacityTeamRow
                        planId={plan.id}
                        team={team}
                        unitLabel={unitLabel}
                        canManage={canManage}
                        colStyleFor={colStyleFor}
                        gutter={null}
                        onForecast={() => setForecastTeamId(team.teamId)}
                        expanded={expandedTeams.has(team.teamId)}
                        onToggleExpanded={() => toggleTeam(team.teamId)}
                        featureCount={allocationsByTeam.get(team.teamId)?.length ?? 0}
                        featuresRequiringAttention={
                          featuresNeedingAttentionByTeam.get(team.teamId) ?? 0
                        }
                      />
                      {/* Allocated Features sit under their team — one row per team, which is
                          how Rally groups a shared Feature — and DISCLOSED rather than always
                          on, because Rally collapses them until asked. No cutline here either:
                          Rally draws it on the Items tab against the plan's total capacity. */}
                      {expandedTeams.has(team.teamId) && (
                        <TeamAllocationsTable
                          planId={plan.id}
                          allocations={allocationsByTeam.get(team.teamId) ?? []}
                          canManage={canManage}
                          onOpenFeature={openFeature}
                          rankPositionOf={rankPositionOf}
                          onAddFeatures={
                            canManage
                              ? () =>
                                  setAddFeaturesFor({
                                    teamId: team.teamId,
                                    teamName: team.teamName,
                                  })
                              : undefined
                          }
                          sharingOf={sharingOf}
                          itemActions={subTableActions()}
                        />
                      )}
                    </div>
                  ))}

                  {/* NO `Unallocated` block here. The BA removed it from Teams by Total on 2026-07-28: a
                    Feature with no team "has no dedicated Unallocated Features block on Teams by
                    Total — the plan header still counts it under Unassigned, and it appears in the
                    Features tab carrying a `Not assigned` badge". Both of those are true, so this
                    section was a third place saying the same thing, and the only one that implied the
                    parked demand belonged to some team. */}
                </DataTableFrame>
              )}
            </div>

            {/* Rally's `Project Capacity` rail sits beside the Feature list — and only there. The
                cutline this tab draws is plan-wide, so the next question is which team has no room
                left; the team grid answers that per row already. */}
            {tab === 'items' && (
              <TeamCapacityRail teams={plan.teams} unitLabel={unitLabel} teamKeyOf={teamKeyOf} />
            )}
          </div>
        </div>
      </DetailLayout>

      {showEdit && <EditCapacityPlanModal plan={plan} onClose={() => setShowEdit(false)} />}

      {/* Reuses the shared `SelectionModal` — the same searchable checkbox list milestones use for
          their projects/teams/releases, so Rally's dialog costs no new component. Saving diffs the
          selection against the plan; unchecking a team that carries demand re-parks its rows rather
          than failing, so the demand lands in the Unallocated bucket to be reassigned. */}
      <SelectionModal
        open={showTeams}
        onClose={() => setShowTeams(false)}
        title={t('teams.title')}
        items={teams.map((team) => ({ id: team.id, name: team.name }))}
        selectedIds={plan.teams.map((pt) => pt.teamId)}
        onSave={saveTeams}
      />

      {/* Deleting a PUBLISHED plan is allowed — Rally allows it too — so the message says what
          survives: the Release and dates the plan stamped onto its Features are those Features'
          data now, and only a revert takes them back. */}
      <ConfirmDialog
        open={confirmDelete}
        title={t('delete.planTitle')}
        message={
          plan.status === 'published' ? t('delete.publishedWarning') : t('delete.planMessage')
        }
        confirmLabel={t('delete.confirm')}
        destructive
        pending={deletePlan.isPending}
        onConfirm={() => void removePlan()}
        onCancel={() => setConfirmDelete(false)}
      />

      {addFeaturesFor !== null && (
        <AddFeaturesModal
          plan={plan}
          teamId={addFeaturesFor.teamId}
          teamName={addFeaturesFor.teamName}
          onClose={() => setAddFeaturesFor(null)}
        />
      )}

      {/* Rally's per-item `Allocate`: split ONE Feature across teams. Opened from that Feature's own
          menu, never as the way to put it on the plan — that is `Add Features`. */}
      {allocateFor !== null && (
        <AllocateFeatureModal
          plan={plan}
          portfolioItemId={allocateFor}
          onClose={() => setAllocateFor(null)}
        />
      )}
      {/* Rally's `Move To Another Plan`. The Feature's OWN release goes in, because that is what
          decides whether the dialog's release checkbox has any work to do. */}
      {moveFor !== null && (
        <MoveToPlanModal
          plan={plan}
          portfolioItemId={moveFor}
          itemKey={plan.items.find((i) => i.portfolioItemId === moveFor)?.itemKey ?? ''}
          itemReleaseId={plan.items.find((i) => i.portfolioItemId === moveFor)?.releaseId ?? null}
          onClose={() => setMoveFor(null)}
        />
      )}
      {forecastTeam && (
        <CapacityForecastModal
          planId={plan.id}
          team={forecastTeam}
          unitLabel={unitLabel}
          canManage={canManage}
          onClose={() => setForecastTeamId(null)}
        />
      )}
      {showPublish && <PublishPlanModal plan={plan} onClose={() => setShowPublish(false)} />}
      <ConfirmDialog
        open={confirmRevert}
        title={t('publish.revert.title')}
        message={t('publish.revert.message')}
        confirmLabel={t('publish.revert.confirm')}
        pending={revert.isPending}
        onCancel={() => setConfirmRevert(false)}
        onConfirm={() => {
          revert.mutate(
            { id: plan.id },
            {
              // The toast repeats that the Feature fields were left alone — the dialog says it
              // too, but this is the moment a planner might expect an undo to have happened.
              onSuccess: () => notify.success(t('publish.revert.done')),
              onError: (err) => notify.error(err.message),
            },
          )
          setConfirmRevert(false)
        }}
      />
    </>
  )
}
