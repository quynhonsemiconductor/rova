/**
 * Auth bootstrap — runs once on app start (or page refresh). Restores the
 * session from the same-origin `__Secure-rova.session_token` cookie (identity 8) via the
 * cookie-authenticated GET /v1/auth/me. There are no in-browser tokens. Must be awaited
 * before the router guard evaluates `isAuthenticated`.
 */
import { ENV } from '@/shared/config/env'
import { useAuthStore } from '@/shared/lib/stores/auth.store'
import { setCsrfToken } from './csrf'
import { setFormatPrefs, resolveFormatPrefs } from '@/shared/lib/format-prefs'

const BASE = ENV.API_BASE_URL

/** Total attempts for a TRANSIENT failure (429, 5xx, a refused connection): the first plus two. */
const MAX_ATTEMPTS = 3
/** No single wait is longer than this, even when Retry-After asks for more. */
const MAX_DELAY_MS = 10_000
const BASE_DELAY_MS = 500
/**
 * Per-attempt network timeout. Without one a hung connection never settles: the latch stays
 * pending, `isLoading` never clears, and the recovery screen's retry joins a run that will never
 * finish. An abort is just another transient failure (the catch below).
 */
const REQUEST_TIMEOUT_MS = 15_000

let _bootstrapPromise: Promise<void> | null = null
/** False while a run is in flight, so a retry can JOIN it instead of starting a second one. */
let _bootstrapSettled = true

export function bootstrapAuth(): Promise<void> {
  if (_bootstrapPromise) return _bootstrapPromise
  _bootstrapSettled = false
  // The latch must RESOLVE whatever happens: `requireAuth` awaits it with no catch, and a
  // rejected latch would leave `isLoading` stuck with neither a session nor a recovery screen.
  // Anything `_run` did not anticipate becomes the same transient failure as a 5xx.
  _bootstrapPromise = _run()
    .catch((err: unknown) => {
      console.error('[auth-bootstrap] unexpected failure; showing the recovery screen', err)
      failBootstrap(useAuthStore.getState().setAuthError)
    })
    .finally(() => {
      _bootstrapSettled = true
    })
  return _bootstrapPromise
}

/** Clears the once-per-page-load latch. For a harness that re-runs bootstrap in one process. */
export function resetAuthBootstrap(): void {
  _bootstrapPromise = null
  _bootstrapSettled = true
}

/** What a retry found: a working session, a dead one, or still no answer. */
export type AuthBootstrapOutcome = 'restored' | 'signedOut' | 'unavailable'

/**
 * The recovery screen's retry. It JOINS a run already in flight (two concurrent runs would race
 * on `setUser`/`clearAuth`) and otherwise re-runs the whole bootstrap; the outcome says which
 * of the three states the session is in, so the caller can sign the user in, return them to
 * where they were, or leave the screen up.
 */
export async function retryAuthBootstrap(): Promise<AuthBootstrapOutcome> {
  if (!_bootstrapSettled && _bootstrapPromise) {
    await _bootstrapPromise
  } else {
    resetAuthBootstrap()
    await bootstrapAuth()
  }
  const state = useAuthStore.getState()
  // `authError` FIRST, per the store contract: a signed-in profile is KEPT through a transient
  // outage (setAuthError leaves it), so `isAuthenticated` alone would report 'restored' for a
  // session we could not reach.
  if (state.authError === 'unavailable') return 'unavailable'
  return state.isAuthenticated ? 'restored' : 'signedOut'
}

