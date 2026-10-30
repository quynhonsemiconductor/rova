/**
 * Session gate for the static User Guide (US-119), served by Cloudflare Pages at `/guide/*`, and for
 * the in-app guide's screenshots at `/guide-assets/*`.
 *
 * The guide is plain files under `apps/web/public/guide`, so Pages would serve every page and every
 * production screenshot to anyone with the URL. This gate runs in front of them (wired by the
 * path-scoped `functions/guide/_middleware.ts`, so the SPA's own assets never pass through user code)
 * and admits only a reader the API itself recognises as signed in.
 *
 * The decision is the API's, never ours: the cookie's PRESENCE only saves a round trip for a reader
 * who obviously has no session. A present cookie is checked against `GET /v1/bff/me`, the same call
 * the SPA's `auth-bootstrap.ts` makes, so an expired or revoked session is refused here exactly as it
 * is refused there.
 *
 * Fails CLOSED. Any answer other than 200 / 401 / 403 — a 5xx, a timeout, a network error — serves a
 * 503 and never the content. Pure and injectable like `proxy.ts`, so every branch is unit-testable.
 *
 * The check goes through `proxyToApi`, so it carries the same signed visitor address as every `/v1/*`
 * call; that is why the gate needs `EDGE_CLIENT_IP_SECRET` as well as `API_ORIGIN`.
 */
import { proxyToApi, type ProxyEnv } from './proxy'

export const SESSION_COOKIE = '__Host-rova_session'
const GUIDE_ROOT = '/guide/'
/**
 * The in-app guide's screenshots (`src/pages/guide/ui/guide-shot.tsx`), gated by
 * `functions/guide-assets/_middleware.ts`. The in-app guide's TEXT ships in the SPA's own chunks and
 * never reaches this gate; only these images do.
 */
export const GUIDE_ASSETS_ROOT = '/guide-assets/'
const SESSION_CHECK_TIMEOUT_MS = 5_000

/**
 * A screenshot is cached privately for an hour, unlike a guide page. Every guide page view used to cost
 * one session check per file; a screenshot that revalidated on every view would keep a share of that
 * cost for an image that does not change between deploys. `private` still keeps it out of any shared
 * cache, so the gate is skipped only for the browser that already passed it.
 */
export const GUIDE_ASSET_CACHE_CONTROL = 'private, max-age=3600'

/**
 * Applied to every guide response the gate lets through. The guide has no inline script or style and
 * no external origin (pinned by `src/test/user-guide.integrity.test.ts`), which is what lets this CSP
 * be this strict — tighter than the SPA's own meta-tag policy.
 */
export const GUIDE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'none'",
  // `private`: a shared cache must never hand a gated page to the next reader. `no-cache`: the
  // browser revalidates, which re-runs this gate, so a signed-out reader cannot read from history.
  'cache-control': 'private, no-cache',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-robots-tag': 'noindex, nofollow',
}

export function hasSessionCookie(request: Request): boolean {
  const header = request.headers.get('cookie')
  if (!header) return false
  return header.split(';').some((part) => {
    const [name, ...rest] = part.trim().split('=')
    return name === SESSION_COOKIE && rest.join('=').length > 0
  })
}

/**
 * `/login?returnTo=<path>` on the SAME origin as the request. `returnTo` is taken only from the
 * request's own pathname + search, and anything that is not a `/guide/` path collapses to the guide
 * root — so the value can never name another site (`//evil.example`) and the gate is not an open
 * redirect, whatever URL it is handed.
 */
export function loginRedirect(request: Request): Response {
  const url = new URL(request.url)
  const candidate = url.pathname + url.search
  const returnTo =
    candidate.startsWith(GUIDE_ROOT) && !candidate.startsWith('//') ? candidate : GUIDE_ROOT
  const login = new URL('/login', url.origin)
  login.searchParams.set('returnTo', returnTo)
  return new Response(null, {
    status: 302,
    headers: { location: login.toString(), 'cache-control': 'no-store' },
  })
}

function unavailable(): Response {
  return new Response('The User Guide is temporarily unavailable. Please try again shortly.', {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** `GET /v1/bff/me` on the SPA origin, carrying the reader's own headers; `proxyToApi` takes it from here. */
function sessionCheckRequest(request: Request): Request {
  const headers = new Headers(request.headers)
  headers.set('accept', 'application/json')
  return new Request(new URL('/v1/bff/me', request.url), { method: 'GET', headers })
}

function withGuideHeaders(
  request: Request,
  response: Response,
  setCookies: readonly string[],
): Response {
  // A response from `next()` can carry immutable headers; copy it before writing.
  const out = new Response(response.body, response)
  for (const [name, value] of Object.entries(GUIDE_SECURITY_HEADERS)) out.headers.set(name, value)
  if (new URL(request.url).pathname.startsWith(GUIDE_ASSETS_ROOT)) {
    out.headers.set('cache-control', GUIDE_ASSET_CACHE_CONTROL)
  }
  // Appended one at a time: joining Set-Cookie values corrupts them (see `buildClientResponse`).
  for (const cookie of setCookies) out.headers.append('set-cookie', cookie)
  return out
}

export interface GuideGateDeps {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export async function guardGuide(
  request: Request,
  env: ProxyEnv,
  next: () => Promise<Response>,
  { fetchImpl = fetch, timeoutMs = SESSION_CHECK_TIMEOUT_MS }: GuideGateDeps = {},
): Promise<Response> {
  if (!hasSessionCookie(request)) return loginRedirect(request)

  let reachedApi = false
  let session: Response
  try {
    session = await proxyToApi(sessionCheckRequest(request), env, (proxied) => {
      reachedApi = true
      return fetchImpl(new Request(proxied, { signal: AbortSignal.timeout(timeoutMs) }))
    })
  } catch {
    return unavailable()
  }
  // `proxyToApi` answered without calling the API: its 500 names the missing variable. Serve that, not
  // a 503, so a misconfigured deploy says what is wrong; the content stays unserved either way.
  if (!reachedApi) return session

  if (session.status === 401 || session.status === 403) return loginRedirect(request)
  if (session.status !== 200) return unavailable()

  // The body is not needed; release it so the runtime can reuse the connection.
  await session.body?.cancel()
  return withGuideHeaders(request, await next(), setCookiesOf(session))
}

/**
 * Every Set-Cookie on the session check, one string each. Falls back to iterating the headers when
 * `getSetCookie` is missing — `?? []` there would drop a refreshed session cookie silently, which is
 * the exact failure `buildClientResponse` documents.
 */
function setCookiesOf(response: Response): string[] {
  if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie()
  const cookies: string[] = []
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') cookies.push(value)
  })
  return cookies
}
