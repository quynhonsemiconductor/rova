/**
 * Story Target End Date + Carryover (Phase 7 CO) — the SPA api layer.
 *
 * Its own file, re-exported from `api.ts`, for the reason `split-api.ts` gives: `api.ts` holds the
 * SPA file-length ratchet.
 *
 * **The server owns the rules.** `useCarryoverOptions` fetches the eligible window and the SPA only
 * mirrors the date predicate from that payload to disable days (plan D5); the PATCH and the POST
 * re-validate everything.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { apiClient } from '@/shared/api/http-client'
import { apiErrorMessage } from '@/shared/api/api-error'
import type { components } from '@/shared/api/generated/api'

/** Generated from the served OpenAPI spec — never hand-written. */
export type CarryoverOptions = components['schemas']['CarryoverOptionsResponseDto']
export type CarryoverOptionIteration = CarryoverOptions['eligibleIterations'][number]
export type CarryOverWorkItemInput = components['schemas']['CarryOverWorkItemDto']
export type CarryOverWorkItemResult = components['schemas']['CarryOverWorkItemResponseDto']

/** Same `['work-items']` prefix as every work-item read, so the shared fan-out reaches it. */
export const carryoverOptionsKey = (workItemId: string) =>
  ['work-items', 'carryover-options', workItemId] as const

/** Returns the QUERY (bind it to a const before wrapping — see `resource.ts`). */
export function useCarryoverOptions(
  workItemId: string | undefined,
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: carryoverOptionsKey(workItemId ?? ''),
    queryFn: async (): Promise<CarryoverOptions | null> => {
      if (!workItemId) return null
      const { data, error, response } = await apiClient.GET(
        '/v1/work-items/{id}/carryover-options',
        { params: { path: { id: workItemId } } },
      )
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data ?? null
    },
    enabled: enabled && !!workItemId,
    staleTime: 10_000,
  })
}

/**
 * Commit one same-ID Carryover (plan D6). The `work-item` fan-out covers the record, Tasks,
 * Iteration Status and activity; the options feed and the reports are invalidated explicitly
 * because they are not keyed on a work item (the `useSplitWorkItem` precedent).
 */
export function useCarryOverWorkItem(workItemId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: CarryOverWorkItemInput): Promise<CarryOverWorkItemResult> => {
      const { data, error, response } = await apiClient.POST('/v1/work-items/{id}/carryover', {
        params: { path: { id: workItemId } },
        body: input,
      })
      // The server's message is kept: every refusal is actionable (the Story moved, the target is
      // no longer valid).
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as CarryOverWorkItemResult
    },
    meta: { invalidates: ['work-item'] },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: carryoverOptionsKey(workItemId) })
      void qc.invalidateQueries({ queryKey: ['reports'] })
    },
  })
}
