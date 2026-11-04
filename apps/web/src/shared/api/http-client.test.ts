import { describe, expect, it } from 'vitest'
import { rateLimitedQueryError, retryAfterSeconds } from './http-client'
import { ApiError } from './api-error'

const request = (method: string) => new Request('https://app.qnsc.vn/v1/projects', { method })
const rateLimited = (headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'slow down' } }), {
    status: 429,
    headers: { 'content-type': 'application/json', ...headers },
  })

describe('rateLimitedQueryError', () => {
  it('turns a rate-limited GET into an ApiError carrying the status and Retry-After', async () => {
    const error = await rateLimitedQueryError(request('GET'), rateLimited({ 'retry-after': '12' }))
    expect(error).toBeInstanceOf(ApiError)
    expect(error?.status).toBe(429)
    expect(error?.retryAfter).toBe(12)
    expect(error?.message).toBe('slow down')
  })

  it('reads an HTTP-date Retry-After too', () => {
    const at = new Date(Date.now() + 5000).toUTCString()
    const seconds = retryAfterSeconds(at)
    expect(seconds).toBeGreaterThanOrEqual(4)
    expect(seconds).toBeLessThanOrEqual(5)
  })

  it('leaves writes alone: a 429 on POST is the caller’s error, not a cache retry', async () => {
    expect(await rateLimitedQueryError(request('POST'), rateLimited())).toBeNull()
  })

  it('ignores other statuses', async () => {
    expect(
      await rateLimitedQueryError(request('GET'), new Response('{}', { status: 503 })),
    ).toBeNull()
  })

  it('still throws a usable error when the 429 body is not JSON', async () => {
    const error = await rateLimitedQueryError(request('GET'), new Response('busy', { status: 429 }))
    expect(error?.status).toBe(429)
    expect(error?.retryAfter).toBeUndefined()
  })
})
