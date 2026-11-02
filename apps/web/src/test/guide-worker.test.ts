/**
 * The US-119 gate as a WORKER (the on-prem edge). The Pages Function's own spec covers the same
 * decisions through `proxyToApi`; these cases pin the Worker path: `/guide-assets/*` is gated, everything
 * else never executes user code, the session answer comes from the same-origin `/v1/bff/me`, and
 * every answer but a JSON 200/401/403 fails CLOSED.
 */
import { describe, expect, it, vi } from 'vitest'
import * as entry from '@/shared/lib/guide-gate.worker'
import {
  GUIDE_SECURITY_HEADERS,
  handleWorkerRequest,
  hasSessionCookie,
  loginRedirect,
} from '@/shared/lib/guide-worker-gate'

const ORIGIN = 'https://rova.example'
const SCREENSHOT = '/guide-assets/03-backlog-production.png'
const SIGN_IN = `${ORIGIN}/login?returnTo=%2Fuser-guide`

function assetsFetcher() {
  const fetch = vi.fn(
    async (request: Request) =>
      new Response(`asset:${new URL(request.url).pathname}`, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
  )
  return { fetch }
}

/** What `GET /v1/bff/me` answers for a signed-in reader. */
const signedIn = (headers: Record<string, string> = {}) =>
  new Response('{"user":{}}', {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })

const withSession = (path: string) =>
  new Request(`${ORIGIN}${path}`, { headers: { cookie: '__Host-rova_session=abc' } })

describe('the Worker entry', () => {
  it('exports its handler and nothing else', () => {
    // workerd treats every named export of the entry as an entrypoint; a constant there stops the
    // Worker from starting at all ("Incorrect type for map entry 'SESSION_COOKIE'").
    expect(Object.keys(entry)).toEqual(['default'])
    expect(typeof entry.default.fetch).toBe('function')
  })
})

describe('the User Guide gate as a Worker', () => {
  it('serves a non-guide path straight from the assets, without a session call', async () => {
    const assets = assetsFetcher()
    const fetchImpl = vi.fn()
    const res = await handleWorkerRequest(
      new Request(`${ORIGIN}/backlog`),
      { ASSETS: assets },
      { fetchImpl },
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('asset:/backlog')
    expect(fetchImpl).not.toHaveBeenCalled()
    // The guide's headers are the gate's, not the static path's: nothing was added here.
    expect(res.headers.get('content-security-policy')).toBeNull()
  })

  it('redirects an anonymous reader to sign-in, back to the guide, and never touches the assets', async () => {
    const assets = assetsFetcher()
    const res = await handleWorkerRequest(
      new Request(`${ORIGIN}${SCREENSHOT}`),
      { ASSETS: assets },
      { fetchImpl: vi.fn() },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(SIGN_IN)
    expect(assets.fetch).not.toHaveBeenCalled()
  })

  it('serves the file with the strict guide headers when the API says the session is valid', async () => {
    const assets = assetsFetcher()
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const request = new Request(input)
      expect(new URL(request.url).pathname).toBe('/v1/bff/me')
      expect(request.headers.get('cookie')).toContain('__Host-rova_session=abc')
      return signedIn({ 'set-cookie': 'refreshed=1; Path=/; Secure; HttpOnly' })
    })
    const res = await handleWorkerRequest(
      withSession(SCREENSHOT),
      { ASSETS: assets },
      { fetchImpl },
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(`asset:${SCREENSHOT}`)
    for (const [name, value] of Object.entries(GUIDE_SECURITY_HEADERS)) {
      expect(res.headers.get(name), name).toBe(value)
    }
    expect(res.headers.getSetCookie()).toContain('refreshed=1; Path=/; Secure; HttpOnly')
  })

  it('gates the chunks that carry the guide text as well as the screenshots', async () => {
    const assets = assetsFetcher()
    const res = await handleWorkerRequest(
      new Request(`${ORIGIN}/guide-assets/js/03-backlog-cong-viec-abc123.js`),
      { ASSETS: assets },
    )
    expect(res.status).toBe(302)
    expect(assets.fetch).not.toHaveBeenCalled()
  })

  it('redirects a present-but-rejected session (401 / 403) to sign-in', async () => {
    for (const status of [401, 403]) {
      const res = await handleWorkerRequest(
        withSession(SCREENSHOT),
        { ASSETS: assetsFetcher() },
        { fetchImpl: vi.fn(async () => new Response(null, { status })) },
      )
      expect(res.status, String(status)).toBe(302)
      expect(res.headers.get('location')).toBe(SIGN_IN)
    }
  })

  it('fails CLOSED on anything else: 500, 503, a network error, and a 200 that is not JSON', async () => {
    const cases: [string, () => Promise<Response>][] = [
      ['500', async () => new Response(null, { status: 500 })],
      ['503', async () => new Response(null, { status: 503 })],
      [
        'network error',
        async () => {
          throw new Error('network down')
        },
      ],
      // Same-origin `/v1/bff/me` on the static path (wrangler dev, a missing route) is the SPA's
      // index.html, 200. Seen in `wrangler dev`: before this case the gate served the file.
      [
        'index.html',
        async () =>
          new Response('<!doctype html>', {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          }),
      ],
    ]
    for (const [name, fetchImpl] of cases) {
      const assets = assetsFetcher()
      const res = await handleWorkerRequest(
        withSession(SCREENSHOT),
        { ASSETS: assets },
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      )
      expect(res.status, name).toBe(503)
      expect(await res.text()).toContain('temporarily unavailable')
      expect(assets.fetch, name).not.toHaveBeenCalled()
    }
  })

  it('treats a guest session exactly like a member session', async () => {
    const res = await handleWorkerRequest(
      withSession(SCREENSHOT),
      { ASSETS: assetsFetcher() },
      { fetchImpl: vi.fn(async () => signedIn()) },
    )
    expect(res.status).toBe(200)
  })

  it('claims /guide-assets and every path under it, and nothing else', async () => {
    for (const path of ['/guide-assets', '/guide-assets/', SCREENSHOT, '/guide-assets/js/x.js']) {
      const res = await handleWorkerRequest(new Request(`${ORIGIN}${path}`), {
        ASSETS: assetsFetcher(),
      })
      expect(res.status, path).toBe(302)
    }
    // Lookalikes, and the old static guide (`public/_redirects` moves it into the app).
    for (const path of [
      '/guide-assetsx/a.png',
      '/guide/',
      '/guide/en/01-lam-quen',
      '/user-guide',
    ]) {
      const res = await handleWorkerRequest(new Request(`${ORIGIN}${path}`), {
        ASSETS: assetsFetcher(),
      })
      expect(res.status, path).toBe(200)
    }
  })

  it('hasSessionCookie ignores empty values and other cookies', () => {
    const req = (cookie: string) => new Request(`${ORIGIN}${SCREENSHOT}`, { headers: { cookie } })
    expect(hasSessionCookie(req('__Host-rova_session='))).toBe(false)
    expect(hasSessionCookie(req('other=1; __Host-rova_session=v'))).toBe(true)
    expect(hasSessionCookie(req('__Host-rova_session_x=v'))).toBe(false)
  })

  it('loginRedirect always returns to the in-app guide, on the same origin', () => {
    for (const path of [SCREENSHOT, '/guide-assets/../admin', '//evil.example/x']) {
      expect(loginRedirect(new Request(`${ORIGIN}${path}`)).headers.get('location'), path).toBe(
        SIGN_IN,
      )
    }
  })
})
