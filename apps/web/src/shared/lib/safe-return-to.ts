/**
 * The path to return to after sign-in or a retry, or `/`.
 *
 * Only a SAME-ORIGIN absolute path is accepted. The value round-trips through the address bar,
 * so it is untrusted input, and a string prefix check is not enough: browsers treat `\` as `/`,
 * `/\evil.example` and `/<TAB>/evil.example` resolve to another origin, and `%5C` decodes to a
 * backslash downstream. Resolving against our own origin and comparing the ORIGIN is the only
 * check that agrees with the browser's own URL parser; the decoded-path check refuses the
 * encoded forms the parser leaves intact.
 *
 * ONE implementation for the router's `returnTo`, the recovery screen's retry and the login
 * page's `callbackURL`: three copies is three places an open redirect comes back.
 */
export function safeReturnTo(raw: string | null): string {
  if (!raw) return '/'
  try {
    const url = new URL(raw, window.location.origin)
    if (url.origin !== window.location.origin) return '/'
    const decodedPath = decodeURIComponent(url.pathname)
    if (decodedPath.startsWith('//') || decodedPath.includes('\\')) return '/'
    return url.pathname + url.search + url.hash
  } catch {
    return '/'
  }
}
