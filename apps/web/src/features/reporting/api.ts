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

/** Phase 7 Carryover (CO-08 … CO-10). */
export type CarryoverReport = Json<'ReportingController_getCarryover'>
export type CarryoverRow = CarryoverReport['rows'][number]
export type CarryoverDirection = CarryoverReport['direction']
export type CarryoverSummary = NonNullable<IterationBurndown['carryover']>

/** Team is part of every key: switching the global Team selector must refetch, not reuse. */
export const reportingKeys = {
  all: ['reports'] as const,
  burndown: (projectId: string, teamId: string | undefined, iterationId: string) =>
    ['reports', 'iteration-burndown', projectId, teamId ?? 'all', iterationId] as const,
  velocity: (projectId: string, teamId: string | undefined, window: number) =>
    ['reports', 'velocity', projectId, teamId ?? 'all', window] as const,
  teamCapacity: (projectId: string, teamId: string | undefined, iterationId: string) =>
    ['reports', 'team-capacity', projectId, teamId ?? 'all', iterationId] as const,
  // Direction is NOT in the key: the SPA fetches `all` once and narrows rows (useCarryoverReport).
  carryover: (projectId: string, teamId: string | undefined, iterationId: string) =>
    ['reports', 'carryover', projectId, teamId ?? 'all', iterationId] as const,
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

// ── Carryover (Phase 7 CO-10) ─────────────────────────────────────────────────

/** A request that hangs must surface as a failure, not as a report that never loads (PR 653). */
const REPORT_TIMEOUT_MS = 30_000

/**
 * TanStack's own cancellation signal, plus a hard timeout. Combined by hand rather than with
 * `AbortSignal.any`, which Safari only shipped in 17.4 and jsdom does not implement.
 *
 * Returns `done`, which every caller runs in `finally` (PR 653 review, round 2): a request that
 * completes normally never aborts, so without it each call would leave a 30 s timer and its closure
 * alive. The listener is attached BEFORE the already-aborted check, so that path clears it too.
 *
 * `done` also DETACHES the relay from the caller's `signal` (PR 653 review, round 3): TanStack's
 * query signal can outlive the request, and a listener left on it would keep `controller` reachable
 * until that signal aborts or is collected.
 */
export function withTimeout(signal?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new DOMException('Report request timed out', 'TimeoutError')),
    REPORT_TIMEOUT_MS,
  )
  const relay = () => controller.abort(signal?.reason)
  const done = () => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', relay)
  }
  controller.signal.addEventListener('abort', done, { once: true })
  if (signal?.aborted) controller.abort(signal.reason)
  else signal?.addEventListener('abort', relay, { once: true })
  return { signal: controller.signal, done }
}

/** Is this the {@link withTimeout} deadline firing (as opposed to a server or network error)? */
function isTimeout(error: unknown): boolean {
  // By name, not `instanceof Error`: a `DOMException` is not an `Error` in every runtime.
  return (error as { name?: unknown } | null)?.name === 'TimeoutError'
}

/**
 * The report query's retry rule: the app default (one retry, never on a 4xx), EXCEPT that a timeout
 * is final (PR 653 review, round 3). A 30 s hang already means "give up"; re-running it would keep
 * the skeleton up for another 30 s before the error state the timeout exists to surface.
 */
export function retryReport(failureCount: number, error: unknown): boolean {
  if (isTimeout(error)) return false
  const status = (error as { status?: number } | null)?.status
  if (status && status >= 400 && status < 500) return false
  return failureCount < 1
}

/**
 * The Carryover report for one Iteration — ALWAYS fetched with Direction `all` (PR 653 review).
 *
 * CO-BR-41 says Direction narrows the ROWS and never a KPI or the trend. Keying the whole response on
 * Direction made that a promise about the server; fetching once per Iteration and narrowing the rows
 * here makes it structural — the KPIs and trend on screen are the same object whatever the reader
 * picks — and it drops a refetch of direction-invariant data on every switch. The rows carry the
 * server's own `direction` label, so filtering them by it is the server's rule, not a second copy.
 */
export function useCarryoverReport({
  projectId,
  teamId,
  iterationId,
}: Scope & { iterationId: string | undefined }) {
  return useQuery({
    queryKey: reportingKeys.carryover(projectId ?? '', teamId, iterationId ?? ''),
    queryFn: async ({ signal }) => {
      const timeout = withTimeout(signal)
      try {
        const { data, error, response } = await apiClient.GET('/v1/reports/carryover', {
          params: {
            query: { projectId: projectId!, teamId, iterationId: iterationId!, direction: 'all' },
          },
          signal: timeout.signal,
        })
        if (error) throw new Error(apiErrorMessage(error, response.status))
        if (!data) throw new Error(`Carryover report came back empty (${response.status})`)
        return data
      } finally {
        timeout.done()
      }
    },
    enabled: !!projectId && !!iterationId,
    staleTime: LIVE,
    retry: retryReport,
    /**
     * NO `placeholderData` (PR 653 review, round 2). It kept the PREVIOUS Iteration's whole report
     * on screen under the NEW selection's label while the fetch ran, and `data` was never empty so
     * no loading state covered it. Its only purpose was smoothing Direction switches, which no longer
     * refetch at all (Direction is not in the key) — so a new Iteration now shows the skeleton.
     */
  })
}

