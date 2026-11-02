/**
 * Central query-invalidation registry (tag-based, à la RTK Query).
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Every mutation must refresh EVERY cached read-model its write can affect
 * (lists, details, pickers/options feeds, dashboards, cross-entity views).
 * Historically each mutation hand-listed those keys in its own `onSuccess`,
 * which drifted — a freshly created iteration was missing from the iteration
 * picker feed because `useCreateIteration` forgot to invalidate
 * `['iteration-options']`. One forgotten root = one stale-cache bug.
 *
 * Here the dependency graph lives in ONE place. A mutation declares WHAT it
 * changed via `meta.invalidates` (coarse entity tags) and/or `meta.invalidateKeys`
 * (narrow, instance-specific keys); the global {@link MutationCache} handler in
 * `query-client.ts` decides WHICH cache entries to refresh. Mutations no longer
 * carry invalidation logic in `onSuccess` (that is reserved for optimistic
 * `setQueryData` seeds + navigation).
 *
 * A second benefit: `MutationCache` callbacks are global and fire even when the
 * component that launched the mutation has unmounted (e.g. a create modal that
 * closes on success) — per-observer `useMutation({ onSuccess })` callbacks do
 * not guarantee that. Centralising invalidation here removes that footgun too.
 *
 * ── No feature imports on purpose ────────────────────────────────────────────
 * Roots are written as literal key prefixes (not `xxxKeys.all` imports) so this
 * module stays in the shared layer with no dependency on any feature slice and
 * no import cycle. `invalidateQueries` matches by key prefix, so a root such as
 * `['work-items']` refreshes every `['work-items', …]` entry. The integrity test
 * `query-invalidation.integrity.test.ts` guards that these literals still match
 * the roots each feature's key-factory actually exports.
 */
import { MutationCache, type QueryClient, type QueryKey } from '@tanstack/react-query'

// ── Read-model root groups (reused across tags) ──────────────────────────────

/**
 * Every read-model that renders work-item-DERIVED data (fields, schedule/flow
 * state, hours, assignees, links). Any write to a work item, task, defect or
 * time log must refresh all of these. Kept as its own export because the
 * work-item integrity test pins it explicitly.
 */
export const WORK_ITEM_VIEW_ROOTS: readonly QueryKey[] = [
  // ...and `story-options`, the Parent Story picker's feed, which shares this prefix on purpose:
  // creating or renaming a Story must change what that picker offers.
  ['work-items'], // backlog, list, detail, by-key, tasks, task-totals, activity, time-logs, watchers, labels
  ['iteration-status'], // Iteration Status board/grid + read-model
  ['team-status'], // Team Status
  ['quality'], // Quality / Defects
  ['portfolio'], // Portfolio tree
  ['reports'], // every Phase 6 report — burndown, velocity, team capacity, release tracking
  ['child-defects'], // child defects under a story
]

/** Home/global dashboards derived from work items (separate, non-prefixed roots). */
const WORK_ITEM_DASHBOARD_ROOTS: readonly QueryKey[] = [
  ['my-work-items'],
  ['work-item-counts'],
  ['home'],
]

/**
 * Capacity planning read-models.
 *
 * Its own group because a capacity plan is downstream of SEVERAL entities: it renders a
 * Release name and a Team name per row, and from the allocation slice onwards its
 * Complete/Rollup numbers derive from portfolio items and their child work items. So a
 * release, team or portfolio write must refresh capacity too.
 */
const CAPACITY_ROOTS: readonly QueryKey[] = [['capacity-plans'], ['capacity-plan']]

/**
 * Full work-item fan-out = derived views + dashboards + relation graph + CAPACITY.
 *
 * Capacity belongs here because a plan's Complete/Rollup numbers are sums over child work items:
 * accepting a Story, re-pointing it, or linking it to a Feature all change what a capacity plan
 * reports. The group's own comment already said a portfolio write must refresh capacity — a WORK
 * ITEM write does too, and that was missing until the Story→Feature link made it visible.
 */
const WORK_ITEM_ALL: readonly QueryKey[] = [
  ...WORK_ITEM_VIEW_ROOTS,
  ...WORK_ITEM_DASHBOARD_ROOTS,
  ...CAPACITY_ROOTS,
  ['work-item-relations'],
]

// Each entity owns several non-overlapping roots (e.g. iterations split their
// list / detail / picker-feed / status read-model across distinct keys).
const ITERATION_ROOTS: readonly QueryKey[] = [
  ['iterations'], // list + committed-count
  ['iteration'], // detail + activity (singular)
  ['iteration-options'], // REFERENCE feed, every state (was the forgotten root)
  ['iteration-assignable'], // ELIGIBILITY feed — a SECOND root, because it is a separate endpoint
  // with its own cache key: a created, renamed or re-dated iteration has to reach the assignment
  // pickers as well as the label/filter feed. (It no longer filters by STATE — P6-VEL-004 — so a
  // commit or accept changes the label a picker shows, not whether the row is in it.)
  ['iteration-status'], // status read-model
]
// `reports` is here because Release Tracking classifies from `Release.id` on Features and their
// children: renaming, re-dating or deleting a release changes the page's buckets and its burnup
// window, not just the release list.
const RELEASE_ROOTS: readonly QueryKey[] = [['releases'], ['release'], ['reports']]
const MILESTONE_ROOTS: readonly QueryKey[] = [['milestones'], ['milestone']]
const PROJECT_ROOTS: readonly QueryKey[] = [
  ['projects'],
  ['project-statuses'],
  ['project-labels'],
  ['status-map'],
]
// Team Capacity is a projection of Team Status, so a capacity edit there has to refresh it.
//
// `workspace-members-profile` is here because the User Management roster carries each member's
// `teams` array — it is a MEMBERSHIP view, and the BA's team-membership ruling requires every
// membership view to agree after a change ("Team details and other membership views must agree").
// Its own root sits under `workspace`, so before this a team add/remove refreshed the team's roster
// and the team list's `memberCount` while the workspace roster kept the old `teams` array: two
// screens, one fact, one of them stale. It is declared here rather than listed by hand at each call
// site for the reason this whole module exists — one forgotten root is one stale-cache bug, and
// there are now three writes (add member, remove member, set project access) that move this fact.
const TEAM_ROOTS: readonly QueryKey[] = [
  ['teams'],
  ['team-status'],
  ['reports'],
  ['workspace-members-profile'],
]
const WORKSPACE_ROOTS: readonly QueryKey[] = [
  ['workspaces'],
  ['workspace-settings'],
  ['workspace-members-profile'],
  ['workspace-invitations'],
  ['system-roles'],
]
// `permission-catalog` is gone with `GET /v1/access/permissions`: custom roles and the editable
// permission matrix were deleted by ruling (2026-08-14, AC-11), and the READ-ONLY Permission Model tab
// renders from the frontend catalogue mirror rather than from the API, so nothing fetches that key.
const ACCESS_ROOTS: readonly QueryKey[] = [['my-project-permissions'], ['role-catalog']]

