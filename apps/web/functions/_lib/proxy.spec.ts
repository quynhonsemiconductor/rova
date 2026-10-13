import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EDGE_IP_HEADER,
  EDGE_SIG_HEADER,
  EDGE_TS_HEADER,
  signEdgeClientIp,
} from '@quynhonsemiconductor/platform-http/edge'
import { SPA_FORWARD_HEADERS, buildTarget, proxyToApi, type ProxyEnv } from './proxy'

const SECRET = 'e'.repeat(40)
const ENV: ProxyEnv = {
  API_ORIGIN: 'https://rova-api-dev.qnsc.vn',
  EDGE_CLIENT_IP_SECRET: SECRET,
}

afterEach(() => vi.useRealTimers())

/** Run the proxy against a stub API and hand back the request that reached it. */
async function forward(request: Request, env: ProxyEnv = ENV, upstream = new Response('ok')) {
  const fetcher = vi.fn().mockResolvedValue(upstream)
  const response = await proxyToApi(request, env, fetcher)
  return { response, sent: fetcher.mock.calls[0]?.[0] as Request | undefined, fetcher }
}

describe('buildTarget', () => {
  it('keeps the path and query while swapping the origin', () => {
    expect(
      buildTarget(
        'https://rova-dev.qnsc.vn/v1/workspaces?limit=10&cursor=abc',
        ENV.API_ORIGIN!,
      ).toString(),
    ).toBe('https://rova-api-dev.qnsc.vn/v1/workspaces?limit=10&cursor=abc')
  })

  it('carries the BFF callback path and its query through unchanged', () => {
    expect(
      buildTarget(
        'https://rova-dev.qnsc.vn/v1/bff/callback?code=c&state=s',
        ENV.API_ORIGIN!,
      ).toString(),
    ).toBe('https://rova-api-dev.qnsc.vn/v1/bff/callback?code=c&state=s')
  })
})