/** A retry delay: Retry-After when the server named one, else exponential backoff; capped. */
function delayFor(response: Response | null, attempt: number): number {
  const header = response?.headers.get('retry-after')
  if (header) {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_DELAY_MS)
    }
    const at = Date.parse(header)
    if (Number.isFinite(at)) {
      return Math.min(Math.max(at - Date.now(), 0), MAX_DELAY_MS)
    }
  }
  return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Restores the session, RETRYING the failures that are not about the session.
 *
 * A 429, a 5xx or a refused connection says nothing about whether the cookie is valid: treating
 * one as "signed out" cleared auth on the client and bounced a signed-in user to `/login` (from
 * which they sign in again only to land in the same 429). Only 401/403 clear the session; every
 * other failure is retried with Retry-After/backoff (capped), and if it still fails the app keeps
 * whatever profile it had and shows the recovery screen (`authError`), never the login page.
 */
async function _run(): Promise<void> {
  const { clearAuth, setLoading, setUser, setAuthError } = useAuthStore.getState()
  setLoading(true)
  setAuthError(null)

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let meRes: Response
    try {
      meRes = await fetch(`${BASE}/v1/auth/me`, {
        credentials: 'include',
        referrerPolicy: 'no-referrer',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch {
      // A network failure has no response: back off and try again.
      if (attempt + 1 < MAX_ATTEMPTS) {
        await sleep(delayFor(null, attempt))
        continue
      }
      failBootstrap(setAuthError)
      return
    }

    if (meRes.ok) {
      // A 200 with a body that is not JSON (a gateway HTML page, a truncated response) must not
      // throw out of `_run`: the promise would latch REJECTED and every later guard read would
      // see `isLoading` forever. It is a transient failure like any other.
      let user: MeResponse
      try {
        user = (await meRes.json()) as MeResponse
      } catch {
        failBootstrap(setAuthError)
        return
      }
      // Session-bound CSRF token for this page's lifetime — every state-changing
      // request echoes it back in the X-CSRF-Token header.
      setCsrfToken(user.csrfToken ?? null)
      // Resolve the date/number formatting prefs: user's own settings first, then
      // the workspace default, then UTC/en. Read by shared/lib/utils formatters.
      setFormatPrefs(
        resolveFormatPrefs(
          { locale: user.locale, timezone: user.timezone },
          user.workspaceDefaults ?? null,
        ),
      )
      setUser(
        {
          ...user,
          permissions: user.permissions ?? [],
          locale: user.locale ?? 'en',
          timezone: user.timezone ?? 'UTC',
          emailVerified: user.emailVerified ?? false,
          createdAt: user.createdAt ?? '',
          updatedAt: user.updatedAt ?? '',
        },
        user.memberships ?? [],
      )
      return
    }

    if (meRes.status === 401) {
      // A SESSION fact: the cookie is dead. Sign-in is the way back. 403 is NOT treated as one:
      // the route is self-scoped (`@SelfScoped` + `@Auth()` on `GET /v1/auth/me`), so there is no
      // permission it can refuse a signed-in caller for; a 403 here comes from something in front
      // of the route (edge/WAF) and says nothing about the session.
      setCsrfToken(null)
      clearAuth()
      return
    }

    // 429 / 5xx / a response that is not about this session: retry, honouring Retry-After.
    if (attempt + 1 < MAX_ATTEMPTS) {
      await sleep(delayFor(meRes, attempt))
      continue
    }
    failBootstrap(setAuthError)
    return
  }
}

/** The last attempt failed transiently: keep the store's profile, surface the recovery screen. */
function failBootstrap(setAuthError: (error: 'unavailable' | null) => void): void {
  setCsrfToken(null)
  setAuthError('unavailable')
}

interface MeResponse {
  id: string
  email: string
  displayName: string
  avatarUrl?: string | null
  locale: string
  timezone: string
  phone?: string | null
  role: string
  permissions: string[]
  emailVerified: boolean
  createdAt: string
  updatedAt: string
  csrfToken?: string
  memberships: {
    workspaceId: string
    name: string
    slug: string
    lastActiveAt: string | null
    roleSlug: string | null
    roleName: string | null
  }[]
  workspaceDefaults?: {
    timezone: string | null
    locale: string | null
    dateFormat: string | null
  } | null
}
