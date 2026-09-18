/**
 * Work Items API hooks — TanStack Query wrappers for Phase 1.
 * All types derive from the generated OpenAPI contract (never hand-written).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/shared/api/http-client'
import { ApiError, apiErrorMessage } from '@/shared/api/api-error'
import type { components } from '@/shared/api/generated/api'
import { withCsrfHeader } from '@/shared/api/csrf'

// The Parent Story picker's feed lives in its own file (see `story-options.ts`) and is re-exported
// here so the three surfaces that use it import from the one work-items API barrel like everything
// else. Split out only because this file is the SPA's file-length ratchet holder.
export { useStoryOptions, type StoryOption } from './story-options'
// Split a User Story (Phase 7 SU) — same reason as above. A blanket re-export, not a named list,
// because this file sits ~11 lines under the 929 file-length ratchet and a named list of eight
// symbols does not fit: SU-01 measured 930 and the ratchet refused it. EVERYTHING Split adds to the
// SPA api layer (SU-06's `useSplitWorkItem` included) belongs in `split-api.ts`, so this line never
// has to grow again.
export * from './split-api'
// The RECORD read's shape (SU-07) — declared, with its reasoning, in `split-api.ts`. Type-only, and
// from the module this file already re-exports, so there is no cycle.
import type { WorkItemDetail } from './split-api'

// ── Response types from generated contract ────────────────────────────────────

export type WorkItem = components['schemas']['WorkItemResponseDto']
export type ActivityLog = components['schemas']['ActivityResponseDto']
export type TaskTotals = components['schemas']['TaskTotalsResponseDto']
export type Watcher = components['schemas']['WatcherResponseDto']

// ── Convenience aliases (BA design names) ─────────────────────────────────────

export type WiType = WorkItem['type']
export type WiPriority = WorkItem['priority']
export type WiScheduleState = WorkItem['scheduleState']

// ── Query keys ────────────────────────────────────────────────────────────────

/**
 * Build a stable, deterministic string from filter values so that
 * TanStack Query's key-hash always changes when any value changes.
 * (JSON.stringify drops undefined properties, which causes collisions.)
 */
function filterHash(f: Record<string, unknown>): string {
  return Object.entries(f)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
}

export const workItemKeys = {
  all: ['work-items'] as const,
  list: (projectId: string, filters?: Record<string, unknown>) =>
    [...workItemKeys.all, 'list', projectId, filterHash(filters ?? {})] as const,
  backlog: (projectId: string, filters?: Record<string, unknown>) =>
    [...workItemKeys.all, 'backlog', projectId, filterHash(filters ?? {})] as const,
  detail: (id: string) => [...workItemKeys.all, 'detail', id] as const,
  byKey: (itemKey: string) => [...workItemKeys.all, 'by-key', itemKey] as const,
  tasks: (workItemId: string) => [...workItemKeys.all, 'tasks', workItemId] as const,
  taskTotals: (workItemId: string) => [...workItemKeys.all, 'task-totals', workItemId] as const,
  activity: (workItemId: string) => [...workItemKeys.all, 'activity', workItemId] as const,
  watchers: (workItemId: string) => [...workItemKeys.all, 'watchers', workItemId] as const,
  labels: (workItemId: string) => [...workItemKeys.all, 'labels', workItemId] as const,
  milestones: (workItemId: string) => [...workItemKeys.all, 'milestones', workItemId] as const,
} as const

// ── Backlog list ──────────────────────────────────────────────────────────────

export interface BacklogFilters {
  type?: 'story' | 'defect'
  scheduleState?: WiScheduleState
  priority?: WiPriority
  assigneeId?: string
  /** Dev Owner, filtered like Owner including the `unassigned` sentinel (`P2-BL-FR-004`). */
  devOwnerId?: string
  iterationId?: string
  releaseId?: string
  teamId?: string
  q?: string
  /**
   * Manage Filters column predicates (P2-BL-FR-005/006). Server-side, and
   * deliberately separate from `q`: P2-BL-TS-015 requires quick search to keep
   * working independently of the Manage Filters set, so the API ANDs the two.
   */
  itemKey?: string
  title?: string
  /** Exact `story_points` match, as typed (the API accepts up to 2 decimals). */
  planEstimate?: string
  /** Server-side sort as `"<field>[:asc|:desc]"`; omit for the default rank order. */
  sort?: string
  limit?: number
  cursor?: string
}

