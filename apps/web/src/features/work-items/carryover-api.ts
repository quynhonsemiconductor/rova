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
import { useMutation, useQuery } from '@tanstack/react-query'

import { apiClient } from '@/shared/api/http-client'
import { apiErrorMessage } from '@/shared/api/api-error'
import type { components } from '@/shared/api/generated/api'

/** Generated from the served OpenAPI spec — never hand-written. */
export type CarryoverOptions = components['schemas']['CarryoverOptionsResponseDto']
export type CarryoverOptionIteration = CarryoverOptions['eligibleIterations'][number]
export type CarryOverWorkItemInput = components['schemas']['CarryOverWorkItemDto']
export type CarryOverWorkItemResult = components['schemas']['CarryOverWorkItemResponseDto']

/**
 * Same `['work-items']` prefix as every work-item read, so the shared `work-item` fan-out reaches it.
 * Takes `undefined` rather than a `''` sentinel: a disabled query keyed on `undefined` registers
 * nothing that a later id could collide with (PR 653 review).
 */
export const carryoverOptionsKey = (workItemId: string | undefined) =>
  ['work-items', 'carryover-options', workItemId] as const

/**
 * Returns the QUERY (bind it to a const before wrapping — see `resource.ts`). `enabled` is the only
 * gate on the id, so the query function can rely on it.
 */
export function useCarryoverOptions(
  workItemId: string | undefined,
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: carryoverOptionsKey(workItemId),
    queryFn: async (): Promise<CarryoverOptions> => {
      const { data, error, response } = await apiClient.GET(
        '/v1/work-items/{id}/carryover-options',
        { params: { path: { id: workItemId! } } },
      )
      if (error) throw new Error(apiErrorMessage(error, response.status))
      if (!data) throw new Error(`Carryover options came back empty (${response.status})`)
      return data
    },
    enabled: enabled && !!workItemId,
    staleTime: 10_000,
  })
}

/** Commit one same-ID Carryover (plan D6). Cache refresh: see `meta` below. */
export function useCarryOverWorkItem(workItemId: string) {
  return useMutation({
    mutationFn: async (input: CarryOverWorkItemInput): Promise<CarryOverWorkItemResult> => {
      const { data, error, response } = await apiClient.POST('/v1/work-items/{id}/carryover', {
        params: { path: { id: workItemId } },
        body: input,
      })
      // The server's message is kept: every refusal is actionable (the Story moved, the target is
      // no longer valid).
      if (error) throw new Error(apiErrorMessage(error, response.status))
      // A 2xx with no body is a contract break; fail HERE, attributed to this request, rather than
      // as `undefined` at the call site (PR 653 review).
      if (!data) throw new Error(`Carryover returned no body (${response.status})`)
      return data
    },
    /**
     * `work-item` is the shared fan-out tag (`shared/api/invalidation.ts`), and it ALREADY reaches
     * both other reads this changes: the carryover-options feed (`['work-items', …]` prefix) and every
     * report (`['reports']` is one of `WORK_ITEM_VIEW_ROOTS`). Both are pinned in
     * `query-invalidation.integrity.test.ts`, so a renamed root fails CI instead of going stale.
     */
    meta: { invalidates: ['work-item'] },
  })
}
