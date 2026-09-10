/**
 * Test Cases API hooks — Phase 7. Phase A shipped the read path; Phase B adds create.
 * All types derive from the generated OpenAPI contract (never hand-written).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/shared/api/http-client'
import { ApiError, apiErrorMessage } from '@/shared/api/api-error'
import type { components } from '@/shared/api/generated/api'

export type TestCase = components['schemas']['TestCaseResponseDto']
export type TestCaseType = components['schemas']['TestCaseTypeOptionDto']
export type CreateTestCaseInput = components['schemas']['CreateTestCaseDto']
export type UpdateTestCaseInput = components['schemas']['UpdateTestCaseDto']
export type ActivityLog = components['schemas']['ActivityResponseDto']
export type TestResult = components['schemas']['TestResultResponseDto']
export type CreateTestResultInput = components['schemas']['CreateTestResultDto']
export type UpdateTestResultInput = components['schemas']['UpdateTestResultDto']

// A Test Case tab loads one Work Item's whole set (like Tasks) — bounded, so no cursor UI. The
// limit just has to exceed any real Work Item's Test Case count; the list route stays paged
// server-side (matches the plan's `{ data, pageInfo }` shape) for consistency with every other
// list route, even though this feature never asks for a second page.
//
// 100 is the house-wide ceiling on every list DTO's `limit` (activity, api-tokens, audit, login,
// iterations, projects, releases, work-items, workflow, workspace all cap at `.max(100)`) — 200
// here was an unchecked assumption and made every list call 422 (VALIDATION_FAILED), which left
// `useTestCases()`'s `data` permanently `undefined` and, fed through `listResource(...).rows`
// (`[] ?? []`, a fresh array reference every render) into `useRowRerank`'s render-time sync, was
// an infinite re-render loop ("Too many re-renders") on every visit to the tab.
const LIST_LIMIT = 100

export const testCaseKeys = {
  all: ['test-cases'] as const,
  list: (workItemId: string) => [...testCaseKeys.all, 'list', workItemId] as const,
  detail: (id: string) => [...testCaseKeys.all, 'detail', id] as const,
  byKey: (key: string) => [...testCaseKeys.all, 'by-key', key] as const,
  activity: (id: string) => [...testCaseKeys.all, 'activity', id] as const,
}

export function useTestCases(workItemId: string | undefined) {
  return useQuery({
    queryKey: testCaseKeys.list(workItemId ?? ''),
    queryFn: async (): Promise<TestCase[]> => {
      if (!workItemId) return []
      const { data, error, response } = await apiClient.GET('/v1/work-items/{id}/test-cases', {
        params: { path: { id: workItemId }, query: { limit: LIST_LIMIT } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data?.data ?? []
    },
    enabled: !!workItemId,
    staleTime: 15_000,
  })
}

export function useTestCase(id: string | undefined) {
  return useQuery({
    queryKey: testCaseKeys.detail(id ?? ''),
    queryFn: async (): Promise<TestCase | null> => {
      if (!id) return null
      const { data, error, response } = await apiClient.GET('/v1/test-cases/{id}', {
        params: { path: { id } },
      })
      if (error) {
        if (response.status === 404) return null
        throw new ApiError(error, response.status)
      }
      return data ?? null
    },
    enabled: !!id,
    staleTime: 15_000,
  })
}

/**
 * `by-key` uses `ApiError`, never a plain `Error`, so the detail page can tell a 403 (access
 * denied) from a 404 (key named back) from anything else (load failure) — a plain `Error` from
 * `apiErrorMessage` discards `status`, and `queryClient`'s retry predicate then reads `undefined`
 * and retries a refusal (CLAUDE.md: "A record route must own its denied state").
 */
