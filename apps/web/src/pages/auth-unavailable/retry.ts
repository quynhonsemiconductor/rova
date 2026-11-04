import { retryAuthBootstrap } from '@/shared/api/auth-bootstrap'

/**
 * The path to return to after a successful retry, or `/`.
 *
 * Only a SAME-ORIGIN absolute path is accepted: `//host` is protocol-relative (an open redirect)
 * and anything without a leading slash is not a route. The value comes from our own router, but
 * it also round-trips through the address bar, so it is untrusted input.
 */
export function safeReturnTo(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/'
  return raw
}

/**
 * The recovery screen's retry, as a function of its side effects: re-run bootstrap (latch reset),
 * and — only when the session came back — send the caller to the page they were on. Returns
 * whether the session was restored, so the screen can keep itself up when it was not.
 */
export async function retrySession(
  search: string,
  navigate: (target: string) => void,
): Promise<boolean> {
  const restored = await retryAuthBootstrap()
  if (!restored) return false
  navigate(safeReturnTo(new URLSearchParams(search).get('returnTo')))
  return true
}
