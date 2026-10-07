/**
 * Iterations API hooks — TanStack Query wrappers.
 *
 * Rally "Iteration" is the timebox entity (formerly Sprint). State follows the
 * Rally vocabulary: planning → committed → accepted. Endpoints live under
 * /v1/iterations (see libs/modules/iterations).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/shared/api/http-client'
import { apiErrorMessage } from '@/shared/api/api-error'
import type { components } from '@/shared/api/generated/api'

export type IterationState = 'planning' | 'committed' | 'accepted'

export type Iteration = components['schemas']['IterationResponseDto']
export type CreateIterationInput = components['schemas']['CreateIterationDto']
export type UpdateIterationInput = components['schemas']['UpdateIterationDto']
export type IterationStatus = components['schemas']['IterationStatusResponseDto']
export type IterationStatusItem = IterationStatus['items'][number]
export type CreateIterationItemInput = components['schemas']['CreateIterationItemDto']

/** ELIGIBILITY — `GET /iterations/assignable`; every state, no `teamId` (see the hook below). */
export type IterationOption = components['schemas']['IterationOptionDto']
/** REFERENCE — `GET /iterations/options`, every state. */
export type IterationReference = components['schemas']['IterationReferenceDto']
export type IterationActivityLog = components['schemas']['IterationActivityResponseDto']

export const iterationKeys = {
  all: ['iterations'] as const,
  list: (projectId: string) => ['iterations', projectId] as const,
  optionsAll: ['iteration-options'] as const,
  options: (projectId: string, teamId?: string | null) =>
    ['iteration-options', projectId, teamId ?? null] as const,
  assignableAll: ['iteration-assignable'] as const,
  assignable: (projectId: string, teamId?: string | null) =>
    ['iteration-assignable', projectId, teamId ?? null] as const,
  detail: (id: string) => ['iteration', id] as const,
  activity: (id: string) => ['iteration', id, 'activity'] as const,
  committedCount: (projectIds: string[]) =>
    ['iterations', 'committed-count', [...projectIds].sort()] as const,
  statusAll: ['iteration-status'] as const,
  status: (id: string, filters?: unknown) =>
    filters
      ? ([...iterationKeys.statusAll, id, filters] as const)
      : ([...iterationKeys.statusAll, id] as const),
}

// ── Revision History (activity log) ─────────────────────────────────────────