export function testCaseByKeyQueryOptions(testCaseKey: string) {
  return {
    queryKey: testCaseKeys.byKey(testCaseKey),
    queryFn: async (): Promise<TestCase | null> => {
      if (!testCaseKey) return null
      const { data, error, response } = await apiClient.GET('/v1/test-cases/by-key/{key}', {
        params: { path: { key: testCaseKey } },
      })
      if (error) {
        if (response.status === 404) return null
        throw new ApiError(error, response.status)
      }
      return data ?? null
    },
    staleTime: 15_000,
  }
}

export function useTestCaseByKey(testCaseKey: string | undefined) {
  return useQuery({ ...testCaseByKeyQueryOptions(testCaseKey ?? ''), enabled: !!testCaseKey })
}

// ── Phase B: create ──────────────────────────────────────────────────────────

/**
 * `POST /work-items/:id/test-cases`. Invalidation is a NARROW key set
 * (`meta.invalidateKeys`), not a coarse `EntityTag` — a Test Case has no other read-model
 * derived from it yet (no report, no dashboard, no picker feed reads it), so adding one to
 * the shared `EntityTag` registry (`shared/api/invalidation.ts`) would be scope this phase's
 * plan does not ask for. B5: refreshes the list AND the tab badge (same query, `pageInfo.total`).
 */