/** De-duplicate roots so a shared root (e.g. `iteration-status`) fires once. */
function dedup(roots: readonly QueryKey[]): QueryKey[] {
  const seen = new Set<string>()
  const out: QueryKey[] = []
  for (const key of roots) {
    const id = JSON.stringify(key)
    if (!seen.has(id)) {
      seen.add(id)
      out.push(key)
    }
  }
  return out
}

// ── Tag → roots registry ─────────────────────────────────────────────────────
// Coarse entity tags fan out to the entity's own roots PLUS every cross-entity
// view the write can touch (an iteration's name/state shows on work-item rows;
// a release/milestone assignment shows on work items; etc.). Over-invalidation
// is cheap — `invalidateQueries` only REFETCHES mounted queries and merely marks
// the rest stale — so we favour a correct, consistent fan-out over hand-tuning.

export type EntityTag =
  | 'work-item'
  | 'iteration'
  | 'release'
  | 'milestone'
  | 'project'
  | 'team'
  | 'quality'
  | 'portfolio'
  | 'capacity'
  | 'workspace'
  | 'access'
  | 'notification'
  | 'comments'
  | 'attachments'
  | 'api-token'

export const INVALIDATION_MAP: Record<EntityTag, QueryKey[]> = {
  'work-item': dedup(WORK_ITEM_ALL),
  iteration: dedup([...ITERATION_ROOTS, ...WORK_ITEM_ALL]),
  release: dedup([...RELEASE_ROOTS, ...WORK_ITEM_ALL, ...CAPACITY_ROOTS]),
  milestone: dedup([...MILESTONE_ROOTS, ...WORK_ITEM_ALL]),
  project: dedup([...PROJECT_ROOTS, ...WORK_ITEM_DASHBOARD_ROOTS]),
  team: dedup([...TEAM_ROOTS, ...WORK_ITEM_DASHBOARD_ROOTS, ...CAPACITY_ROOTS]),
  quality: dedup([['quality'], ...WORK_ITEM_DASHBOARD_ROOTS]),
  // A Feature's release, team or top-down estimate all move Release Tracking's buckets and its
  // Preliminary Estimate line.
  portfolio: dedup([['portfolio'], ...CAPACITY_ROOTS, ['reports']]),
  capacity: dedup(CAPACITY_ROOTS),
  workspace: dedup(WORKSPACE_ROOTS),
  access: dedup([...ACCESS_ROOTS, ['workspace-members-profile']]),
  notification: [['notifications']],
  comments: [['comments']],
  attachments: [['attachments']],
  // Nothing else derives from a personal API token: no list, picker or dashboard reads one. So the
  // tag is its own root rather than being folded into `workspace`, which would refresh nineteen
  // read-models to update one card.
  'api-token': [['api-tokens']],
}

// ── Mutation meta contract ───────────────────────────────────────────────────
// Type `mutation.meta` app-wide so `meta: { invalidates: [...] }` is checked.

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: {
      /** Coarse entity tags — expand to root sets via {@link INVALIDATION_MAP}. */
      invalidates?: EntityTag[]
      /**
       * Narrow, instance-specific keys the tag map can't express id-agnostically
       * (e.g. `workItemKeys.watchers(id)`, `commentKeys.list(id)`).
       */
      invalidateKeys?: QueryKey[]
    }
  }
}

type InvalidationMeta = {
  invalidates?: EntityTag[]
  invalidateKeys?: QueryKey[]
}

/** Run the invalidation declared by a mutation's `meta`. Exported for tests. */
export function runInvalidation(qc: QueryClient, meta: InvalidationMeta | undefined): void {
  if (!meta) return
  const keys: QueryKey[] = []
  for (const tag of meta.invalidates ?? []) keys.push(...INVALIDATION_MAP[tag])
  for (const key of meta.invalidateKeys ?? []) keys.push(key)
  for (const queryKey of dedup(keys)) void qc.invalidateQueries({ queryKey })
}

/**
 * Build the shared {@link MutationCache}. The `onSuccess` handler is the single
 * place cache invalidation happens for the whole app; it runs for every mutation
 * regardless of whether its originating component is still mounted.
 */
export function createInvalidationMutationCache(getClient: () => QueryClient): MutationCache {
  return new MutationCache({
    onSuccess: (_data, _vars, _ctx, mutation) => {
      runInvalidation(getClient(), mutation.meta as InvalidationMeta | undefined)
    },
  })
}
