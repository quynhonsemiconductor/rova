/**
 * Reporting API hooks — TanStack Query wrappers over `/v1/reports`.
 *
 * Read-only: every mutation of the underlying data happens through the work-item, iteration,
 * task and capacity endpoints, and the daily snapshot history is written by a scheduled job
 * with no HTTP surface at all.
 *
 * Scope comes from the global workspace context (`useAppContext`), never from a filter these
 * hooks own — the SRS is explicit that a report must not create a second Project or Team
 * filter. `teamId: undefined` means All Teams.
 */
import { useQuery } from '@tanstack/react-query'

import { apiClient } from '@/shared/api/http-client'
import { apiErrorMessage } from '@/shared/api/api-error'
import type { operations } from '@/shared/api/generated/api'

type Json<T extends keyof operations> = operations[T] extends {
  responses: { 200: { content: { 'application/json': infer R } } }
}
  ? R
  : never

export type IterationBurndown = Json<'ReportingController_getIterationBurndown'>
export type BurndownPoint = IterationBurndown['points'][number]
export type BurndownHistoryState = IterationBurndown['historyState']
/**
 * One `SPLIT OUT` / `CARRY IN` annotation (SU-08). Read off the burndown response, so the SPA cannot
 * hold a different idea of the shape than the server sends.
 */
export type SplitMarker = IterationBurndown['splitOut'][number]

export type VelocityReport = Json<'ReportingController_getVelocity'>
export type VelocityBar = VelocityReport['bars'][number]
export type VelocityWindow = VelocityReport['window']

/**
 * Which window the Velocity report OPENS on.
 *
 * RALLY PARITY (differs from BA design) — Rally plots "the last 10 completed iterations" and
 * averages its trend over the same 10; the BA spec (Velocity SRS §6) said default 5. Both
 * options stay selectable; only the initial one changed.
 * Decided 2026-08-04. See 09_Gap_Audit/PHASE_5_6_DECISION_MATRIX.md#P6-R-4
 *
 * Duplicated from the server's `DEFAULT_VELOCITY_WINDOW` rather than imported: the SPA does not
 * build against `libs/`, and the query key needs a concrete value up front. The server applies
 * its own default when the param is absent, so a drift here changes only which option the select
 * shows first — never what an explicit request returns.
 */
export const DEFAULT_VELOCITY_WINDOW: VelocityWindow = 10

export type TeamCapacityReport = Json<'ReportingController_getTeamCapacity'>
export type TeamCapacityTeam = TeamCapacityReport['teams'][number]
export type TeamCapacityHours = TeamCapacityTeam['totals']

export type ReleaseTrackingReport = Json<'ReportingController_getReleaseTracking'>
export type ReleaseTrackingRow = ReleaseTrackingReport['rows'][number]
/** The active bucket's page window. `total` is the whole bucket, never the page. */
export type ReleaseTrackingPage = ReleaseTrackingReport['page']
export type ReleaseMismatch = ReleaseTrackingRow['mismatches'][number]
export type ReleaseBucket = ReleaseTrackingReport['bucket']
export type ChartUnit = ReleaseTrackingReport['unit']

/** The list query, straight from the generated client — `q` and `sort` are in it as of codegen. */
type ReleaseTrackingQuery = NonNullable<
  operations['ReportingController_getReleaseTracking']['parameters']['query']
>

export type ReleaseBurnup = Json<'ReportingController_getReleaseBurnup'>
export type BurnupPoint = ReleaseBurnup['points'][number]

/** Team is part of every key: switching the global Team selector must refetch, not reuse. */
export const reportingKeys = {
  all: ['reports'] as const,
  burndown: (projectId: string, teamId: string | undefined, iterationId: string) =>
    ['reports', 'iteration-burndown', projectId, teamId ?? 'all', iterationId] as const,
  velocity: (projectId: string, teamId: string | undefined, window: number) =>
    ['reports', 'velocity', projectId, teamId ?? 'all', window] as const,
  teamCapacity: (projectId: string, teamId: string | undefined, iterationId: string) =>
    ['reports', 'team-capacity', projectId, teamId ?? 'all', iterationId] as const,
  releaseTracking: (
    projectId: string,
    teamId: string | undefined,
    releaseId: string,
    unit: ChartUnit,
    bucket: ReleaseBucket,
    page: number,
    pageSize: number,
    q: string,
    sort: string,
  ) =>
    [
      'reports',
      'release-tracking',
      projectId,
      teamId ?? 'all',
      releaseId,
      unit,
      bucket,
      // Page is part of the key: each page is a distinct server response, so reusing one
      // page's cache entry for another would show stale rows under a new page number.
      page,
      pageSize,
      // So are the search term and the sort: both are applied to the whole bucket SERVER-side
      // now (§259, RT-AC-05), so each combination is a different response.
      q,
      sort,
    ] as const,
  releaseBurnup: (
    projectId: string,
    teamId: string | undefined,
    releaseId: string,
    unit: ChartUnit,
  ) => ['reports', 'release-burnup', projectId, teamId ?? 'all', releaseId, unit] as const,
}

