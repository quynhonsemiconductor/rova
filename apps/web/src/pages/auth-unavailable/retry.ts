import { retryAuthBootstrap, type AuthBootstrapOutcome } from '@/shared/api/auth-bootstrap'
import { safeReturnTo } from '@/shared/lib/safe-return-to'

export { safeReturnTo }

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
