/**
 * Test Cases API hooks — Phase 7. Phase A shipped the read path; Phase B adds create.
 * All types derive from the generated OpenAPI contract (never hand-written).
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { apiClient } from '@/shared/api/http-client'
import { ApiError, apiErrorMessage } from '@/shared/api/api-error'
import type { components } from '@/shared/api/generated/api'

export type TestCase = components['schemas']['TestCaseResponseDto']
export type TestCaseType = components['schemas']['TestCaseTypeOptionDto']
export type CreateTestCaseInput = components['schemas']['CreateTestCaseDto']

// A Test Case tab loads one Work Item's whole set (like Tasks) — bounded, so no cursor UI. The
// limit just has to exceed any real Work Item's Test Case count; the list route stays paged
// server-side (matches the plan's `{ data, pageInfo }` shape) for consistency with every other
// list route, even though this feature never asks for a second page.
const LIST_LIMIT = 200

export const testCaseKeys = {
  all: ['test-cases'] as const,
  list: (workItemId: string) => [...testCaseKeys.all, 'list', workItemId] as const,
  detail: (id: string) => [...testCaseKeys.all, 'detail', id] as const,
  byKey: (key: string) => [...testCaseKeys.all, 'by-key', key] as const,
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

/** Live (non-archived) Types for a project — the Create modal's dropdown, BR2's "first selectable" source. */
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