interface Scope {
  projectId: string | undefined
  teamId?: string | undefined
}

/**
 * Burndown is frozen history: a finalised day cannot change and only today's row moves, so a
 * short staleTime would refetch a series that is identical all day.
 */
const FROZEN = 5 * 60_000
/** Velocity and Team Capacity recalculate from current assignment, so they follow edits. */
const LIVE = 30_000

export function useIterationBurndown({
  projectId,
  teamId,
  iterationId,
}: Scope & { iterationId: string | undefined }) {
  return useQuery({
    queryKey: reportingKeys.burndown(projectId ?? '', teamId, iterationId ?? ''),
    queryFn: async () => {
      const { data, error, response } = await apiClient.GET('/v1/reports/iteration-burndown', {
        params: { query: { projectId: projectId!, teamId, iterationId: iterationId! } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as IterationBurndown
    },
    enabled: !!projectId && !!iterationId,
    staleTime: FROZEN,
  })
}

export function useVelocity({
  projectId,
  teamId,
  window = DEFAULT_VELOCITY_WINDOW,
}: Scope & { window?: VelocityWindow }) {
  return useQuery({
    queryKey: reportingKeys.velocity(projectId ?? '', teamId, window),
    queryFn: async () => {
      const { data, error, response } = await apiClient.GET('/v1/reports/velocity', {
        params: { query: { projectId: projectId!, teamId, window } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as VelocityReport
    },
    enabled: !!projectId,
    staleTime: LIVE,
  })
}

export function useTeamCapacityReport({
  projectId,
  teamId,
  iterationId,
}: Scope & { iterationId: string | undefined }) {
  return useQuery({
    queryKey: reportingKeys.teamCapacity(projectId ?? '', teamId, iterationId ?? ''),
    queryFn: async () => {
      const { data, error, response } = await apiClient.GET('/v1/reports/team-capacity', {
        params: { query: { projectId: projectId!, teamId, iterationId: iterationId! } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as TeamCapacityReport
    },
    enabled: !!projectId && !!iterationId,
    staleTime: LIVE,
  })
}

/**
 * The Release Tracking list.
 *
 * `q` and `sort` are SERVER-side, over the whole active bucket: "Search applies within the active
 * bucket" (RT §5) and RT-AC-05's two-directional sort is only meaningful over the same population,
 * while the rows that travel are one page. Filtering in the browser searched and sorted whichever
 * 25 rows had arrived.
 *
 * Un-debounced, like the Backlog's `q`: TanStack Query caches per key, so a term the reader
 * backspaces to is served from cache rather than refetched.
 */
export function useReleaseTracking({
  projectId,
  teamId,
  releaseId,
  unit,
  bucket,
  page,
  pageSize,
  q,
  sort,
}: Scope & {
  releaseId: string | undefined
  unit: ChartUnit
  bucket: ReleaseBucket
  page: number
  pageSize: number
  /** Free-text over the bucket's ID and Name. */
  q?: string
  /** `"<field>[:asc|:desc]"` — `rank`, `id`, `team` or `name`. */
  sort?: string
}) {
  return useQuery({
    queryKey: reportingKeys.releaseTracking(
      projectId ?? '',
      teamId,
      releaseId ?? '',
      unit,
      bucket,
      page,
      pageSize,
      q ?? '',
      sort ?? '',
    ),
    queryFn: async () => {
      // Built as a variable rather than inline so the optional spreads below stay readable; the
      // generated client now carries `q` and `sort`, so the type needs no widening.
      const query: ReleaseTrackingQuery = {
        projectId: projectId!,
        teamId,
        releaseId: releaseId!,
        unit,
        bucket,
        page,
        pageSize,
        ...(q ? { q } : {}),
        ...(sort ? { sort } : {}),
      }
      const { data, error, response } = await apiClient.GET('/v1/reports/release-tracking', {
        params: { query },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as ReleaseTrackingReport
    },
    enabled: !!projectId && !!releaseId,
    staleTime: LIVE,
    // Keep the previous page's rows on screen while the next one loads, so paging does not
    // flash the grid's skeleton between clicks.
    placeholderData: (previous) => previous,
  })
}

export function useReleaseBurnup({
  projectId,
  teamId,
  releaseId,
  unit,
}: Scope & { releaseId: string | undefined; unit: ChartUnit }) {
  return useQuery({
    queryKey: reportingKeys.releaseBurnup(projectId ?? '', teamId, releaseId ?? '', unit),
    queryFn: async () => {
      const { data, error, response } = await apiClient.GET('/v1/reports/release-tracking/burnup', {
        params: { query: { projectId: projectId!, teamId, releaseId: releaseId!, unit } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as ReleaseBurnup
    },
    enabled: !!projectId && !!releaseId,
    // Burnup days are finalised like burndown days: only today's point can still move.
    staleTime: FROZEN,
  })
}
