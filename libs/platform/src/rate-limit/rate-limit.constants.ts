/**
 * Rate limit tier definitions.
 *
 * Each tier defines a { limit, windowSeconds } pair used by RateLimitGuard to call CacheService.consumeRateLimit(). The tiers are
 * intentionally named by intent, not by numbers, so callers read like documentation.
 *
 *  DEFAULT        - every route without an explicit @RateLimit(), per USER once authenticated, per IP on a public route
 *  STRICT         - the few writes where abuse matters (uploads, invitation email), per USER
 *  PRE_AUTH       - every request, per IP, BEFORE authentication (PreAuthRateLimitGuard)
 *  PRE_AUTH_TOKEN - a request presenting an API token (`Authorization: Bearer rly_...`), per IP, BEFORE authentication
 *
 * Internal staff apps must never be throttled for working fast. Every per-USER tier is set at least 10x the
 * measured peak per-user rate, and the DEFAULT floor is 1,200 per minute. Only the buckets where abuse is the
 * threat (pre-auth per address, uploads, AI) stay tight.
 *
 * The sign-in tiers identity 7 needed (AUTH_LOGIN, AUTH_SSO_START, AUTH_IDP_LOOKUP, AUTH_REFRESH) are gone with the BFF controller that
 * used them: `/api/auth/*` is identity 8's, which rate-limits itself per IP in Valkey (the redirect endpoints 120 per 60 s, the callbacks
 * 100 per 10 s). Nothing in this repository calls `@RateLimit()` with them, and a tier nobody uses is a limit nobody maintains.
 */

export const RATE_LIMIT_METADATA_KEY = 'rova:rate_limit:tier';
export const SKIP_RATE_LIMIT_KEY = 'rova:rate_limit:skip';

export const RATE_LIMIT_TIERS = {
  /**
   * All routes without an explicit @RateLimit() decorator: 1,200 req/min per user.
   *
   * A limit must protect against abuse, never shape normal use. Rova is an internal staff app and
   * people work fast: the measured peak was 103 requests in one minute by one user — 58 answered and
   * 45 refused, mid-session — under the old 100 ceiling (18.5 hours of prod access logs,
   * 2026-11-04/05; busiest all-user minute 102; 69 refusals in the window). 10x the peak is 1,030,
   * so the floor of 1,200 is what ships — a page refresh fires a burst of queries (shell,
   * notifications feed, the active project's lists) and a slow client retrying must not approach the
   * ceiling.
   *
   * 1,200 per minute is still far below what one person can send abusively, and the per-address
   * PRE_AUTH floor is a separate, NAT-sized bucket that a signed-in request refunds.
   */
  DEFAULT: { limit: 1200, windowSeconds: 60 },

  /** Sensitive write operations: 20 req/min */
  STRICT: { limit: 20, windowSeconds: 60 },

  /**
   * Everything one address sends that does NOT authenticate: 1,200 per minute per IP.
   *
   * The user-keyed DEFAULT bucket cannot see traffic that never authenticates (a flood of requests with no session answers 401 from
   * identity's SessionGuard before DEFAULT is consulted). This is the cheap floor under it: generous on purpose, because a whole
   * office shares one address.
   *
   * An AUTHENTICATED request gives its slot back (`RateLimitGuard` refunds it once the principal is known), so a signed-in user
   * spends only their own tier and a day's normal office traffic cannot fill the shared address. The SAME is true of a valid API
   * token's PRE_AUTH_TOKEN slot: only a presentation that never authenticates keeps it, so each client is held by its user tier
   * and a shared CI/office egress is not penalised for having several clients behind it. What keeps a slot is traffic that never
   * proves who it is: failed logins, forged cookies, a sweep of guessed tokens.
   */
  PRE_AUTH: { limit: 1200, windowSeconds: 60 },

  /**
   * An API token presented: 300 per minute per IP.
   *
   * A request that carries a `rly_` value costs a database lookup before it can be refused, and a guess is free to repeat. Tighter than
   * PRE_AUTH because a CI runner or an integration makes tens of calls a minute, not hundreds, and a sweep is hundreds.
   */
  PRE_AUTH_TOKEN: { limit: 300, windowSeconds: 60 },
} as const;

export type RateLimitTier = keyof typeof RATE_LIMIT_TIERS;
