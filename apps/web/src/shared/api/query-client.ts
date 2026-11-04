import { QueryClient } from '@tanstack/react-query'

import { createInvalidationMutationCache } from './invalidation'

/**
 * How many times a failed READ is retried (this is the `queries` default — mutations keep
 * TanStack's no-retry default).
 *
 * A 429 is the server asking us to wait: it gets two more attempts, and `retryDelayFor` honours
 * the `Retry-After` the error carries. Any other 4xx is the caller's problem and is not retried;
 * a 5xx or a transport failure keeps the previous single retry.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  const status = (error as { status?: number })?.status
  if (status === 429) return failureCount < 2
  if (status && status >= 400 && status < 500) return false
  return failureCount < 1
}

/**
 * The wait before the next attempt. A 429's `Retry-After` wins (capped at the window ceiling);
 * otherwise exponential backoff, capped at 30s, like TanStack's own default.
 */
export function retryDelayFor(failureCount: number, error: unknown): number {
  const retryAfter = (error as { retryAfter?: number })?.retryAfter
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(retryAfter, 60) * 1000
  }
  return Math.min(1000 * 2 ** failureCount, 30_000)
}

/**
 * Shared TanStack Query client.
 * Defaults tuned per FRONTEND_STRUCTURE.md §6/§9 — background refetch is the
 * MVP "realtime" mechanism; staleTime is conservative and refined per-resource.
 *
 * Cache invalidation is centralised: the `mutationCache` below runs the
 * tag-based registry (see `invalidation.ts`) after every successful mutation,
 * so mutations declare WHAT they changed (`meta.invalidates`) rather than
 * hand-listing query keys in `onSuccess`.
 */
export const queryClient: QueryClient = new QueryClient({
  // The cache needs the client to invalidate; the client owns the cache — so we
  // hand the cache a lazy getter that resolves once `queryClient` is assigned.
  mutationCache: createInvalidationMutationCache(() => queryClient),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: shouldRetryQuery,
      retryDelay: retryDelayFor,
      refetchOnWindowFocus: true,
    },
  },
})
