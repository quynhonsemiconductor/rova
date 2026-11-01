import { describe, expect, it, vi } from 'vitest'
import { EDGE_IP_HEADER, EDGE_SIG_HEADER } from '@quynhonsemiconductor/platform-http/edge'
import {
  GUIDE_SECURITY_HEADERS,
  guardGuide,
  guideMiddleware,
  hasSessionCookie,
  loginRedirect,
} from './guide-gate'
import type { ProxyEnv } from './proxy'

const API_ORIGIN = 'https://rova-api-dev.qnsc.vn'
const SECRET = 'e'.repeat(40)
const ENV: ProxyEnv = { API_ORIGIN, EDGE_CLIENT_IP_SECRET: SECRET }
const SPA = 'https://rova-dev.qnsc.vn'
const SESSION = '__Host-rova_session=abc123'

function guideRequest(path = '/guide/en/03-backlog-cong-viec', cookie: string | null = SESSION) {
  const headers: Record<string, string> = { 'cf-connecting-ip': '203.0.113.7' }
  if (cookie) headers.cookie = cookie
  return new Request(`${SPA}${path}`, { headers })
}

const page = () => Promise.resolve(new Response('<html>guide</html>', { status: 200 }))

function apiAnswering(status: number, headers?: HeadersInit) {
  return vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status, headers }))
}

function returnToOf(response: Response): string | null {
  const location = response.headers.get('location')
  return location ? new URL(location).searchParams.get('returnTo') : null
}

describe('hasSessionCookie', () => {
  it('finds the session cookie among others', () => {
    expect(hasSessionCookie(guideRequest('/guide/', `a=1; ${SESSION}; b=2`))).toBe(true)
  })

  it('refuses an absent, empty or look-alike cookie', () => {
    expect(hasSessionCookie(guideRequest('/guide/', null))).toBe(false)
    expect(hasSessionCookie(guideRequest('/guide/', '__Host-rova_session='))).toBe(false)
    expect(hasSessionCookie(guideRequest('/guide/', 'x__Host-rova_session=abc'))).toBe(false)
    expect(hasSessionCookie(guideRequest('/guide/', '__Host-rova_csrf=abc'))).toBe(false)
  })
})

describe('gated folders', () => {
  it.each(['../guide/_middleware', '../guide-assets/_middleware'])(
    '%s runs the gate itself, not a copy of its wiring',
    async (path) => {
      const { onRequest } = (await import(path)) as { onRequest: unknown }
      expect(onRequest).toBe(guideMiddleware)
    },
  )
})