/**
 * One page of the backlog, as the API returns it.
 *
 * Extracted from `useBacklog` so `useRankToBacklogEdge` can ask the same question with a different
 * sort without restating the eleven-parameter mapping — two copies would drift the moment a filter
 * is added, and the whole point of that hook is that it queries the SAME list the grid shows.
 */
export async function fetchBacklogPage(projectId: string, filters: BacklogFilters = {}) {
  const { data, error, response } = await apiClient.GET('/v1/work-items/backlog', {
    params: {
      query: {
        projectId,
        type: filters.type as 'story' | 'defect' | undefined,
        scheduleState: filters.scheduleState as
          'idea' | 'defined' | 'in_progress' | 'completed' | 'accepted' | 'release' | undefined,
        priority: filters.priority as 'none' | 'low' | 'normal' | 'high' | 'urgent' | undefined,
        assigneeId: filters.assigneeId,
        devOwnerId: filters.devOwnerId,
        iterationId: filters.iterationId,
        releaseId: filters.releaseId,
        teamId: filters.teamId,
        q: filters.q,
        itemKey: filters.itemKey,
        title: filters.title,
        planEstimate: filters.planEstimate,
        sort: filters.sort,
        limit: filters.limit ?? 50,
        cursor: filters.cursor,
      },
    },
  })
  if (error) throw new Error(apiErrorMessage(error, response.status))
  const res = data as
    | {
        data?: WorkItem[]
        pageInfo?: {
          hasNextPage: boolean
          nextCursor: string | null
          limit: number
          total?: number
        }
      }
    | undefined
  return {
    data: res?.data ?? [],
    pageInfo: res?.pageInfo ?? { hasNextPage: false, nextCursor: null, limit: 50, total: 0 },
  }
}

export function useBacklog(projectId: string | undefined, filters: BacklogFilters = {}) {
  return useQuery({
    queryKey: workItemKeys.backlog(projectId ?? '', filters as Record<string, unknown>),
    queryFn: async () => {
      if (!projectId)
        return { data: [], pageInfo: { hasNextPage: false, nextCursor: null, limit: 25, total: 0 } }
      return fetchBacklogPage(projectId, filters)
    },
    enabled: !!projectId,
    staleTime: 15_000,
  })
}

// ── Work Item detail ──────────────────────────────────────────────────────────

