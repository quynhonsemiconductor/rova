/**
 * The product name identity 8 is built with (`createIdentity({ product })`): the cookie prefix, the 2FA issuer
 * and the app name. One constant, so the cookie name below cannot drift from the factory call.
 */
export const IDENTITY_PRODUCT = 'rova';

/**
 * Whether identity names its cookies `__Host-<product>.*` (`hostCookies`) instead of `__Secure-<product>.*`: in production, yes.
 * A browser stores a `__Host-` cookie only if it is `Secure`, has `Path=/` and has NO `Domain`, so a sibling `*.qnsc.vn` app cannot
 * set one for this host (the same property v7's `__Host-rova_session` had). Outside production the names stay `__Secure-`, which
 * is what the unit and e2e suites, local development over http://localhost and the quickstart use.
 *
 * Read once, at import, from the same `NODE_ENV` the env schema validates; the identity factory takes THIS value, so the name that is
 * issued and the name the CSRF gate and `ApiTokenGuard` look for cannot disagree.
 */
export const HOST_COOKIES: boolean = process.env['NODE_ENV'] === 'production';

/**
 * Name of the identity 8 session cookie: `__Host-<product>.session_token` in production, `__Secure-<product>.session_token` elsewhere
 * (Better Auth, `useSecureCookies`; host-only, `HttpOnly`, `SameSite=Lax`). Declared here so the CSRF gate that READS it cannot
 * disagree with the mount that ISSUES it.
 *
 * `SameSite=Lax` is identity's and stays: the Microsoft callback is a cross-site top-level navigation from login.microsoftonline.com,
 * and a `Strict` state cookie would not come back with it, so Strict cannot work for this flow (v7's `Strict` session cookie was set
 * by a response the browser had already landed on; identity's OAuth state cookie is not). `Lax` still withholds the cookie from
 * cross-site sub-requests and POSTs, and the CSRF token covers the rest.
 *
 * It replaces v7's `__Host-rova_session`. It holds a signed opaque token and nothing else.
 */
export const SESSION_COOKIE = `${HOST_COOKIES ? '__Host-' : '__Secure-'}${IDENTITY_PRODUCT}.session_token`;
