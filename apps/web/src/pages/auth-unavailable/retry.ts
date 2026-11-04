import { retryAuthBootstrap, type AuthBootstrapOutcome } from '@/shared/api/auth-bootstrap'

/**
 * The path to return to after a successful retry, or `/`.
 *
 * Only a SAME-ORIGIN absolute path is accepted: `//host` is protocol-relative (an open redirect)
 * and anything without a leading slash is not a route. The value comes from our own router, but
 * it also round-trips through the address bar, so it is untrusted input.
 */
export function safeReturnTo(raw: string | null): string {
  if (!raw) return '/'
  try {
    // PARSED, not prefix-matched: browsers treat `/\evil.example` as `//evil.example` and
    // `/<TAB>/evil.example` similarly, so a string guard lets an open redirect through. Resolving
    // against our own origin and comparing the ORIGIN is the only check that agrees with the
    // browser's URL parser.
    const url = new URL(raw, window.location.origin)
    if (url.origin !== window.location.origin) return '/'
    // A PERCENT-ENCODED backslash (`%5C`) is inert on the wire but decodes to `\`, and a
    // consumer downstream may re-parse it. Refuse the encoded form too, so the check does not
    // depend on who decodes what.
    const decodedPath = decodeURIComponent(url.pathname)
    if (decodedPath.startsWith('//') || decodedPath.includes('\\')) return '/'
    return url.pathname + url.search + url.hash
  } catch {
    return '/'
  }
}

/**
 * The recovery screen's retry, as a function of its side effects: re-run bootstrap (latch reset),
 * and — only when the session came back — send the caller to the page they were on. Returns
 * whether the session was restored, so the screen can keep itself up when it was not.
 */
export async function retrySession(
  search: string,
  navigate: (target: string) => void,
): Promise<AuthBootstrapOutcome> {
  const outcome = await retryAuthBootstrap()
  const returnTo = safeReturnTo(new URLSearchParams(search).get('returnTo'))
  if (outcome === 'restored') {
    navigate(returnTo)
  } else if (outcome === 'signedOut') {
    // A GENUINE 401 during the retry: the session is dead, so sign-in is the only way forward —
    // the same destination `requireAuth` uses, and never left on a recovery screen that cannot
    // recover.
    const loginSearch = returnTo !== '/' ? `?returnTo=${encodeURIComponent(returnTo)}` : ''
    navigate(`/login${loginSearch}`)
  }
  return outcome
}