describe('loginRedirect', () => {
  it('sends the reader to the same-origin login with the guide path to come back to', () => {
    const res = loginRedirect(guideRequest('/guide/en/05-lap-ke-hoach?x=1'))
    expect(res.status).toBe(302)
    expect(new URL(res.headers.get('location')!).origin).toBe(SPA)
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login')
    expect(returnToOf(res)).toBe('/guide/en/05-lap-ke-hoach?x=1')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('never hands back a returnTo outside the guide, so it is not an open redirect', () => {
    for (const path of ['//evil.example/guide/', '/login', '/', '/guidebook']) {
      expect(returnToOf(loginRedirect(new Request(`${SPA}${path}`)))).toBe('/guide/')
    }
  })

  it('sends a refused screenshot request back to the in-app guide, not to the file', () => {
    const res = loginRedirect(guideRequest('/guide-assets/03-backlog-production.png'))
    expect(returnToOf(res)).toBe('/user-guide')
  })
})

describe('guardGuide', () => {
  it.each<[string, ProxyEnv]>([
    ['API_ORIGIN', { EDGE_CLIENT_IP_SECRET: SECRET }],
    ['EDGE_CLIENT_IP_SECRET', { API_ORIGIN }],
  ])('is a 500 naming %s when it is missing, and serves nothing', async (name, env) => {
    const fetchImpl = apiAnswering(200)
    const next = vi.fn(page)
    const res = await guardGuide(guideRequest(), env, next, { fetchImpl })
    expect(res.status).toBe(500)
    expect(await res.text()).toContain(name)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('redirects to login without calling the API when there is no session cookie', async () => {
    const fetchImpl = apiAnswering(200)
    const next = vi.fn(page)
    const res = await guardGuide(guideRequest('/guide/', null), ENV, next, { fetchImpl })
    expect(res.status).toBe(302)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('checks the session against /v1/bff/me with the reader cookie and the signed address', async () => {
    const fetchImpl = apiAnswering(200)
    await guardGuide(guideRequest(), ENV, page, { fetchImpl })
    const sent = fetchImpl.mock.calls[0]![0] as Request
    expect(sent.method).toBe('GET')
    expect(sent.url).toBe(`${API_ORIGIN}/v1/bff/me`)
    expect(sent.headers.get('cookie')).toBe(SESSION)
    expect(sent.headers.get('accept')).toBe('application/json')
    expect(sent.headers.get(EDGE_IP_HEADER)).toBe('203.0.113.7')
    expect(sent.headers.get(EDGE_SIG_HEADER)).toBeTruthy()
    expect(sent.headers.get('x-forwarded-for')).toBeNull()
  })

  it('serves the page with the guide security headers when the session is valid', async () => {
    const res = await guardGuide(guideRequest(), ENV, page, { fetchImpl: apiAnswering(200) })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<html>guide</html>')
    for (const [name, value] of Object.entries(GUIDE_SECURITY_HEADERS)) {
      expect(res.headers.get(name)).toBe(value)
    }
  })

  it('checks the session for an in-app guide screenshot and makes the browser revalidate it', async () => {
    // No max-age: a cached screenshot would outlive sign-out, and go stale after a deploy.
    const fetchImpl = apiAnswering(200)
    const shot = await guardGuide(
      guideRequest('/guide-assets/03-backlog-production.png'),
      ENV,
      page,
      { fetchImpl },
    )
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(shot.status).toBe(200)
    expect(shot.headers.get('cache-control')).toBe('private, no-cache')
  })

  it('refuses a screenshot to a reader with no session, without calling the API', async () => {
    const fetchImpl = apiAnswering(200)
    const next = vi.fn(page)
    const res = await guardGuide(guideRequest('/guide-assets/x.png', null), ENV, next, {
      fetchImpl,
    })
    expect(res.status).toBe(302)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('passes every Set-Cookie from the session check through individually', async () => {
    const headers = new Headers()
    headers.append('set-cookie', '__Host-rova_session=rotated; Path=/; Secure; HttpOnly')
    headers.append('set-cookie', '__Host-rova_csrf=new; Path=/; Secure')
    const res = await guardGuide(guideRequest(), ENV, page, {
      fetchImpl: apiAnswering(200, headers),
    })
    expect(res.headers.getSetCookie()).toEqual([
      '__Host-rova_session=rotated; Path=/; Secure; HttpOnly',
      '__Host-rova_csrf=new; Path=/; Secure',
    ])
  })

  it.each([401, 403])('redirects to login when the API answers %i', async (status) => {
    const next = vi.fn(page)
    const res = await guardGuide(guideRequest(), ENV, next, {
      fetchImpl: apiAnswering(status),
    })
    expect(res.status).toBe(302)
    expect(returnToOf(res)).toBe('/guide/en/03-backlog-cong-viec')
    expect(next).not.toHaveBeenCalled()
  })

  it.each([500, 502, 404, 302])(
    'fails closed with a 503 when the API answers %i',
    async (status) => {
      const next = vi.fn(page)
      const res = await guardGuide(guideRequest(), ENV, next, {
        fetchImpl: apiAnswering(status),
      })
      expect(res.status).toBe(503)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(next).not.toHaveBeenCalled()
    },
  )

  it('fails closed with a 503 when the session check throws', async () => {
    const next = vi.fn(page)
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('network down'))
    const res = await guardGuide(guideRequest(), ENV, next, { fetchImpl })
    expect(res.status).toBe(503)
    expect(next).not.toHaveBeenCalled()
  })

  it('fails closed with a 503 when the session check times out', async () => {
    const next = vi.fn(page)
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const signal = (input as Request).signal
      return new Promise<Response>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason))
      })
    })
    const res = await guardGuide(guideRequest(), ENV, next, { fetchImpl, timeoutMs: 10 })
    expect(res.status).toBe(503)
    expect(next).not.toHaveBeenCalled()
  })
})