/** The rows a Direction tab shows — by the server's own per-row label. */
export function rowsForDirection(
  rows: readonly CarryoverRow[],
  direction: CarryoverDirection,
): CarryoverRow[] {
  return direction === 'all' ? [...rows] : rows.filter((row) => row.direction === direction)
}

// ── CSV export (Phase 7 rulings R1/R4, plan D11) ──────────────────────────────

/** Which export route serves each report type, and the query it needs. */
export type ReportExportRequest =
  | { report: 'burndown'; projectId: string; teamId?: string; iterationId: string }
  | { report: 'velocity'; projectId: string; teamId?: string; window: VelocityWindow }
  | { report: 'capacity'; projectId: string; teamId?: string; iterationId: string }
  | {
      report: 'carryover'
      projectId: string
      teamId?: string
      iterationId: string
      direction: CarryoverDirection
    }

/**
 * One typed call per export route (PR 653 review): each `apiClient.GET` names a literal path from
 * the GENERATED `paths`, with a query object checked against that route's own schema. A renamed
 * route or a drifted parameter is a compile error here, not a 404 when the reader clicks Export.
 */
function requestExport(req: ReportExportRequest, signal: AbortSignal) {
  const opts = { parseAs: 'blob' as const, signal }
  const teamId = req.teamId
  switch (req.report) {
    case 'burndown':
      return apiClient.GET('/v1/reports/iteration-burndown/export', {
        ...opts,
        params: { query: { projectId: req.projectId, teamId, iterationId: req.iterationId } },
      })
    case 'velocity':
      return apiClient.GET('/v1/reports/velocity/export', {
        ...opts,
        params: { query: { projectId: req.projectId, teamId, window: req.window } },
      })
    case 'capacity':
      return apiClient.GET('/v1/reports/team-capacity/export', {
        ...opts,
        params: { query: { projectId: req.projectId, teamId, iterationId: req.iterationId } },
      })
    case 'carryover':
      return apiClient.GET('/v1/reports/carryover/export', {
        ...opts,
        params: {
          query: {
            projectId: req.projectId,
            teamId,
            iterationId: req.iterationId,
            direction: req.direction,
          },
        },
      })
  }
}

/**
 * The filename in `Content-Disposition`: RFC 5987 `filename*=UTF-8''…` first (the only form that can
 * carry a non-ASCII name), then quoted, then bare `filename=`. Falls back when absent or unparseable.
 */
export function filenameFrom(header: string | null, fallback: string): string {
  if (!header) return fallback
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header)
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim())
    } catch {
      // A malformed escape: fall through to the plain forms.
    }
  }
  const quoted = /filename\s*=\s*"([^"]+)"/.exec(header)
  if (quoted) return quoted[1]
  const bare = /filename\s*=\s*([^;\s]+)/.exec(header)
  return bare?.[1] ?? fallback
}

/**
 * With `parseAs: 'blob'` an ERROR body arrives as a Blob too, so it is read and parsed before
 * `apiErrorMessage` sees it — otherwise a 403/400 would print a generic line instead of the server's
 * message (PR 653 review).
 */
async function exportErrorMessage(error: unknown, status: number): Promise<string> {
  if (error instanceof Blob) {
    const text = await error.text()
    try {
      return apiErrorMessage(JSON.parse(text), status)
    } catch {
      return apiErrorMessage(text ? { message: text } : undefined, status)
    }
  }
  return apiErrorMessage(error, status)
}

/**
 * Download one report as CSV through the BFF (same-origin cookie), as a blob. The server applies the
 * SAME query — and the same `report:view` + `report:export` gate — as the JSON report, so the file
 * matches the screen.
 */
export async function downloadReportCsv(req: ReportExportRequest): Promise<void> {
  const timeout = withTimeout()
  let result: Awaited<ReturnType<typeof requestExport>>
  try {
    result = await requestExport(req, timeout.signal)
  } finally {
    timeout.done()
  }
  const { data, error, response } = result
  if (error || !data) throw new Error(await exportErrorMessage(error, response.status))
  const name = filenameFrom(response.headers.get('content-disposition'), `${req.report}.csv`)
  const url = URL.createObjectURL(data as Blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Deferred: revoking synchronously after `click()` can abort the download on Safari / iOS.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/**
 * Whether the compact Carryover badge has anything to show — the SAME rule `CarryoverBadge` hides
 * on, exported so a caller that must render NULL when nothing shows (a footer slot) shares it.
 */
export function hasCarryoverActivity(
  summary: CarryoverSummary | null | undefined,
): summary is CarryoverSummary {
  return !!summary && (summary.carryIn > 0 || summary.carryOut > 0)
}
