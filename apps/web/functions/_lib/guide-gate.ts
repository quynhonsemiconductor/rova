/**
 * Session gate for the User Guide's own files (US-119), served by Cloudflare Pages at `/guide-assets/*`:
 * its production screenshots, and under `js/` the build chunks that carry its text.
 *
 * The guide is a page of the SPA (`/user-guide`, behind `requireAuth`), but Pages serves built files to
 * anyone with the URL. So the files that ARE the guide are written under `/guide-assets/` and this gate
 * runs in front of them (wired by the path-scoped `functions/guide-assets/_middleware.ts`, so the rest
 * of the SPA never passes through user code), admitting only a reader the API recognises as signed in.
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
/**
 * Where a refused reader lands after signing in: the SPA's guide route. Pinned to the router by
 * `src/test/user-guide-gate-paths.test.ts`.
 */
export const IN_APP_GUIDE = '/user-guide'
/**
 * The in-app guide's gated files, behind `functions/guide-assets/_middleware.ts`: its screenshots
 * (`src/pages/guide/ui/guide-shot.tsx`) and, under `js/`, the build chunks that carry its text
 * (`chunkFileName` in `vite.config.ts`). The rest of the SPA never reaches this gate.
 */
export const GUIDE_ASSETS_ROOT = '/guide-assets/'
const SESSION_CHECK_TIMEOUT_MS = 5_000

/**
 * Applied to every guide file the gate lets through. Set here rather than left to `public/_headers`,
 * which Pages does not apply to a Function's response. The files are images and scripts, never a
 * document, so the CSP admits nothing a document would need.
 */
export const GUIDE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'none'",
  // `private`: a shared cache must never hand a gated file to the next reader. `no-cache`: the
  // browser revalidates, which re-runs this gate, so the guide is not readable from the disk cache
  // after sign-out, and a screenshot — its name carries no content hash — is never stale after a
  // deploy. A revalidation costs one session check and, unchanged, a 304 rather than the file.
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
 * `/login?returnTo=/user-guide` on the SAME origin as the request. A refused request is a screenshot or
 * a script the guide page asked for, never a page the reader opened, so it is not the place to return
 * to — the guide is. The value is a constant, so the gate cannot be an open redirect.
 */
export function loginRedirect(request: Request): Response {
  const login = new URL('/login', new URL(request.url).origin)
  login.searchParams.set('returnTo', IN_APP_GUIDE)
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