export function useWorkItem(id: string | undefined) {
  return useQuery({
    queryKey: workItemKeys.detail(id ?? ''),
    queryFn: async () => {
      if (!id) return null
      const { data, error, response } = await apiClient.GET('/v1/work-items/{id}', {
        params: { path: { id } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as WorkItem
    },
    enabled: !!id,
    staleTime: 15_000,
  })
}

/**
 * Resolve an item KEY (Rally FormattedID, e.g. `US-3`) to its work item via
 * `GET /v1/work-items/by-key`, which falls back to the tasks table server-side so task detail
 * pages are reachable too. Keys are workspace-unique, so no project context is needed — which is
 * exactly what makes `/item/$itemKey` a valid deep link with no project in the URL.
 *
 * `null` means "no such key" (a 404), distinct from `undefined`, which — as everywhere in this
 * file — means the query has not answered yet.
 *
 * Exposed as query OPTIONS as well as a hook because the `/item/$itemKey` route loader resolves the
 * item outside React, to learn which project a deep link belongs to before the first paint. Same
 * key, so the loader's fetch warms the cache every hook caller reads: one request, not two.
 *
 * IT THROWS `ApiError`, NOT `Error`, and that is load-bearing (GAP-P4-RBAC-003, AC6). This route is
 * `AuthorizedInService` — it loads the row, resolves its project and then asserts `work_item:view` —
 * so a reader with no access to the owning project gets a **403**, not a 404. A plain `Error` discards
 * the status, and the page could then only say "not found" for a refusal, a 500 and a genuinely
 * absent key alike. Two things depend on the status surviving:
 *   • `pages/work-item/work-item-detail-page.tsx` renders `AccessDenied` for 403 and `LoadErrorState`
 *     for anything else, instead of one screen for three different sentences;
 *   • `queryClient`'s own `retry` predicate reads `error.status` to stop retrying 4xx — with a plain
 *     `Error` it saw `undefined` and retried a refusal.
 */
export function workItemByKeyQueryOptions(itemKey: string) {
  return {
    queryKey: workItemKeys.byKey(itemKey),
    queryFn: async (): Promise<WorkItemDetail | null> => {
      if (!itemKey) return null
      const { data, error, response } = await apiClient.GET('/v1/work-items/by-key', {
        params: { query: { itemKey } },
      })
      if (error) {
        if (response.status === 404) return null
        throw new ApiError(error, response.status)
      }
      return (data as WorkItemDetail | undefined) ?? null
    },
    staleTime: 15_000,
  }
}

export function useWorkItemByKey(itemKey: string | undefined) {
  return useQuery({ ...workItemByKeyQueryOptions(itemKey ?? ''), enabled: !!itemKey })
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

export function useTasks(workItemId: string | undefined) {
  return useQuery({
    queryKey: workItemKeys.tasks(workItemId ?? ''),
    queryFn: async () => {
      if (!workItemId) return []
      const { data, error, response } = await apiClient.GET('/v1/work-items/{id}/tasks', {
        params: { path: { id: workItemId } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      // API returns WorkItemResponseDto[] directly (not wrapped)
      return (data as WorkItem[]) ?? []
    },
    enabled: !!workItemId,
    staleTime: 15_000,
  })
}

export function useTaskTotals(workItemId: string | undefined) {
  return useQuery({
    queryKey: workItemKeys.taskTotals(workItemId ?? ''),
    queryFn: async () => {
      if (!workItemId) return null
      const { data, error, response } = await apiClient.GET('/v1/work-items/{id}/tasks/totals', {
        params: { path: { id: workItemId } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as TaskTotals
    },
    enabled: !!workItemId,
    staleTime: 15_000,
  })
}

// ── Child Defects (defects with parentId set to a story) ────────────────────
//
// CURRENTLY NO CALLER, deliberately kept. Its one consumer was the Work Item `Defects` tab,
// removed under `GAP-P1-WID-001` (the BA's approved Phase 1 tab structure is Details / Tasks /
// Revision History). The parent-child link itself is untouched, so the binding stays valid and
// `childDefectsKeys` is still pinned by `query-invalidation.integrity.test.ts`. Delete both
// together if the relationship is ever dropped — not because this looks unused.

export const childDefectsKeys = {
  all: ['child-defects'] as const,
  byParent: (parentId: string) => [...childDefectsKeys.all, parentId] as const,
}

export function useChildDefects(parentId: string | undefined, projectId?: string) {
  return useQuery({
    queryKey: childDefectsKeys.byParent(parentId ?? ''),
    queryFn: async () => {
      if (!parentId) return []
      const { data, error, response } = await apiClient.GET('/v1/work-items', {
        params: {
          query: {
            projectId: projectId ?? '',
            parentId,
            type: 'defect' as const,
            limit: 100,
          },
        },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return (data as { data?: WorkItem[] } | undefined)?.data ?? []
    },
    enabled: !!parentId && !!projectId,
    staleTime: 15_000,
  })
}

// ── Activity Log ──────────────────────────────────────────────────────────────

export function useActivityLog(workItemId: string | undefined) {
  return useQuery({
    queryKey: workItemKeys.activity(workItemId ?? ''),
    queryFn: async () => {
      if (!workItemId) return []
      const { data, error, response } = await apiClient.GET('/v1/work-items/{id}/activity', {
        params: { path: { id: workItemId }, query: { page: 1, pageSize: 100 } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      // API returns { data: ActivityResponseDto[]; total: number; page: number; pageSize: number }
      return (data as { data?: ActivityLog[] } | undefined)?.data ?? []
    },
    enabled: !!workItemId,
    staleTime: 15_000,
  })
}

// ── Labels (Tags) ─────────────────────────────────────────────────────────────

/** A label/tag attached to a work item (from the labels endpoint). */
export interface WorkItemLabel {
  id: string
  name: string
  color: string
}

export function useWorkItemLabels(workItemId: string | undefined) {
  return useQuery({
    queryKey: workItemKeys.labels(workItemId ?? ''),
    queryFn: async () => {
      if (!workItemId) return []
      const { data, error, response } = await apiClient.GET('/v1/work-items/{id}/labels', {
        params: { path: { id: workItemId } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return (data ?? []) as WorkItemLabel[]
    },
    enabled: !!workItemId,
    staleTime: 15_000,
  })
}

export interface WorkItemMilestone {
  id: string
  name: string
}

/** Milestones currently assigned to a work item (Story/Defect). */
export function useWorkItemMilestones(workItemId: string | undefined) {
  return useQuery({
    queryKey: workItemKeys.milestones(workItemId ?? ''),
    queryFn: async () => {
      if (!workItemId) return []
      const { data, error, response } = await apiClient.GET('/v1/work-items/{id}/milestones', {
        params: { path: { id: workItemId } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return (data ?? []) as WorkItemMilestone[]
    },
    enabled: !!workItemId,
    staleTime: 15_000,
  })
}

/**
 * Replace-set the milestones assigned to a work item. Mirrors the label
 * association pattern; the read-models that surface milestones (iteration
 * status, backlog) are refreshed on success.
 */
export function useSetWorkItemMilestones(workItemId: string) {
  return useMutation({
    mutationFn: async (milestoneIds: string[]) => {
      const { data, error, response } = await apiClient.PUT('/v1/work-items/{id}/milestones', {
        params: { path: { id: workItemId } },
        body: { ids: milestoneIds },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return (data ?? []) as WorkItemMilestone[]
    },
    meta: { invalidates: ['work-item'] },
  })
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export type CreateWorkItemInput = components['schemas']['CreateWorkItemDto']
export type UpdateWorkItemInput = components['schemas']['UpdateWorkItemDto']
export type CreateTaskInput = components['schemas']['CreateTaskDto']

export function useCreateWorkItem() {
  return useMutation({
    mutationFn: async (input: CreateWorkItemInput) => {
      const { data, error, response } = await apiClient.POST('/v1/work-items', { body: input })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as WorkItem
    },
    // Refresh every work-item-derived read-model + dashboard (Backlog, Iteration
    // Status, Team Status, Quality, Portfolio, Reports, My Work, counts) so the
    // new item appears everywhere it belongs without a manual reload.
    meta: { invalidates: ['work-item'] },
  })
}

export function useUpdateWorkItem(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: UpdateWorkItemInput) => {
      const { data, error, response } = await apiClient.PATCH('/v1/work-items/{id}', {
        params: { path: { id } },
        body: input,
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as WorkItem
    },
    // Instant, flash-free update of the surfaces the user is most likely looking
    // at when editing inline: the detail page and the backlog row. The global
    // registry then refreshes every other work-item-derived read-model.
    onSuccess: (item) => {
      qc.setQueryData(workItemKeys.detail(id), item)
      // Must pass projectId to match the exact cache key used by useWorkItemByKey().
      qc.setQueriesData({ queryKey: workItemKeys.byKey(item.itemKey) }, item)
      qc.setQueriesData<{ data?: WorkItem[]; pageInfo?: unknown }>(
        { queryKey: workItemKeys.backlog(item.projectId) },
        (old) => {
          if (!old?.data) return old
          return { ...old, data: old.data.map((w) => (w.id === item.id ? item : w)) }
        },
      )
    },
    meta: { invalidates: ['work-item'] },
  })
}

export function useCreateTask(parentId: string) {
  return useMutation({
    mutationFn: async (input: CreateTaskInput) => {
      const { data, error, response } = await apiClient.POST('/v1/work-items/{id}/tasks', {
        params: { path: { id: parentId } },
        body: input,
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as WorkItem
    },
    meta: { invalidates: ['work-item'] },
  })
}

export function useDeleteWorkItem() {
  return useMutation({
    mutationFn: async ({ id, projectId }: { id: string; projectId: string }) => {
      const { error, response } = await apiClient.DELETE('/v1/work-items/{id}', {
        params: { path: { id } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return projectId
    },
    meta: { invalidates: ['work-item'] },
  })
}

/**
 * Update a work item by id supplied at call time (vs. `useUpdateWorkItem(id)`
 * which binds the id when the hook is created). Enables bulk operations that
 * iterate over a selection — a single mutation instance can be reused for every
 * id, which the Rules of Hooks forbid with the id-bound variant.
 */
export function useUpdateAnyWorkItem() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdateWorkItemInput }) => {
      const { data, error, response } = await apiClient.PATCH('/v1/work-items/{id}', {
        params: { path: { id } },
        body: input,
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as WorkItem
    },
    onSuccess: (item) => {
      qc.setQueryData(workItemKeys.detail(item.id), item)
      qc.setQueriesData({ queryKey: workItemKeys.byKey(item.itemKey) }, item)
    },
    meta: { invalidates: ['work-item'] },
  })
}

/**
 * Header search: work items in the ACTIVE project matching a free-text term.
 *
 * Backs `SHELL-FR-009` ("Global search entry opens a search overlay/page"), which shipped as an
 * input bound to nothing at all — `searchQuery` appeared at exactly two lines in `app-shell.tsx`,
 * the `useState` and the `value`, with no submit handler, no navigation and no query. Typing and
 * Enter both did nothing, on every screen.
 *
 * PROJECT-SCOPED, not workspace-wide, and that is a real limitation rather than an oversight. The
 * only cross-project resolver is `GET /work-items/by-key`, which needs an EXACT key; free-text
 * search exists solely as `GET /work-items?projectId=&q=`, whose `q` covers `item_key`, `title` and
 * the `search_vector` FTS column server-side. A workspace-wide search needs an endpoint that does
 * not exist, so the header searches the project you are in and the placeholder says so. Note it
 * deliberately uses the unrestricted list and NOT `/work-items/backlog`, which is unscheduled work
 * only — searching from the header must find a story that is already in a sprint.
 */
export function useWorkItemSearch(projectId: string | undefined, term: string, limit = 8) {
  const q = term.trim()
  return useQuery({
    queryKey: [...workItemKeys.all, 'search', projectId ?? '', q, limit] as const,
    queryFn: async () => {
      const { data, error, response } = await apiClient.GET('/v1/work-items', {
        params: { query: { projectId: projectId!, q, limit } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return (data as { data?: WorkItem[] } | undefined)?.data ?? []
    },
    // Two characters minimum: a single letter matches most of the project and costs a round trip per
    // keystroke to say so.
    enabled: !!projectId && q.length >= 2,
    staleTime: 15_000,
  })
}

// ── Legacy hooks (used by home page) ─────────────────────────────────────────

export interface ListWorkItemsParams {
  projectId: string
  type?: WiType
  statusId?: string
  assigneeId?: string
  iterationId?: string
  releaseId?: string
  /**
   * Server-side search over key and title (`WorkItemQuerySchema.q`).
   *
   * The API has always accepted it and this hook did not forward it, so every caller had to filter the
   * page it happened to hold. That is what made the Release artifacts picker unable to offer an item
   * outside its first 100: the search box narrowed 100 rows instead of asking for the matching one.
   */
  q?: string
  limit?: number
}

export function useWorkItems(params: ListWorkItemsParams | null) {
  return useQuery({
    queryKey: workItemKeys.list(
      params?.projectId ?? '',
      (params as unknown as Record<string, unknown>) ?? {},
    ),
    queryFn: async () => {
      if (!params) return []
      const { data, error, response } = await apiClient.GET('/v1/work-items', {
        params: {
          query: {
            projectId: params.projectId,
            type: params.type as 'story' | 'task' | 'defect' | undefined,
            statusId: params.statusId,
            assigneeId: params.assigneeId,
            iterationId: params.iterationId,
            releaseId: params.releaseId,
            q: params.q,
            limit: params.limit ?? 100,
          },
        },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return (data as { data?: WorkItem[] } | undefined)?.data ?? []
    },
    enabled: !!params,
    staleTime: 30_000,
  })
}

export function useMyWorkItems(
  projects: Array<{ id: string; key: string; name: string }>,
  userId: string | undefined,
) {
  return useQuery({
    queryKey: ['my-work-items', [...projects.map((p) => p.id)].sort(), userId],
    queryFn: async () => {
      if (!userId || projects.length === 0) return []
      const results = await Promise.all(
        projects.map(async (project) => {
          const { data } = await apiClient.GET('/v1/work-items', {
            params: { query: { projectId: project.id, assigneeId: userId, limit: 50 } },
          })
          const items = (data as { data: WorkItem[] } | undefined)?.data ?? []
          return items.map((item) => ({
            ...item,
            projectKey: project.key,
            projectName: project.name,
          }))
        }),
      )
      return results.flat()
    },
    enabled: !!userId && projects.length > 0,
    staleTime: 30_000,
  })
}

export function useWorkItemCounts(projects: Array<{ id: string }>) {
  return useQuery({
    queryKey: ['work-item-counts', [...projects.map((p) => p.id)].sort()],
    queryFn: async () => {
      if (projects.length === 0) return { total: 0, blocked: 0, defects: 0 }
      const allItems = await Promise.all(
        projects.map(async (project) => {
          const { data } = await apiClient.GET('/v1/work-items', {
            params: { query: { projectId: project.id, limit: 100 } },
          })
          return (data as { data: WorkItem[] } | undefined)?.data ?? []
        }),
      )
      const flat = allItems.flat()
      return {
        total: flat.length,
        blocked: flat.filter((i) => i.isBlocked).length,
        defects: flat.filter((i) => i.type === 'defect').length,
      }
    },
    enabled: projects.length > 0,
    staleTime: 30_000,
  })
}

export function useCommittedIterationsWorkItems(projectIds: string[], userId?: string) {
  return useQuery({
    queryKey: ['work-items-committed-iterations', projectIds.sort(), userId],
    queryFn: async () => {
      if (projectIds.length === 0) return []
      const results = await Promise.all(
        projectIds.map(async (projectId) => {
          const { data } = await apiClient.GET('/v1/work-items', {
            params: { query: { projectId, assigneeId: userId, limit: 50 } },
          })
          return (data as { data: WorkItem[] } | undefined)?.data ?? []
        }),
      )
      return results.flat()
    },
    enabled: projectIds.length > 0,
    staleTime: 30_000,
  })
}

// ── Watchers (P1-23) ──────────────────────────────────────────────────────────

export function useWatchers(workItemId: string | undefined) {
  return useQuery({
    queryKey: workItemKeys.watchers(workItemId ?? ''),
    queryFn: async () => {
      if (!workItemId) return [] as Watcher[]
      const { data, error, response } = await apiClient.GET('/v1/work-items/{id}/watchers', {
        params: { path: { id: workItemId } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return (data ?? []) as Watcher[]
    },
    enabled: !!workItemId,
    staleTime: 30_000,
  })
}

/** Toggle watch on/off for the current user. Returns true = now watching. */
export function useToggleWatch(workItemId: string | undefined) {
  return useMutation({
    mutationFn: async (watching: boolean) => {
      if (!workItemId) throw new Error('workItemId required')
      if (watching) {
        const { error, response } = await apiClient.DELETE('/v1/work-items/{id}/watchers', {
          params: { path: { id: workItemId } },
        })
        if (error) throw new Error(apiErrorMessage(error, response.status))
      } else {
        const { error, response } = await apiClient.POST('/v1/work-items/{id}/watchers', {
          params: { path: { id: workItemId } },
        })
        if (error) throw new Error(apiErrorMessage(error, response.status))
      }
    },
    // Narrow, instance-specific: only this item's watcher list changed.
    meta: { invalidateKeys: [workItemKeys.watchers(workItemId ?? '')] },
  })
}

// ── Bulk assignment + reorder (P2-BL-03/04/05) ──────────────────────────────────

export type BulkAssignReleaseInput = components['schemas']['BulkAssignReleaseDto']
export type BulkAssignIterationInput = components['schemas']['BulkAssignIterationDto']
export type RankWorkItemInput = components['schemas']['RankWorkItemDto']

export function useBulkAssignRelease() {
  return useMutation({
    mutationFn: async (input: BulkAssignReleaseInput) => {
      const { data, error, response } = await apiClient.PATCH('/v1/work-items/bulk-release', {
        body: input,
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as { updated: number }
    },
    meta: { invalidates: ['work-item'] },
  })
}

export function useBulkAssignIteration() {
  return useMutation({
    mutationFn: async (input: BulkAssignIterationInput) => {
      const { data, error, response } = await apiClient.PATCH('/v1/work-items/bulk-iteration', {
        body: input,
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as { updated: number }
    },
    meta: { invalidates: ['work-item'] },
  })
}

export function useRankWorkItem(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: RankWorkItemInput) => {
      const { data, error, response } = await apiClient.PATCH('/v1/work-items/{id}/rank', {
        params: { path: { id } },
        body: input,
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as WorkItem
    },
    onSuccess: (item) => qc.setQueryData(workItemKeys.detail(item.id), item),
    meta: { invalidates: ['work-item'] },
  })
}

/**
 * Send one item to the TOP or BOTTOM of the backlog — Rally's `Rank Highest` / `Rank Lowest`.
 *
 * Rally states the trap this exists to avoid: "the work item moves to the end of **the list**, not
 * the end of **the page**." Our backlog is server-paginated at 25, and the rank endpoint takes only
 * neighbours (`beforeId`/`afterId`, at least one required) — so the client cannot name the true edge
 * from the page it happens to be holding. Dragging can only ever reorder within the loaded page,
 * which is exactly why these two actions are needed and cannot be built from the visible rows.
 *
 * So the edge is RESOLVED first: one extra request sorted by `rank` under the SAME filters, limit 1.
 * That answers "what is currently first/last" for the list the user is actually looking at, which is
 * also what Rally means — its list has filters too. An unfiltered reading would send the item past
 * rows the user cannot see.
 *
 * `Move to Position` (Rally's third action) is deliberately NOT here: reaching position N needs the
 * rows at N-1 and N, and `PageQuerySchema` caps `limit` at 100, so any position beyond that is
 * unreachable without a new offset-capable contract.
 *
 * A no-op is silent by design. If the item already IS the edge, the resolved neighbour is the item
 * itself, and asking the server to rank something relative to itself is meaningless.
 */
export function useRankToBacklogEdge(projectId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      id,
      edge,
      filters = {},
    }: {
      id: string
      edge: 'top' | 'bottom'
      /** The grid's live filters, so "the list" means the one on screen. */
      filters?: Omit<BacklogFilters, 'sort' | 'limit' | 'cursor'>
    }) => {
      if (!projectId) throw new Error('A project is required to rank a backlog item')

      const page = await fetchBacklogPage(projectId, {
        ...filters,
        sort: edge === 'top' ? 'rank:asc' : 'rank:desc',
        limit: 1,
      })
      const edgeItem = page.data[0]
      // Nothing to rank against, or the item is already there.
      if (!edgeItem || edgeItem.id === id) return null

      const body: RankWorkItemInput =
        edge === 'top'
          ? { projectId, beforeId: null, afterId: edgeItem.id }
          : { projectId, beforeId: edgeItem.id, afterId: null }

      const { data, error, response } = await apiClient.PATCH('/v1/work-items/{id}/rank', {
        params: { path: { id } },
        body,
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as WorkItem
    },
    onSuccess: (item) => {
      if (item) qc.setQueryData(workItemKeys.detail(item.id), item)
    },
    meta: { invalidates: ['work-item'] },
  })
}

export function useRankAnyWorkItem() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, ...input }: { id: string } & RankWorkItemInput) => {
      const { data, error, response } = await apiClient.PATCH('/v1/work-items/{id}/rank', {
        params: { path: { id } },
        body: input as RankWorkItemInput,
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as WorkItem
    },
    onSuccess: (item) => qc.setQueryData(workItemKeys.detail(item.id), item),
    meta: { invalidates: ['work-item'] },
  })
}

// ── Relations (F6 — work-item linking) ────────────────────────────────────────
// New endpoints; called via raw fetch (mirrors the attachment-upload pattern)
// until the generated OpenAPI client is regenerated against the live API.

export type WorkItemRelationType = 'blocks' | 'duplicates' | 'relates_to' | 'depends_on'

export interface WorkItemRelationView {
  id: string
  relationType: WorkItemRelationType
  direction: 'outbound' | 'inbound'
  label: string
  relatedItem: {
    id: string
    itemKey: string
    title: string
    type: string
    scheduleState: string
  }
  createdAt: string
}

const relationKeys = {
  list: (workItemId: string) => ['work-item-relations', workItemId] as const,
}

export function useRelations(workItemId: string | undefined) {
  return useQuery({
    queryKey: relationKeys.list(workItemId ?? ''),
    queryFn: async (): Promise<WorkItemRelationView[]> => {
      if (!workItemId) return []
      const res = await fetch(`/v1/work-items/${workItemId}/relations`, {
        credentials: 'include',
      })
      if (!res.ok) throw new Error(`Failed to load linked items (${res.status})`)
      return (await res.json()) as WorkItemRelationView[]
    },
    enabled: !!workItemId,
    staleTime: 15_000,
  })
}

export function useLinkWorkItem(workItemId: string | undefined) {
  return useMutation({
    mutationFn: async (input: {
      targetId: string
      relationType: WorkItemRelationType
    }): Promise<WorkItemRelationView[]> => {
      if (!workItemId) throw new Error('workItemId required')
      const res = await fetch(`/v1/work-items/${workItemId}/relations`, {
        method: 'POST',
        headers: withCsrfHeader('POST', { 'Content-Type': 'application/json' }),
        credentials: 'include',
        body: JSON.stringify(input),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null
        throw new Error(body?.message ?? `Failed to link item (${res.status})`)
      }
      return (await res.json()) as WorkItemRelationView[]
    },
    meta: workItemId ? { invalidateKeys: [relationKeys.list(workItemId)] } : undefined,
  })
}

export function useUnlinkWorkItem(workItemId: string | undefined) {
  return useMutation({
    mutationFn: async (relationId: string): Promise<void> => {
      if (!workItemId) throw new Error('workItemId required')
      const res = await fetch(`/v1/work-items/${workItemId}/relations/${relationId}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: withCsrfHeader('DELETE'),
      })
      if (!res.ok) throw new Error(`Failed to remove link (${res.status})`)
    },
    meta: workItemId ? { invalidateKeys: [relationKeys.list(workItemId)] } : undefined,
  })
}

// ── SCM Connections + Changesets (Connections tab) ────────────────────────────
// Read-only lists linked by the worker relay. Keyed under workItemKeys.all so
// the existing 'work-item' invalidation tag refreshes them. A work item has few
// PRs/commits, so we fetch a single generous page (mirrors the Artifacts tab).

export type ScmConnection = components['schemas']['ScmConnectionResponseDto']
export type ScmChangeset = components['schemas']['ScmChangesetResponseDto']

const SCM_PAGE_LIMIT = 100

export function useWorkItemConnections(workItemId: string | undefined) {
  return useQuery({
    queryKey: [...workItemKeys.all, 'connections', workItemId ?? ''] as const,
    queryFn: async () => {
      if (!workItemId) return { data: [] as ScmConnection[], total: 0 }
      const { data, error, response } = await apiClient.GET('/v1/work-items/{id}/connections', {
        params: { path: { id: workItemId }, query: { limit: SCM_PAGE_LIMIT } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      const rows = (data?.data ?? []) as ScmConnection[]
      return { data: rows, total: data?.pageInfo?.total ?? rows.length }
    },
    enabled: !!workItemId,
    staleTime: 15_000,
  })
}

export function useWorkItemChangesets(workItemId: string | undefined) {
  return useQuery({
    queryKey: [...workItemKeys.all, 'changesets', workItemId ?? ''] as const,
    queryFn: async () => {
      if (!workItemId) return { data: [] as ScmChangeset[], total: 0 }
      const { data, error, response } = await apiClient.GET('/v1/work-items/{id}/changesets', {
        params: { path: { id: workItemId }, query: { limit: SCM_PAGE_LIMIT } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      const rows = (data?.data ?? []) as ScmChangeset[]
      return { data: rows, total: data?.pageInfo?.total ?? rows.length }
    },
    enabled: !!workItemId,
    staleTime: 15_000,
  })
}
