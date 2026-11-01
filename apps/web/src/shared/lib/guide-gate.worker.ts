/**
 * The US-119 User Guide gate, as a WORKER entry (the on-prem edge), replacing the Pages Function
 * `apps/web/functions/guide/_middleware.ts` for hosts served by Workers Static Assets.
 *
 * Workers Static Assets do not run Pages Functions, so `rova.qnsc.vn/guide/*` would be public there.
 * This Worker runs ONLY for `/guide/*` (`assets.run_worker_first` in `wrangler.jsonc`), so every other
 * path — the SPA bundle, `/guide`'s screenshots' sibling assets — stays on the static fast path.
 *
 * The decision is the API's, never ours, exactly as in `functions/_lib/guide-gate.ts`: the cookie's
 * PRESENCE only saves a round trip; a present cookie is checked against `GET /v1/bff/me` on the SAME
 * origin (no `API_ORIGIN`, no `EDGE_CLIENT_IP_SECRET`: the subrequest is same-host and cloudflared
 * forwards the reader's address). Fails CLOSED: any answer except 200 / 401 / 403 — a 5xx, a timeout,
 * a network error — serves 503 and never the content.
 *
 * Guests pass: `/v1/bff/me` answers 200 for a guest session with `guest: true`, and the guide has no
 * role requirement.
 */

export const SESSION_COOKIE = '__Host-rova_session'
const GUIDE_ROOT = '/guide/'
const SESSION_CHECK_TIMEOUT_MS = 5_000

/**
 * Applied to every guide response the gate lets through. The guide has no inline script or style and
 * no external origin (pinned by `src/test/user-guide.integrity.test.ts`), which is what lets this CSP
 * be this strict — tighter than the SPA's own policy.
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
 * `/login?returnTo=<path>` on the SAME origin. `returnTo` is taken only from the request's own pathname
 * + search, and anything that is not a `/guide/` path collapses to the guide root — so the value can
 * never name another site (`//evil.example`) and the gate is not an open redirect.
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

function isGuidePath(pathname: string): boolean {
  return pathname === GUIDE_ROOT.slice(0, -1) || pathname.startsWith(GUIDE_ROOT)
}

/** `GET /v1/bff/me` on this origin, carrying the reader's own headers (session cookie, visitor address). */
function sessionCheckRequest(request: Request): Request {
  const headers = new Headers(request.headers)
  headers.set('accept', 'application/json')
  return new Request(new URL('/v1/bff/me', request.url), { method: 'GET', headers })
}

function withGuideHeaders(response: Response, setCookies: readonly string[]): Response {
  const out = new Response(response.body, response)
  for (const [name, value] of Object.entries(GUIDE_SECURITY_HEADERS)) out.headers.set(name, value)
  // Appended one at a time: joining Set-Cookie values corrupts them.
  for (const cookie of setCookies) out.headers.append('set-cookie', cookie)
  return out
}

function setCookiesOf(response: Response): string[] {
  if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie()
  const cookies: string[] = []
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') cookies.push(value)
  })
  return cookies
}

export interface AssetFetcher {
  fetch(request: Request): Promise<Response>
}

export interface GuideWorkerEnv {
  ASSETS: AssetFetcher
}

export interface GuideWorkerDeps {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * The whole Worker: `/guide/*` and `/guide` go through the gate, everything else straight to the static
 * assets. Exported separately from the default export so the branches are unit-testable.
 */
export async function handleWorkerRequest(
  request: Request,
  env: GuideWorkerEnv,
  { fetchImpl = fetch, timeoutMs = SESSION_CHECK_TIMEOUT_MS }: GuideWorkerDeps = {},
): Promise<Response> {
  const url = new URL(request.url)
  if (!isGuidePath(url.pathname)) return env.ASSETS.fetch(request)

  if (!hasSessionCookie(request)) return loginRedirect(request)

  let session: Response
  try {
    session = await fetchImpl(
      new Request(sessionCheckRequest(request), { signal: AbortSignal.timeout(timeoutMs) }),
    )
  } catch {
    return unavailable()
  }

  if (session.status === 401 || session.status === 403) return loginRedirect(request)
  if (session.status !== 200) return unavailable()

  // The body is not needed; release it so the runtime can reuse the connection.
  await session.body?.cancel()
  return withGuideHeaders(await env.ASSETS.fetch(request), setCookiesOf(session))
}

export default {
  fetch(request: Request, env: GuideWorkerEnv): Promise<Response> {
    return handleWorkerRequest(request, env)
  },
}
