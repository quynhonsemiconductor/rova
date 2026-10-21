/**
 * Rate limit tier definitions.
 *
 * Each tier defines a { limit, windowSeconds } pair used by RateLimitGuard to call CacheService.consumeRateLimit(). The tiers are
 * intentionally named by intent, not by numbers, so callers read like documentation.
 *
 *  DEFAULT        - every route without an explicit @RateLimit(), per USER once authenticated, per IP on a public route
 *  STRICT         - sensitive writes (project delete, member removal, etc.)
 *  PRE_AUTH       - every request, per IP, BEFORE authentication (PreAuthRateLimitGuard)
 *  PRE_AUTH_TOKEN - a request presenting an API token (`Authorization: Bearer rly_...`), per IP, BEFORE authentication
 *
 * The sign-in tiers identity 7 needed (AUTH_LOGIN, AUTH_SSO_START, AUTH_IDP_LOOKUP, AUTH_REFRESH) are gone with the BFF controller that
 * used them: `/api/auth/*` is identity 8's, which rate-limits itself per IP in Valkey (the redirect endpoints 120 per 60 s, the callbacks
 * 100 per 10 s). Nothing in this repository calls `@RateLimit()` with them, and a tier nobody uses is a limit nobody maintains.
 */

export const RATE_LIMIT_METADATA_KEY = 'rova:rate_limit:tier';
export const SKIP_RATE_LIMIT_KEY = 'rova:rate_limit:skip';

export const RATE_LIMIT_TIERS = {
  /** All routes without an explicit @RateLimit() decorator: 100 req/min */
  DEFAULT: { limit: 100, windowSeconds: 60 },

  /** Sensitive write operations: 20 req/min */
  STRICT: { limit: 20, windowSeconds: 60 },

  /**
   * Everything one address sends, before anyone is authenticated: 1,200 per minute per IP.
   *
   * The user-keyed DEFAULT bucket cannot see traffic that never authenticates (a flood of requests with no session answers 401 from
   * identity's SessionGuard before DEFAULT is consulted). This is the cheap floor under it: generous on purpose, because a whole
   * office shares one address and each of its users is already held to DEFAULT.
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