describe('proxyToApi: configuration', () => {
  it('answers 500 naming API_ORIGIN when it is not set, and calls nothing', async () => {
    const { response, fetcher } = await forward(new Request('https://rova-dev.qnsc.vn/v1/me'), {
      EDGE_CLIENT_IP_SECRET: SECRET,
    })
    expect(response.status).toBe(500)
    await expect(response.text()).resolves.toMatch(/API_ORIGIN/)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([undefined, '', 'short', '   '])(
    'answers 500 naming EDGE_CLIENT_IP_SECRET when it is %j: it never forwards unsigned, which would put every visitor in one rate-limit bucket',
    async (secret) => {
      const { response, fetcher } = await forward(new Request('https://rova-dev.qnsc.vn/v1/me'), {
        API_ORIGIN: ENV.API_ORIGIN,
        ...(secret === undefined ? {} : { EDGE_CLIENT_IP_SECRET: secret }),
      })
      expect(response.status).toBe(500)
      await expect(response.text()).resolves.toMatch(/EDGE_CLIENT_IP_SECRET/)
      expect(fetcher).not.toHaveBeenCalled()
    },
  )
})

describe('proxyToApi: what reaches the API', () => {
  it('forwards method, path, query, cookie and the CSRF token', async () => {
    const { sent } = await forward(
      new Request('https://rova-dev.qnsc.vn/v1/work-items?limit=5', {
        method: 'POST',
        headers: {
          cookie: '__Host-rova_session=abc; __Host-rova_csrf=secret',
          'x-csrf-token': 'tok',
          'content-type': 'application/json',
          'idempotency-key': 'k-1',
          'cf-connecting-ip': '203.0.113.7',
        },
        body: '{"a":1}',
      }),
    )

    expect(sent?.method).toBe('POST')
    expect(sent?.url).toBe('https://rova-api-dev.qnsc.vn/v1/work-items?limit=5')
    expect(sent?.headers.get('cookie')).toBe('__Host-rova_session=abc; __Host-rova_csrf=secret')
    expect(sent?.headers.get('x-csrf-token')).toBe('tok')
    expect(sent?.headers.get('idempotency-key')).toBe('k-1')
    await expect(sent?.text()).resolves.toBe('{"a":1}')
  })

  it('lists exactly the SPA headers the shared allow-list lacks', () => {
    expect([...SPA_FORWARD_HEADERS].sort()).toEqual(
      ['baggage', 'cache-control', 'last-event-id', 'x-csrf-token'].sort(),
    )
  })

  it('does NOT forward a header a visitor could use to pick their own address', async () => {
    const { sent } = await forward(
      new Request('https://rova-dev.qnsc.vn/v1/me', {
        headers: {
          'cf-connecting-ip': '203.0.113.7',
          'x-forwarded-for': '192.0.2.1',
          'x-real-ip': '192.0.2.2',
          forwarded: 'for=192.0.2.3',
          'x-forwarded-host': 'evil.example',
        },
      }),
    )

    for (const name of [
      'x-forwarded-for',
      'x-real-ip',
      'forwarded',
      'x-forwarded-host',
      'cf-connecting-ip',
    ]) {
      expect(sent?.headers.get(name), name).toBeNull()
    }
  })

  it('replaces any x-qnsc-edge-* header the visitor sent with its own signed ones', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-13T00:00:00Z'))
    const { sent } = await forward(
      new Request('https://rova-dev.qnsc.vn/v1/me', {
        headers: {
          'cf-connecting-ip': '203.0.113.7',
          [EDGE_IP_HEADER]: '192.0.2.77',
          [EDGE_SIG_HEADER]: 'forged',
          [EDGE_TS_HEADER]: '1',
        },
      }),
    )

    const expected = await signEdgeClientIp({
      secret: SECRET,
      ip: '203.0.113.7',
      method: 'GET',
      path: '/v1/me',
      now: new Date('2026-10-13T00:00:00Z'),
    })
    expect(sent?.headers.get(EDGE_IP_HEADER)).toBe('203.0.113.7')
    expect(sent?.headers.get(EDGE_TS_HEADER)).toBe(expected[EDGE_TS_HEADER])
    expect(sent?.headers.get(EDGE_SIG_HEADER)).toBe(expected[EDGE_SIG_HEADER])
  })

  it('signs the PATH it sends: the same signature does not verify for another path', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-13T00:00:00Z'))
    const { sent } = await forward(
      new Request('https://rova-dev.qnsc.vn/v1/bff/dev-login', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '203.0.113.7', 'content-type': 'application/json' },
        body: '{}',
      }),
    )

    const forPath = (path: string) =>
      signEdgeClientIp({
        secret: SECRET,
        ip: '203.0.113.7',
        method: 'POST',
        path,
        now: Date.now(),
      })
    expect(sent?.headers.get(EDGE_SIG_HEADER)).toBe(
      (await forPath('/v1/bff/dev-login'))[EDGE_SIG_HEADER],
    )
    expect(sent?.headers.get(EDGE_SIG_HEADER)).not.toBe((await forPath('/v1/me'))[EDGE_SIG_HEADER])
  })

  it('no longer sets x-forwarded-proto / x-forwarded-host: the API does not read them', async () => {
    const { sent } = await forward(
      new Request('https://rova-dev.qnsc.vn/v1/me', {
        headers: { 'cf-connecting-ip': '203.0.113.7' },
      }),
    )
    expect(sent?.headers.get('x-forwarded-proto')).toBeNull()
    expect(sent?.headers.get('x-forwarded-host')).toBeNull()
  })

  it('sends no signature when the visitor has no usable address (the API falls back)', async () => {
    const { sent } = await forward(new Request('https://rova-dev.qnsc.vn/v1/me'))
    expect(sent?.headers.get(EDGE_SIG_HEADER)).toBeNull()
  })

  it('does not follow redirects: the BFF callback 302 goes back to the browser', async () => {
    const { sent } = await forward(new Request('https://rova-dev.qnsc.vn/v1/bff/callback'))
    expect(sent?.redirect).toBe('manual')
  })
})

describe('proxyToApi: what comes back', () => {
  it('returns the API redirect with EVERY Set-Cookie untouched', async () => {
    const upstream = new Response(null, { status: 302, headers: { location: '/' } })
    upstream.headers.append('set-cookie', '__Host-rova_session=abc; Path=/; HttpOnly; Secure')
    upstream.headers.append('set-cookie', '__Host-bff_state=; Path=/; Max-Age=0')

    const { response } = await forward(
      new Request('https://rova-dev.qnsc.vn/v1/bff/callback?code=c&state=s'),
      ENV,
      upstream,
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/')
    expect(response.headers.getSetCookie()).toEqual([
      '__Host-rova_session=abc; Path=/; HttpOnly; Secure',
      '__Host-bff_state=; Path=/; Max-Age=0',
    ])
  })

  it('passes status and body through', async () => {
    const { response } = await forward(
      new Request('https://rova-dev.qnsc.vn/v1/me'),
      ENV,
      new Response('{"error":{"code":"X"}}', { status: 403 }),
    )
    expect(response.status).toBe(403)
    await expect(response.text()).resolves.toBe('{"error":{"code":"X"}}')
  })
})
