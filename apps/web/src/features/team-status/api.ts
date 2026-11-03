/**
 * Team Status API hooks — TanStack Query wrappers.
 * P3.1 Team Status: grouped task rows per iteration by member.
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { apiClient } from '@/shared/api/http-client'
import { apiErrorMessage } from '@/shared/api/api-error'

// ── Types ────────────────────────────────────────────────────────────────────

export type TeamTaskState = 'Defined' | 'In-Progress' | 'Completed'

export interface TeamStatusOwner {
  id: string
  displayName: string
  avatarUrl: string | null
}

export interface TeamStatusWorkProduct {
  id: string
  key: string
  type: 'Story' | 'Defect' | 'Feature'
  title: string
  status: string
}

export interface TeamStatusRelease {
  id: string
  name: string
}

export interface TeamStatusTaskRow {
  id: string
  taskKey: string
  title: string
  displayName: string
  workProduct: TeamStatusWorkProduct
  release: TeamStatusRelease | null
  state: TeamTaskState
  /** `null` = never entered (a cleared cell), never coerced to 0. Group/total sums count it as 0. */
  estimateHours: number | null
  todoHours: number | null
  actualHours: number | null
  owner: TeamStatusOwner
  rank: string | null
}

export interface TeamStatusMemberGroup {
  owner: TeamStatusOwner
  capacityHours: number
  taskCount: number
  estimateHours: number
  todoHours: number
  actualHours: number
  progressPercent: number
  tasks: TeamStatusTaskRow[]
}

export interface TeamStatusTotals {
  capacityHours: number
  estimateHours: number
  todoHours: number
  actualHours: number
}

export interface TeamStatusIteration {
  id: string
  name: string
  startDate: string | null
  endDate: string | null
}

export interface TeamStatusData {
  projectId: string
  teamId: string
  iteration: TeamStatusIteration
  totals: TeamStatusTotals
  groups: TeamStatusMemberGroup[]
}

// ── Query keys ───────────────────────────────────────────────────────────────

export const teamStatusKeys = {
  all: ['team-status'] as const,
  detail: (projectId: string, teamId: string | null | undefined, iterationId: string) =>
    ['team-status', projectId, teamId ?? '', iterationId] as const,
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client = apiClient as any

// ── Queries ──────────────────────────────────────────────────────────────────

export function useTeamStatus(
  projectId: string | undefined,
  teamId: string | undefined,
  iterationId: string | undefined,
) {
  return useQuery({
    queryKey: teamStatusKeys.detail(projectId ?? '', teamId, iterationId ?? ''),
    queryFn: async () => {
      if (!projectId || !iterationId) return null
      const { data, error, response } = await client.GET('/v1/team-status', {
        params: { query: { projectId, teamId: teamId || undefined, iterationId } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as TeamStatusData
    },
    enabled: !!projectId && !!iterationId,
    staleTime: 15_000,
  })
}

// ── Mutations ────────────────────────────────────────────────────────────────

export function useUpdateCapacity(
  projectId: string,
  teamId: string | undefined,
  iterationId: string,
) {
  return useMutation({
    mutationFn: async (input: { userId: string; capacityHours: number }) => {
      const { data, error, response } = await client.PATCH('/v1/team-status/capacity', {
        body: { projectId, teamId, iterationId, ...input },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data
    },
    meta: { invalidates: ['work-item'] },
  })
}

/**
 * The Team Status TASK route edits Task Name and Task State only.
 *
 * SRS §9.3 accepts a patch of "`title` and/or `state`", and the route REFUSES anything else
 * (`.strict()` on `UpdateTeamTaskSchema`), so keeping more fields in this type would only buy a 400
 * at runtime instead of a compile error. Estimate / To Do / Actuals ARE editable on this screen
 * (US-145), but through `useUpdateWorkItem` — see `TaskRow.commitHours` on the page.
 */
export function useUpdateTeamTask() {
  return useMutation({
    mutationFn: async (input: { taskId: string; title?: string; state?: TeamTaskState }) => {
      const { taskId, ...patch } = input
      const { data, error, response } = await client.PATCH('/v1/team-status/tasks/{taskId}', {
        params: { path: { taskId } },
        body: patch,
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data
    },
    meta: { invalidates: ['work-item'] },
  })
}