export function useIterationActivityLog(iterationId: string | undefined) {
  return useQuery({
    queryKey: iterationKeys.activity(iterationId ?? ''),
    queryFn: async () => {
      if (!iterationId) return []
      const { data, error, response } = await apiClient.GET('/v1/iterations/{id}/activity', {
        params: { path: { id: iterationId }, query: { page: 1, pageSize: 100 } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      // API returns { data: IterationActivityResponseDto[]; total; page; pageSize }
      return (data as { data?: IterationActivityLog[] } | undefined)?.data ?? []
    },
    enabled: !!iterationId,
    staleTime: 15_000,
  })
}

// ── The two compact feeds (P2-IT-10) ────────────────────────────────────────
//
// TWO HOOKS, because there are two questions and two populations:
//
//   useIterationOptions      REFERENCE    + teamId              filters, id→name labels, scope pickers
//   useAssignableIterations  ELIGIBILITY  no teamId             the bulk-assign bar, inline pickers
//
// Both cover EVERY state. Eligibility used to stop at `planning | committed`, which is the P6-VEL-004
// defect: an item could be moved OUT of a finished sprint but never back IN, because the selector no
// longer offered it — and Velocity reads the CURRENT assignment, so the move-out changed a bar the
// move-in could not restore. The server never refused a closed target; only the picker did.
//
// Both are `iteration:view`, which every project access level holds. `useIterations` below is the
// timebox RECORD and is `timebox:view` — §3.2 hides that surface from an Editor, so ONLY
// `pages/iterations/**` may call it. Pointing a picker at it 403s for an Editor, and a 403
// defaulted to `[]` renders as "there are none" (see `shared/lib/query/resource.ts`).

/**
 * REFERENCE. Every iteration in the project, whatever its state.
 *
 * `teamId` means "the team's own timeboxes PLUS the project's shared ones" server-side, not a strict
 * `team_id = ?`. Most iterations name no team, so a strict filter would empty a team-scoped picker.
 */
export function useIterationOptions(projectId: string | undefined, teamId?: string | null) {
  return useQuery({
    queryKey: iterationKeys.options(projectId ?? '', teamId),
    queryFn: async () => {
      if (!projectId) return []
      const { data, error, response } = await apiClient.GET('/v1/iterations/options', {
        params: { query: { projectId, teamId: teamId ?? undefined } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return (data ?? []) as IterationReference[]
    },
    enabled: !!projectId,
    staleTime: 30_000,
  })
}

/**
 * ELIGIBILITY. The iterations work may be assigned INTO — every state in the project, and a
 * team-scoped timebox only for that team, which is exactly what the server accepts. So a picker can
 * neither offer a target the server would refuse nor hide one it accepts (P6-VEL-004).
 *
 * `teamId` means "the team's own timeboxes PLUS the project's shared ones" server-side, as on the
 * reference feed. This payload carries NO `teamId` field, so use `useIterationOptions` where
 * `iterationsInScope` has to tell a team's own timebox from a shared one.
 */
export function useAssignableIterations(projectId: string | undefined, teamId?: string | null) {
  return useQuery({
    queryKey: iterationKeys.assignable(projectId ?? '', teamId),
    queryFn: async () => {
      if (!projectId) return []
      const { data, error, response } = await apiClient.GET('/v1/iterations/assignable', {
        params: { query: { projectId, teamId: teamId ?? undefined } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return (data ?? []) as IterationOption[]
    },
    enabled: !!projectId,
    staleTime: 30_000,
  })
}

// ── List ────────────────────────────────────────────────────────────────────

/**
 * Iterations are a bounded working set (a project has a finite number of
 * timeboxes), so we follow the cursor to load the COMPLETE set instead of a
 * single 100-item page. This keeps client-side filtering/counting honest —
 * a silent first-page cap would drop iterations past the 100th. MAX_PAGES is a
 * safety ceiling against pathological loops.
 */
const MAX_PAGES = 50

async function fetchAllIterations(projectId: string, teamId?: string): Promise<Iteration[]> {
  const out: Iteration[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error, response } = await apiClient.GET('/v1/iterations', {
      params: { query: { projectId, teamId, limit: 100, cursor } },
    })
    if (error) throw new Error(apiErrorMessage(error, response.status))
    out.push(...((data?.data ?? []) as Iteration[]))
    const next = data?.pageInfo?.nextCursor
    if (!next) break
    cursor = next
  }
  return out
}

/**
 * The timebox RECORD — `goal`, `theme`, `notes`, `plannedVelocity`, the task-estimate rollup — paged.
 *
 * `GET /iterations` is `timebox:view`, so this is the `Plan > Timeboxes` GRID's feed and ONLY that:
 * §3.2 marks the surface Hidden for a per-Project Editor, and `apps/web/src/test/fe-consistency.
 * ratchet.test.ts` restricts its call sites to `pages/iterations/**` for exactly that reason.
 *
 * For a filter, a label or a scope picker use {@link useIterationOptions}; for an assignment target
 * use {@link useAssignableIterations}. Six call sites on five other surfaces read this hook before
 * those two feeds existed, which meant a real per-project Editor got a 403 on each of them.
 */
export function useIterations(projectId: string | undefined, teamId?: string) {
  return useQuery({
    queryKey: [...iterationKeys.list(projectId ?? ''), teamId ?? null],
    queryFn: () => (projectId ? fetchAllIterations(projectId, teamId) : Promise.resolve([])),
    enabled: !!projectId,
    staleTime: 30_000,
  })
}

// Committed iterations count across all projects (the Rally "active" timebox).
export function useCommittedIterationsCount(projects: Array<{ id: string }>) {
  return useQuery({
    queryKey: iterationKeys.committedCount(projects.map((p) => p.id)),
    queryFn: async () => {
      if (projects.length === 0) return 0
      const allIterations = await Promise.all(
        projects.map((project) => fetchAllIterations(project.id)),
      )
      return allIterations.flat().filter((i) => i.state === 'committed').length
    },
    enabled: projects.length > 0,
    staleTime: 60_000,
  })
}

// ── Detail ──────────────────────────────────────────────────────────────────

export function useIteration(id: string | undefined) {
  return useQuery({
    queryKey: iterationKeys.detail(id ?? ''),
    queryFn: async () => {
      const { data, error, response } = await apiClient.GET('/v1/iterations/{id}', {
        params: { path: { id: id! } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as Iteration
    },
    enabled: !!id,
    staleTime: 30_000,
  })
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export function useCreateIteration() {
  return useMutation({
    mutationFn: async (input: CreateIterationInput) => {
      const { data, error, response } = await apiClient.POST('/v1/iterations', { body: input })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as Iteration
    },
    // The `iteration` tag fans out to the list, the /options picker feed, the
    // status read-model AND the work-item-derived views — so a created
    // iteration appears everywhere (header, inline cell, sidebar, filter) at
    // once. This closes the original stale-picker bug at the registry level.
    meta: { invalidates: ['iteration'] },
  })
}

export function useUpdateIteration(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: UpdateIterationInput) => {
      const { data, error, response } = await apiClient.PATCH('/v1/iterations/{id}', {
        params: { path: { id } },
        body: input,
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as Iteration
    },
    // Seed the detail cache for an instant, flicker-free update; the global
    // registry then refreshes the list/options/status/work-item views.
    onSuccess: (iteration) => qc.setQueryData(iterationKeys.detail(id), iteration),
    meta: { invalidates: ['iteration'] },
  })
}

export function useDeleteIteration() {
  return useMutation({
    mutationFn: async (id: string) => {
      const { error, response } = await apiClient.DELETE('/v1/iterations/{id}', {
        params: { path: { id } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
    },
    meta: { invalidates: ['iteration'] },
  })
}

// ── Lifecycle transitions (BA F1 — gated, single-source) ─────────────────────
// Commit (Planning → Committed) and Accept (Committed → Accepted) are guarded
// server-side (one committed iteration per project; accept needs ≥1 assigned
// Story/Defect all accepted). Rollover moves the unfinished (not-accepted)
// items out to another iteration or the backlog — the mirror of the accept
// gate. These replace free-form state edits so the FE cannot bypass the rules.

export type RolloverIterationInput = components['schemas']['RolloverIterationDto']

// Commit/accept/rollover move work items between states/iterations, so they use
// the same coarse `iteration` tag as CRUD — which already fans out to every
// iteration root PLUS the work-item-derived views.

export function useCommitIteration(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const { data, error, response } = await apiClient.POST('/v1/iterations/{id}/commit', {
        params: { path: { id } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as Iteration
    },
    onSuccess: (iteration) => qc.setQueryData(iterationKeys.detail(id), iteration),
    meta: { invalidates: ['iteration'] },
  })
}

export function useAcceptIteration(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const { data, error, response } = await apiClient.POST('/v1/iterations/{id}/accept', {
        params: { path: { id } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as Iteration
    },
    onSuccess: (iteration) => qc.setQueryData(iterationKeys.detail(id), iteration),
    meta: { invalidates: ['iteration'] },
  })
}

export function useRolloverIteration(id: string) {
  return useMutation({
    mutationFn: async (input: RolloverIterationInput) => {
      const { data, error, response } = await apiClient.POST('/v1/iterations/{id}/rollover', {
        params: { path: { id } },
        body: input,
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      // The endpoint returns a bare `{ movedCount }` with no response DTO, so the
      // generated client types the body as `undefined`; the value is present at
      // runtime, hence the cast through `unknown`.
      return data as unknown as { movedCount: number }
    },
    meta: { invalidates: ['iteration'] },
  })
}

// ── Iteration Status (P2.3) ─────────────────────────────────────────────────

export interface IterationStatusFilters {
  q?: string
  type?: IterationStatusItem['type']
  scheduleState?: IterationStatusItem['scheduleState']
  /**
   * The WIRE shape, `'true' | 'false'` — not a boolean.
   *
   * `isBlocked` used to be `z.coerce.boolean()` server-side, where `Boolean('false') === true`, so
   * `?isBlocked=false` asked for BLOCKED rows. It is an explicit enum now, and the filter control
   * already produces those two strings — so carrying a boolean here only to convert it back at the
   * request boundary is a round trip that can disagree with itself. Kept as the wire value end to end.
   */
  isBlocked?: 'true' | 'false'
  /** A user id, or `UNASSIGNED_OWNER` for rows with no owner (resolved server-side). */
  assigneeId?: string
  /** The same, for the Dev Owner column (`P2-IS-FR-024`). Independent of `assigneeId`. */
  devOwnerId?: string
  /**
   * Manage Filters column predicates (P2-IS-FR-022/023/024). Server-side, and
   * separate from `q` so quick search stays independent (P2-BL-TS-015, inherited).
   */
  itemKey?: string
  title?: string
  planEstimate?: string
  taskEstimate?: string
  toDo?: string
  /** Phase 7 Carryover — substring of the Story's `YYYY-MM-DD` date (server-side). */
  startDate?: string
  targetEndDate?: string
}

export function useIterationStatus(id: string | undefined, filters: IterationStatusFilters = {}) {
  return useQuery({
    queryKey: iterationKeys.status(id ?? '', filters),
    queryFn: async () => {
      // One iteration is a bounded working set and the Board view needs every
      // item to allow drag across columns, so we follow the cursor to load the
      // whole set. `metrics`/`iteration` are full-iteration aggregates computed
      // server-side (page-independent), so we keep them from the first page and
      // concatenate items across pages.
      let result: IterationStatus | undefined
      const items: IterationStatusItem[] = []
      let cursor: string | undefined
      for (let page = 0; page < MAX_PAGES; page++) {
        const { data, error, response } = await apiClient.GET('/v1/iterations/{id}/status', {
          params: {
            path: { id: id! },
            query: { ...filters, limit: 100, cursor },
          },
        })
        if (error) throw new Error(apiErrorMessage(error, response.status))
        const page$ = data as IterationStatus
        if (!result) result = page$
        items.push(...page$.items)
        const next = page$.pageInfo?.nextCursor
        if (!next) break
        cursor = next
      }
      return { ...result!, items }
    },
    enabled: !!id,
    staleTime: 15_000,
  })
}

export function useCreateIterationItem(iterationId: string) {
  return useMutation({
    mutationFn: async (input: CreateIterationItemInput) => {
      const { data, error, response } = await apiClient.POST('/v1/iterations/{id}/work-items', {
        params: { path: { id: iterationId } },
        body: input,
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as { workItemId: string; itemKey: string }
    },
    // Creates a work item scoped to the iteration → refresh the whole work-item
    // fan-out (which includes the iteration-status read-model).
    meta: { invalidates: ['work-item'] },
  })
}
