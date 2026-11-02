/**
 * The US-119 gate as a WORKER (the on-prem edge). The Pages Function's own spec covers the same
 * decisions through `proxyToApi`; these cases pin the Worker path: `/guide/*` is gated, everything else
 * never executes user code, the session answer comes from the same-origin `/v1/bff/me`, and every
 * non-200/401/403 fails CLOSED.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  GUIDE_SECURITY_HEADERS,
  handleWorkerRequest,
  hasSessionCookie,
  loginRedirect,
} from '@/shared/lib/guide-gate.worker'

const ORIGIN = 'https://rova.example'

function assetsFetcher() {
  const fetch = vi.fn(
    async (request: Request) =>
      new Response(`asset:${new URL(request.url).pathname}`, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
  )
  return { fetch }
}

const pageResponse = () => new Response('</html>', { status: 200 })

describe('the User Guide gate as a Worker', () => {
  it('serves a non-guide path straight from the assets, without a session call', async () => {
    const assets = assetsFetcher()
    const fetchImpl = vi.fn()
    const res = await handleWorkerRequest(
      new Request(`${ORIGIN}/backlog`),
      { ASSETS: assets },
      {
        fetchImpl,
      },
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('asset:/backlog')
    expect(fetchImpl).not.toHaveBeenCalled()
    // The guide's headers are the gate's, not the static path's: nothing was added here.
    expect(res.headers.get('content-security-policy')).toBeNull()
    expect(res.headers.get('cache-control')).not.toBe(GUIDE_SECURITY_HEADERS['cache-control'])
  })

  it('redirects an anonymous reader to sign-in with returnTo, and never touches the assets', async () => {
    const assets = assetsFetcher()
    const res = await handleWorkerRequest(
      new Request(`${ORIGIN}/guide/01-lam-quen?lang=en`),
      { ASSETS: assets },
      { fetchImpl: vi.fn() },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      `${ORIGIN}/login?returnTo=%2Fguide%2F01-lam-quen%3Flang%3Den`,
    )
    expect(assets.fetch).not.toHaveBeenCalled()
  })

  it('serves the page with the strict guide headers when the API says the session is valid', async () => {
    const assets = assetsFetcher()
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const request = new Request(input)
      expect(new URL(request.url).pathname).toBe('/v1/bff/me')
      expect(request.headers.get('cookie')).toContain('__Host-rova_session=abc')
      return new Response('{}', {
        status: 200,
        headers: { 'set-cookie': 'refreshed=1; Path=/; Secure; HttpOnly' },
      })
    })
    const res = await handleWorkerRequest(
      new Request(`${ORIGIN}/guide/assets/03-backlog.png`, {
        headers: { cookie: '__Host-rova_session=abc', 'cf-connecting-ip': '203.0.113.7' },
      }),
      { ASSETS: assets },
      { fetchImpl },
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('asset:/guide/assets/03-backlog.png')
    for (const [name, value] of Object.entries(GUIDE_SECURITY_HEADERS)) {
      expect(res.headers.get(name), name).toBe(value)
    }
    expect(res.headers.getSetCookie()).toContain('refreshed=1; Path=/; Secure; HttpOnly')
  })

  it('redirects a present-but-rejected session (401 / 403) to sign-in', async () => {
    for (const status of [401, 403]) {
      const res = await handleWorkerRequest(
        new Request(`${ORIGIN}/guide/`, { headers: { cookie: '__Host-rova_session=abc' } }),
        { ASSETS: assetsFetcher() },
        { fetchImpl: vi.fn(async () => new Response(null, { status })) },
      )
      expect(res.status, String(status)).toBe(302)
    }
  })

  it('fails CLOSED on anything else: 500, 503 and a network error all serve 503', async () => {
    const cases: (() => Promise<Response>)[] = [
      async () => new Response(null, { status: 500 }),
      async () => new Response(null, { status: 503 }),
      async () => {
        throw new Error('network down')
      },
    ]
    for (const fetchImpl of cases) {
      const res = await handleWorkerRequest(
        new Request(`${ORIGIN}/guide/`, { headers: { cookie: '__Host-rova_session=abc' } }),
        { ASSETS: assetsFetcher() },
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      )
      expect(res.status).toBe(503)
      expect(await res.text()).toContain('temporarily unavailable')
    }
  })

  it('treats a guest session exactly like a member session', async () => {
    const res = await handleWorkerRequest(
      new Request(`${ORIGIN}/guide/`, { headers: { cookie: '__Host-rova_session=guest' } }),
      { ASSETS: assetsFetcher() },
      { fetchImpl: vi.fn(async () => pageResponse()) },
    )
    expect(res.status).toBe(200)
  })

  it('recognises the guide root and every path under it', async () => {
    for (const path of [
      '/guide',
      '/guide/',
      '/guide/01-lam-quen',
      '/guide/assets/x.png',
      '/guide-assets',
      '/guide-assets/03-backlog.png',
    ]) {
      const res = await handleWorkerRequest(new Request(`${ORIGIN}${path}`), {
        ASSETS: assetsFetcher(),
      })
      expect(res.status, path).toBe(302)
    }
    // Lookalikes are NOT the guide.
    for (const path of ['/guidebook', '/guide-assetsx/a.png']) {
      const res = await handleWorkerRequest(new Request(`${ORIGIN}${path}`), {
        ASSETS: assetsFetcher(),
      })
      expect(res.status, path).toBe(200)
    }
  })

  it('gates the guide screenshots: a signed-out reader is sent to sign-in, never to the asset', async () => {
    const assets = assetsFetcher()
    const res = await handleWorkerRequest(new Request(`${ORIGIN}/guide-assets/03-backlog.png`), {
      ASSETS: assets,
    })
    expect(res.status).toBe(302)
    expect(assets.fetch).not.toHaveBeenCalled()
  })

  it('fails CLOSED on a guide screenshot when the session check errors', async () => {
    const assets = assetsFetcher()
    const res = await handleWorkerRequest(
      new Request(`${ORIGIN}/guide-assets/03-backlog.png`, {
        headers: { cookie: '__Host-rova_session=abc' },
      }),
      { ASSETS: assets },
      { fetchImpl: vi.fn(async () => new Response('', { status: 500 })) },
    )
    expect(res.status).toBe(503)
    expect(assets.fetch).not.toHaveBeenCalled()
  })

  it('hasSessionCookie ignores empty values and other cookies', () => {
    const req = (cookie: string) => new Request(`${ORIGIN}/guide/`, { headers: { cookie } })
    expect(hasSessionCookie(req('__Host-rova_session='))).toBe(false)
    expect(hasSessionCookie(req('other=1; __Host-rova_session=v'))).toBe(true)
    expect(hasSessionCookie(req('__Host-rova_session_x=v'))).toBe(false)
  })

  it('loginRedirect never leaves the origin or the guide', () => {
    const res = loginRedirect(new Request(`${ORIGIN}/guide/../admin`))
    expect(res.headers.get('location')).toBe(`${ORIGIN}/login?returnTo=%2Fguide%2F`)
  })
})
