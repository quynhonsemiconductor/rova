import { describe, expect, it, vi } from 'vitest'

/**
 * The WIRING, not the helper: `apiClient` is built once with the runtime's base URL, so this file
 * loads its own module graph after applying a config (the same call boot makes).
 */
describe('apiClient wiring for a rate-limited READ', () => {
  it('GET 429 arrives as a thrown ApiError; POST 429 still returns its error body', async () => {
    vi.resetModules()
    const env = await import('@/shared/config/env')
    env.applyConfig({ apiBaseUrl: 'https://app.test' } as Parameters<typeof env.applyConfig>[0])

    const requests: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Request | string) => {
        requests.push(typeof input === 'string' ? input : input.url)
        return new Response(JSON.stringify({ error: { code: 'RATE_LIMITED' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '4' },
        })
      }),
    )

    const { apiClient } = await import('./http-client')

    // A GET is a cache read: TanStack Query must receive a THROW carrying status + wait.
    await expect(
      (apiClient as unknown as { GET: (url: string) => Promise<unknown> }).GET('/v1/projects'),
    ).rejects.toMatchObject({ status: 429, retryAfter: 4 })

    // A write is retried by intent, never by the cache: the ordinary error result comes back.
    const post = (await (
      apiClient as unknown as {
        POST: (url: string, options: object) => Promise<unknown>
      }
    ).POST('/v1/work-items', { body: {} })) as {
      error?: { error?: { code?: string } }
      response: Response
    }
    expect(post.response.status).toBe(429)
    expect(post.error?.error?.code).toBe('RATE_LIMITED')
    expect(requests[0]).toBe('https://app.test/v1/projects')
    vi.unstubAllGlobals()
  })
})