export function useCreateTestCase(workItemId: string) {
  return useMutation({
    mutationFn: async (input: CreateTestCaseInput): Promise<TestCase> => {
      const { data, error, response } = await apiClient.POST('/v1/work-items/{id}/test-cases', {
        params: { path: { id: workItemId } },
        body: input,
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as TestCase
    },
    meta: { invalidateKeys: [testCaseKeys.list(workItemId)] },
  })
}

// ── Phase B: Type feed ───────────────────────────────────────────────────────

export const testCaseTypeKeys = {
  all: ['test-case-types'] as const,
  list: (projectId: string) => [...testCaseTypeKeys.all, projectId] as const,
}

/**
 * Live (non-archived) Types for a project — ONE feed for the Create modal's dropdown (Phase B,
 * BR2's "first selectable" source) AND Settings' chip list (G4). `position` is included so both
 * consumers render the catalog's own order.
 */
export function useTestCaseTypes(projectId: string | undefined) {
  return useQuery({
    queryKey: testCaseTypeKeys.list(projectId ?? ''),
    queryFn: async (): Promise<TestCaseType[]> => {
      if (!projectId) return []
      const { data, error, response } = await apiClient.GET('/v1/projects/{id}/test-case-types', {
        params: { path: { id: projectId } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data ?? []
    },
    enabled: !!projectId,
    staleTime: 60_000,
  })
}

// ── Phase G: Type catalog CRUD (workspace:edit, Workspace-Admin-only) ────────

/** `POST /projects/:id/test-case-types` (BR16). */
export function useCreateTestCaseType(projectId: string | undefined) {
  return useMutation({
    mutationFn: async (name: string): Promise<TestCaseType> => {
      if (!projectId) throw new Error('No project selected')
      const { data, error, response } = await apiClient.POST('/v1/projects/{id}/test-case-types', {
        params: { path: { id: projectId } },
        body: { name },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as TestCaseType
    },
    meta: { invalidateKeys: [testCaseTypeKeys.list(projectId ?? '')] },
  })
}

/** `DELETE /projects/:id/test-case-types/:typeId` — soft-hide (BR17); existing Test Cases keep their historical value. */
export function useArchiveTestCaseType(projectId: string | undefined) {
  return useMutation({
    mutationFn: async (typeId: string): Promise<void> => {
      if (!projectId) throw new Error('No project selected')
      const { error, response } = await apiClient.DELETE(
        '/v1/projects/{id}/test-case-types/{typeId}',
        { params: { path: { id: projectId, typeId } } },
      )
      if (error) throw new Error(apiErrorMessage(error, response.status))
    },
    meta: { invalidateKeys: [testCaseTypeKeys.list(projectId ?? '')] },
  })
}

// ── Phase C: edit ────────────────────────────────────────────────────────────

/**
 * `PATCH /test-cases/:id`. Mirrors `useUpdateWorkItem`'s cache-write shape: an instant,
 * flash-free update of the detail page the user is looking at, rather than waiting on a
 * refetch — the list/badge query invalidates separately since a Test Case's own edit does
 * not change the count.
 */
// ── Phase F: delete + reorder ────────────────────────────────────────────────

/**
 * `DELETE /test-cases/:id` (F1/F2). Soft; cascades to the Test Case's Results in the SAME
 * transaction (server-side) — the FE invalidates the list, which is the tab badge's own count
 * query (A7/B5's same `pageInfo.total` reasoning), so the row and the badge disappear together.
 */
export function useDeleteTestCase(workItemId: string) {
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const { error, response } = await apiClient.DELETE('/v1/test-cases/{id}', {
        params: { path: { id } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
    },
    meta: { invalidateKeys: [testCaseKeys.list(workItemId)] },
  })
}

/**
 * `PATCH /test-cases/:id/rank` (F3) — a single-item NEIGHBOUR-based reorder, the same shape
 * `useRankAnyWorkItem` uses for Quality's drag-to-rank: `beforeId`/`afterId` name the rows
 * immediately above/below the target's new position, and the server computes the LexoRank.
 * `useRowRerank`'s `onReorder` callback hands exactly this shape.
 */
export function useReorderTestCase(workItemId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      id,
      beforeId,
      afterId,
    }: {
      id: string
      beforeId?: string | null
      afterId?: string | null
    }): Promise<TestCase> => {
      const { data, error, response } = await apiClient.PATCH('/v1/test-cases/{id}/rank', {
        params: { path: { id } },
        body: { workItemId, beforeId, afterId },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as TestCase
    },
    onSuccess: (testCase) => qc.setQueryData(testCaseKeys.detail(testCase.id), testCase),
    meta: { invalidateKeys: [testCaseKeys.list(workItemId)] },
  })
}

export function useUpdateTestCase(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: UpdateTestCaseInput): Promise<TestCase> => {
      const { data, error, response } = await apiClient.PATCH('/v1/test-cases/{id}', {
        params: { path: { id } },
        body: input,
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as TestCase
    },
    onSuccess: (testCase) => {
      qc.setQueryData(testCaseKeys.detail(id), testCase)
      qc.setQueriesData({ queryKey: testCaseKeys.byKey(testCase.testCaseKey) }, testCase)
      // The Test Cases TAB reads a third, different query (`testCaseKeys.list`, an array) that
      // neither write above touches — an inline edit from the tab correctly patched the server and
      // the two caches above, but left the grid showing the stale row until a full refresh
      // re-fetched everything. Mirrors `useUpdateTestResult`'s own list invalidation below.
      void qc.invalidateQueries({ queryKey: testCaseKeys.list(testCase.workItemId ?? '') })
    },
  })
}

// ── Phase C: Revision History (C6) ───────────────────────────────────────────

export function useTestCaseActivity(id: string | undefined) {
  return useQuery({
    queryKey: testCaseKeys.activity(id ?? ''),
    queryFn: async (): Promise<ActivityLog[]> => {
      if (!id) return []
      const { data, error, response } = await apiClient.GET('/v1/test-cases/{id}/activity', {
        params: { path: { id }, query: { page: 1, pageSize: 100 } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return (data as { data?: ActivityLog[] } | undefined)?.data ?? []
    },
    enabled: !!id,
    staleTime: 15_000,
  })
}

// ── Phase D: Test Results ────────────────────────────────────────────────────

export const testResultKeys = {
  all: ['test-results'] as const,
  list: (testCaseId: string) => [...testResultKeys.all, 'list', testCaseId] as const,
  detail: (id: string) => [...testResultKeys.all, 'detail', id] as const,
  activity: (id: string) => [...testResultKeys.all, 'activity', id] as const,
}

/** BR14: the server already orders `run_date desc, created_at desc` — no client re-sort here. */
export function useTestResults(testCaseId: string | undefined) {
  return useQuery({
    queryKey: testResultKeys.list(testCaseId ?? ''),
    queryFn: async (): Promise<TestResult[]> => {
      if (!testCaseId) return []
      const { data, error, response } = await apiClient.GET('/v1/test-cases/{id}/test-results', {
        params: { path: { id: testCaseId } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data ?? []
    },
    enabled: !!testCaseId,
    staleTime: 15_000,
  })
}

/**
 * `POST /test-cases/:id/test-results`. D8: invalidates BOTH this Test Case's Results list AND its
 * own detail query — `Last Verdict`/`Last Run` in the sidebar are trigger-owned columns on the SAME
 * Test Case row the trigger just changed, so a Result write must refresh
 * `testCaseKeys.detail(testCaseId)` or the sidebar goes stale against a row that already moved. One
 * narrow key set (`meta.invalidateKeys`), matching `useCreateTestCase`'s own reasoning — a Test
 * Result has no other read-model derived from it yet.
 */
export function useCreateTestResult(testCaseId: string) {
  return useMutation({
    mutationFn: async (input: CreateTestResultInput): Promise<TestResult> => {
      const { data, error, response } = await apiClient.POST('/v1/test-cases/{id}/test-results', {
        params: { path: { id: testCaseId } },
        body: input,
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as TestResult
    },
    meta: {
      invalidateKeys: [testResultKeys.list(testCaseId), testCaseKeys.detail(testCaseId)],
    },
  })
}

// ── Phase E: Test Result Detail ──────────────────────────────────────────────

/**
 * `by-key` has no server route for Test Results (unlike Test Cases) — the plan's §3 API surface
 * lists only `GET /test-results/:id` (UUID). The Results tab's Build-cell link already carries
 * the row's `id`, so the detail route resolves by UUID (`/test-result/$testResultId`), not by key.
 */
export function testResultQueryOptions(id: string) {
  return {
    queryKey: testResultKeys.detail(id),
    queryFn: async (): Promise<TestResult | null> => {
      if (!id) return null
      const { data, error, response } = await apiClient.GET('/v1/test-results/{id}', {
        params: { path: { id } },
      })
      if (error) {
        if (response.status === 404) return null
        throw new ApiError(error, response.status)
      }
      return data ?? null
    },
    staleTime: 15_000,
  }
}

export function useTestResult(id: string | undefined) {
  return useQuery({ ...testResultQueryOptions(id ?? ''), enabled: !!id })
}

/**
 * `PATCH /test-results/:id`. Mirrors `useUpdateTestCase`'s cache-write shape: an instant update of
 * the detail page the user is looking at. Also invalidates the parent Test Case's own detail query
 * — E5: an edit that changes `run_date`/`verdict` moves the parent's `Last Verdict`/`Last Run`
 * (trigger-owned columns on the SAME Test Case row), and the Results LIST for that Test Case, so a
 * later verdict edit is reflected wherever either is read.
 */
export function useUpdateTestResult(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: UpdateTestResultInput): Promise<TestResult> => {
      const { data, error, response } = await apiClient.PATCH('/v1/test-results/{id}', {
        params: { path: { id } },
        body: input,
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as TestResult
    },
    onSuccess: (result) => {
      qc.setQueryData(testResultKeys.detail(id), result)
      void qc.invalidateQueries({ queryKey: testResultKeys.list(result.testCaseId) })
      void qc.invalidateQueries({ queryKey: testCaseKeys.detail(result.testCaseId) })
    },
  })
}

export function useTestResultActivity(id: string | undefined) {
  return useQuery({
    queryKey: testResultKeys.activity(id ?? ''),
    queryFn: async (): Promise<ActivityLog[]> => {
      if (!id) return []
      const { data, error, response } = await apiClient.GET('/v1/test-results/{id}/activity', {
        params: { path: { id }, query: { page: 1, pageSize: 100 } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return (data as { data?: ActivityLog[] } | undefined)?.data ?? []
    },
    enabled: !!id,
    staleTime: 15_000,
  })
}
