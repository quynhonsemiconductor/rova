/**
 * The running API's version, from `GET /v1/meta`.
 *
 * Paired with `ENV.APP_VERSION` (the web image tag the chart rendered into `/config.json`) so the
 * user menu can state BOTH versions. They disagree during a half-rolled deploy, which is exactly
 * the moment a reader needs to see it rather than a single number that hides which half moved.
 *
 * The endpoint is authenticated and cheap; it is on the DEFAULT rate-limit tier, so a menu read
 * cannot spend a tighter budget.
 */
import { useQuery } from '@tanstack/react-query'
import { apiClient } from '@/shared/api/http-client'
import { apiErrorMessage } from '@/shared/api/api-error'
import type { components } from '@/shared/api/generated/api'

export type ApiMetaDto = components['schemas']['MetaResponseDto']

export const API_META_QUERY_KEY = ['meta'] as const

export function useApiMeta() {
  return useQuery<ApiMetaDto>({
    queryKey: API_META_QUERY_KEY,
    queryFn: async () => {
      const { data, error } = await apiClient.GET('/v1/meta')
      if (error) throw new Error(apiErrorMessage(error))
      if (!data) throw new Error('Failed to load the API version')
      return data
    },
    staleTime: 5 * 60_000,
    retry: 1,
  })
}
