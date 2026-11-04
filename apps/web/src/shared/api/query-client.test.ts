import { describe, expect, it } from 'vitest'
import { queryClient, retryDelayFor, shouldRetryQuery } from './query-client'
import { ApiError } from './api-error'

describe('query retry policy', () => {
  it('retries a 429 twice, honouring Retry-After', () => {
    const error = new ApiError({ error: { code: 'RATE_LIMITED' } }, 429, 7)
    expect(shouldRetryQuery(0, error)).toBe(true)
    expect(shouldRetryQuery(1, error)).toBe(true)
    expect(shouldRetryQuery(2, error)).toBe(false)
    expect(retryDelayFor(0, error)).toBe(7000)
  })

  it('never retries another 4xx', () => {
    for (const status of [400, 401, 403, 404, 409, 412, 422]) {
      const error = new ApiError({ error: { code: 'X' } }, status)
      expect(shouldRetryQuery(0, error), `${status} is not retried`).toBe(false)
    }
  })

  it('keeps the single retry for a 5xx or a transport failure', () => {
    expect(shouldRetryQuery(0, new ApiError({ error: {} }, 503))).toBe(true)
    expect(shouldRetryQuery(1, new ApiError({ error: {} }, 503))).toBe(false)
    expect(shouldRetryQuery(0, new TypeError('Failed to fetch'))).toBe(true)
    expect(shouldRetryQuery(1, new TypeError('Failed to fetch'))).toBe(false)
  })

  it('falls back to capped exponential backoff when the 429 names no wait', () => {
    expect(retryDelayFor(0, new ApiError({ error: {} }, 429))).toBe(1000)
    expect(retryDelayFor(1, new ApiError({ error: {} }, 429))).toBe(2000)
    // A Retry-After longer than the window is capped at the window's ceiling.
    expect(retryDelayFor(0, new ApiError({ error: {} }, 429, 3600))).toBe(60_000)
  })

  it('the shared client actually uses these policies for queries', () => {
    const queries = queryClient.getDefaultOptions().queries!
    expect(queries.retry).toBe(shouldRetryQuery)
    expect(queries.retryDelay).toBe(retryDelayFor)
    // Mutations keep the library default: a create is retried by intent, never by the cache.
    expect(queryClient.getDefaultOptions().mutations?.retry).toBeUndefined()
  })

  it('reads Retry-After as seconds from the error, not as a raw header string', () => {
    const error = new ApiError({ error: {} }, 429, 0)
    expect(retryDelayFor(0, error)).toBe(0)
  })
})
