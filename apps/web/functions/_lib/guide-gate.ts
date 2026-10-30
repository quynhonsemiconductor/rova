/**
 * Session gate for the static User Guide (US-119), served by Cloudflare Pages at `/guide/*`, and for
 * the in-app guide's screenshots at `/guide-assets/*`.
 *
 * Both are plain files — the static guide under `apps/web/public/guide`, the in-app guide's screenshots
 * under `apps/web/public/guide-assets` — so Pages would serve every page and every production
 * screenshot to anyone with the URL. This gate runs in front of them (wired by the path-scoped
 * `functions/guide/_middleware.ts` and `functions/guide-assets/_middleware.ts`, so the SPA's own
 * assets never pass through user code)
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
 * The in-app guide's gated files, behind `functions/guide-assets/_middleware.ts`: its screenshots
 * (`src/pages/guide/ui/guide-shot.tsx`) and, under `js/`, the build chunks that carry its text
 * (`chunkFileName` in `vite.config.ts`). The rest of the SPA never reaches this gate.
 */
export const GUIDE_ASSETS_ROOT = '/guide-assets/'
/**
 * Where a refused guide-asset request sends the reader back to after signing in: the SPA's guide
 * route. Pinned to the router by `src/test/user-guide-gate-paths.test.ts`.
 */
export const IN_APP_GUIDE = '/user-guide'
const SESSION_CHECK_TIMEOUT_MS = 5_000

/**
 * Applied to every guide response the gate lets through. The guide has no inline script or style and
 * no external origin (pinned by `src/test/user-guide.integrity.test.ts`), which is what lets this CSP
 * be this strict — tighter than the SPA's own meta-tag policy.
 */
export const GUIDE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'none'",
  // `private`: a shared cache must never hand a gated file to the next reader. `no-cache`: the
  // browser revalidates, which re-runs this gate, so a signed-out reader cannot read from history.
  // Screenshots and text chunks included: a max-age would leave the guide readable from the disk
  // cache after sign-out, and screenshots — their names carry no content hash — stale after a deploy.
  // A revalidation costs one session check and, unchanged, a 304 rather than the file.
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
 * `/login?returnTo=<path>` on the SAME origin as the request. A static guide page comes back to
 * itself; an in-app guide file (a screenshot) comes back to `/user-guide`, the page that asked for
 * it; anything else collapses to the static guide root. `returnTo` is only ever the request's own
 * `/guide/` path or a constant, so it can never name another site (`//evil.example`) and the gate is
 * not an open redirect, whatever URL it is handed.
 */
export function loginRedirect(request: Request): Response {
  const url = new URL(request.url)
  const candidate = url.pathname + url.search
  let returnTo = GUIDE_ROOT
  if (candidate.startsWith(GUIDE_ASSETS_ROOT)) {
    // A screenshot is never the page the reader opened; the in-app guide is.
    returnTo = IN_APP_GUIDE
  } else if (candidate.startsWith(GUIDE_ROOT) && !candidate.startsWith('//')) {
    returnTo = candidate
  }
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

function withGuideHeaders(response: Response, setCookies: readonly string[]): Response {
  // A response from `next()` can carry immutable headers; copy it before writing.
  const out = new Response(response.body, response)
  for (const [name, value] of Object.entries(GUIDE_SECURITY_HEADERS)) out.headers.set(name, value)
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
  return withGuideHeaders(await next(), setCookiesOf(session))
}

/** A Pages middleware's context, as far as the gate uses it. */
export interface GuideMiddlewareContext {
  request: Request
  env: ProxyEnv
  next: () => Promise<Response>
}

/**
 * The `onRequest` of every gated folder's `_middleware.ts`, which only re-exports it: Pages scopes a
 * middleware by its folder, so each gated path needs its own file, and this keeps that file to one
 * line instead of a copy of the wiring.
 */
export const guideMiddleware = (context: GuideMiddlewareContext): Promise<Response> =>
  guardGuide(context.request, context.env, context.next)

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
