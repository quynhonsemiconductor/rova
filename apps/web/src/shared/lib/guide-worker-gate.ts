/**
 * The US-119 User Guide gate. The SPA is served by Workers Static Assets, which publish every file
 * unless a Worker runs first; this is that Worker's logic. The entry is `guide-gate.worker.ts`, kept
 * apart so it exports nothing but its handler (see there).
 *
 * The guide is a page of the SPA (`/user-guide`, behind `requireAuth`). What is gated is its files:
 * the production screenshots and, under `js/`, the build chunks that carry its text, all under
 * `/guide-assets/` (`chunkFileName` in `vite.config.ts`). Static assets are public, so this Worker runs
 * for `/guide-assets/*` ONLY (`assets.run_worker_first` in `wrangler.jsonc`) and every other path —
 * the SPA bundle, and the old `/guide/*` links that `public/_redirects` moves to `/user-guide` — stays
 * on the static path without executing user code.
 *
 * The decision is the API's, never ours: the cookie's PRESENCE only saves a round trip; a present
 * cookie is checked against `GET /v1/bff/me` on the SAME origin (the subrequest is same-host and
 * cloudflared forwards the reader's address). Fails CLOSED: any answer except a JSON 200 / 401 / 403 —
 * a 5xx, a timeout, a network error, an HTML page — serves 503 and never the content, and logs which
 * of those it was (`sessionCheckFailed`).
 *
 * `src/test/user-guide-gate-paths.test.ts` pins the gated path to the SPA, to the build's guide chunk
 * folder and to `wrangler.jsonc`.
 *
 * Guests pass: `/v1/bff/me` answers 200 for a guest session with `guest: true`, and the guide has no
 * role requirement.
 */

export const SESSION_COOKIE = '__Host-rova_session'
/** Where a refused reader lands after signing in: the SPA's guide route. */
export const IN_APP_GUIDE = '/user-guide'
/** The in-app guide's gated files: its screenshots, and under `js/` the chunks carrying its text. */
export const GUIDE_ASSETS_ROOT = '/guide-assets/'
const SESSION_CHECK_TIMEOUT_MS = 5_000

/**
 * Applied to every guide file the gate lets through. The files are images and scripts, never a
 * document, so the CSP admits nothing a document would need.
 */
export const GUIDE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'none'",
  // `private`: a shared cache must never hand a gated file to the next reader. `no-cache`: the
  // browser revalidates, which re-runs this gate, so the guide is not readable from the disk cache
  // after sign-out, and a screenshot — its name carries no content hash — is never stale after a deploy.
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

/** `/guide-assets` and everything under it — not a lookalike such as `/guide-assetsx/`. */
function isGuideFile(pathname: string): boolean {
  return pathname === GUIDE_ASSETS_ROOT.slice(0, -1) || pathname.startsWith(GUIDE_ASSETS_ROOT)
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

/**
 * `/v1/bff/me` answers `application/json`. Exactly that, deliberately: a `+json` type or anything else
 * is not the API's answer to this question, so it fails closed.
 */
function isJson(response: Response): boolean {
  return /^application\/json\s*(;|$)/i.test(response.headers.get('content-type') ?? '')
}

const MAX_LOGGED_CONTENT_TYPE = 60

/**
 * The session check's Content-Type as the log shows it: quoted, so where it ends is unambiguous, and cut
 * to 60 characters, so whatever answered cannot write a long line into our log. A missing header is
 * `no content-type`, which no quoted value can be mistaken for.
 */
function loggedContentType(response: Response): string {
  const type = response.headers.get('content-type')
  if (type === null) return 'no content-type'
  const max = MAX_LOGGED_CONTENT_TYPE
  return JSON.stringify(type.length > max ? `${type.slice(0, max - 1)}…` : type)
}

/**
 * A 503 for the reader, and one line for the Worker's log saying which way the check failed — a
 * timeout, a network error, a status, a non-JSON answer. Never the cookie or the path, and of the
 * headers only the check's own Content-Type (`loggedContentType`), because that names what answered
 * in the API's place. The line alone says whether the API, the route or the network is at fault.
 */
function sessionCheckFailed(reason: string): Response {
  console.warn(`[guide-gate] session check failed: ${reason}; serving 503`)
  return unavailable()
}

/** A thrown session check: `AbortSignal.timeout` rejects with a `TimeoutError`, anything else is the network. */
function thrownReason(error: unknown): string {
  return error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network error'
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
 * The whole Worker: `/guide-assets/*` goes through the gate, anything else straight to the static
 * assets (only reachable if `run_worker_first` is ever widened — and then still served, not gated).
 */
export async function handleWorkerRequest(
  request: Request,
  env: GuideWorkerEnv,
  { fetchImpl = fetch, timeoutMs = SESSION_CHECK_TIMEOUT_MS }: GuideWorkerDeps = {},
): Promise<Response> {
  const url = new URL(request.url)
  if (!isGuideFile(url.pathname)) return env.ASSETS.fetch(request)

  if (!hasSessionCookie(request)) return loginRedirect(request)

  let session: Response
  try {
    session = await fetchImpl(
      new Request(sessionCheckRequest(request), { signal: AbortSignal.timeout(timeoutMs) }),
    )
  } catch (error) {
    return sessionCheckFailed(thrownReason(error))
  }

  if (session.status === 401 || session.status === 403) return loginRedirect(request)
  if (session.status !== 200) return sessionCheckFailed(`status ${session.status}`)
  // A 200 counts only when it is the API's answer. The check is same-origin, so anything that puts
  // `/v1/*` back on the static path — `wrangler dev`, or a missing route — answers it with the SPA's
  // `index.html` (200, text/html), which must not read as "signed in".
  if (!isJson(session)) {
    return sessionCheckFailed(`200 that is not JSON (${loggedContentType(session)})`)
  }

  // The body is not needed; release it so the runtime can reuse the connection.
  await session.body?.cancel()
  return withGuideHeaders(await env.ASSETS.fetch(request), setCookiesOf(session))
}
