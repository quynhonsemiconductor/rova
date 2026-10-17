import {
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  failOpenLog,
  requestContextStorage,
  SecurityMetrics,
  setRequestPrincipal,
} from '@quynhonsemiconductor/observability';
import { clientIp, type ClientIpRequest } from '@quynhonsemiconductor/platform-http';
import { AuthTokenCache } from '@quynhonsemiconductor/identity';
import {
  BFF_SESSION_COOKIE,
  BFF_SESSION_RESOLVER,
  type BffSessionResolver,
} from './bff-session-resolver';
import { API_TOKEN_RESOLVER, isApiTokenValue, type ApiTokenResolver } from './api-token-resolver';
import type { JwtPayload } from './jwt.strategy';

/**
 * JWT auth guard.
 * Verifies the Bearer access token, then populates request context with
 * workspaceId / userId / sessionId so downstream scoping works correctly.
 * Also checks the access-token denylist in the cache (set on logout).
 *
 * AUTHENTICATION only. The token carries no permissions — `PolicyGuard` resolves
 * those from the database per request — so there is no snapshot here that can go
 * stale, and no authorization epoch to compare. What the guard still enforces is
 * revocation: the per-token (logout) and per-user (offboarding) denylists.
 *
 * BFF (same-origin) mode: when a {@link BffSessionResolver} is bound and no
 * Bearer token is present, the guard instead authenticates from the opaque
 * `__Host-` session cookie — resolving (and transparently refreshing) the
 * server-side session. When the resolver is unbound (a product without BFF),
 * this path is skipped entirely and the Bearer flow is byte-for-byte unchanged.
 *
 * API-token mode: when an {@link ApiTokenResolver} is bound and the Bearer value carries the API-token
 * prefix, the guard authenticates from that opaque credential instead of verifying a JWT. Checked
 * BEFORE the JWT path because the two are distinguishable by shape and a token would otherwise fail
 * signature verification with a misleading error. Unbound, this path does not exist.
 *
 * Pair with @Public() decorator to opt-out individual routes.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(JwtAuthGuard.name);
  /** The no-request-context error is logged once per process. */
  private static warnedNoContext = false;

  constructor(
    private readonly authCache: AuthTokenCache,
    private readonly securityMetrics: SecurityMetrics,
    @Optional()
    @Inject(BFF_SESSION_RESOLVER)
    private readonly bffResolver?: BffSessionResolver,
    @Optional()
    @Inject(API_TOKEN_RESOLVER)
    private readonly apiTokenResolver?: ApiTokenResolver,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      cookies?: Record<string, string | undefined>;
      ip: string;
      socket?: { remoteAddress?: string };
      method?: string;
      url?: string;
      user?: JwtPayload;
      bffSid?: string;
      apiTokenId?: string;
    }>();

    // API-token path: an opaque machine credential, identified by its prefix. Ordered first because a
    // token and a JWT arrive in the same header and only their shape distinguishes them — verifying a
    // token as a JWT fails with "invalid signature", which is true and useless.
    const bearer = bearerValue(req.headers.authorization);
    if (this.apiTokenResolver?.enabled && bearer && isApiTokenValue(bearer)) {
      return this.authenticateFromApiToken(req, bearer);
    }

    // BFF session path: only when a resolver is bound + enabled, there is no
    // Bearer token (which always takes precedence), and the session cookie is
    // present. Anything else falls through to the unchanged JWT path below.
    if (this.bffResolver?.enabled && !hasBearerToken(req.headers.authorization)) {
      const sid = req.cookies?.[BFF_SESSION_COOKIE];
      if (sid) {
        return this.authenticateFromSession(req, sid);
      }
    }

    let result: boolean;
    try {
      result = await (super.canActivate(context) as Promise<boolean>);
    } catch (err) {
      // Re-throw expected auth failures as-is; convert infra errors to 401 so
      // NestJS never leaks a 500 to unauthenticated callers.
      if (err instanceof UnauthorizedException) throw err;
      this.logger.error({ err }, 'JWT strategy error during canActivate');
      throw new UnauthorizedException('Authentication service unavailable');
    }
    if (!result) return false;

    const user = req.user as JwtPayload;
    await this.enforceDenylist(user.jti, user.sub);
    return true;
  }

  /**
   * Authenticate a request from a BFF session id: resolve the session, enforce the
   * same denylist as the Bearer path, then populate `req.user`, `req.bffSid`, and
   * the request context so downstream code is path-agnostic.
   */
  private async authenticateFromSession(
    req: ClientIpRequest & { user?: JwtPayload; bffSid?: string },
    sid: string,
  ): Promise<boolean> {
    const claims = await this.bffResolver!.resolve(sid, clientIp(req));
    if (!claims) {
      throw new UnauthorizedException('Invalid or expired session');
    }
    await this.enforceDenylist(claims.jti, claims.sub);

    req.user = claims;
    req.bffSid = sid;
    this.recordPrincipal(claims);
    return true;
  }

  /**
   * Authenticate a request from an API token: resolve it, enforce the user-level denylist, then
   * populate `req.user`, `req.apiTokenId` and the request context so downstream code is path-agnostic.
   *
   * Only the USER denylist applies. The per-token (logout) denylist is keyed by a JWT `jti` and has
   * nothing to say about a credential that is revoked by a row update instead — the resolver has
   * already checked `revoked_at` and `expires_at`, which is the equivalent and is authoritative rather
   * than best-effort. The user denylist still matters: it is what closes the window between an
   * offboarding write and the token rows being revoked.
   */
  private async authenticateFromApiToken(
    req: ClientIpRequest & { user?: JwtPayload; apiTokenId?: string },
    rawToken: string,
  ): Promise<boolean> {
    const principal = await this.apiTokenResolver!.resolve(rawToken, clientIp(req));
    if (!principal) {
      throw new UnauthorizedException('Invalid, expired or revoked API token');
    }
    await this.enforceUserDenylist(principal.sub);

    req.user = principal;
    req.apiTokenId = principal.apiTokenId;
    this.recordPrincipal(principal);
    return true;
  }

  /**
   * User-level denylist only, with the same fail-open behaviour and the same telemetry as
   * {@link enforceDenylist}. Split out rather than parameterised so the Bearer/BFF path keeps its exact
   * two-lookup shape and this one does not pay for a `jti` it does not have.
   */
  private async enforceUserDenylist(sub: string): Promise<void> {
    try {
      if (await this.authCache.isUserRevoked(sub)) {
        throw new UnauthorizedException('Token has been revoked');
      }
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      this.logger.warn(
        failOpenLog('denylist', { err }),
        'User denylist check failed for API token; failing open',
      );
      this.securityMetrics.recordFailOpen('denylist');
    }
  }

  /**
   * Check both token-level (logout) and user-level (suspension/deactivation)
   * denylists. Best-effort: a cache outage fails open so valid users aren't
   * blocked — tokens still expire via their JWT `exp` claim.
   */
  private async enforceDenylist(jti: string, sub: string): Promise<void> {
    try {
      // Parallel lookups: saves ~1 RTT per authenticated request.
      const [tokenRevoked, userRevoked] = await Promise.all([
        this.authCache.isTokenDenied(jti),
        this.authCache.isUserRevoked(sub),
      ]);
      if (tokenRevoked || userRevoked) {
        throw new UnauthorizedException('Token has been revoked');
      }
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      // Tagged so the CloudWatch metric filter + alarm in infra/live/* can see
      // it — a cache outage means revoked tokens are being accepted.
      // Log AND counter: the log drives today's CloudWatch alarm, the counter drives
      // the same alert once metrics have a backend. Neither alone survives the
      // migration without a gap.
      this.logger.warn(
        failOpenLog('denylist', { err }),
        'Token denylist check failed; failing open',
      );
      this.securityMetrics.recordFailOpen('denylist');
    }
  }

  /**
   * Record WHO is calling in the request context, once, after authentication: the contract with
   * `platform-http` (>= 5), whose exception filter reads the user from here and from nowhere else, and
   * which rova's own rate limit, idempotency key and access log read through `currentUserId()` too.
   * Replaces `RequestContextService.setAuthContext`, which wrote the same three fields without checking
   * them; `setRequestPrincipal` also bounds them and refuses control characters.
   *
   * Never fails the request: a value it refuses (it should not happen) is logged by class and the
   * unchecked write is used, so observability can never turn a verified caller into a 401/500.
   */
  private recordPrincipal(user: { sub: string; sessionId: string; workspaceId?: string }): void {
    try {
      const written = setRequestPrincipal({
        userId: user.sub,
        sessionId: user.sessionId,
        ...(user.workspaceId ? { workspaceId: user.workspaceId } : {}),
      });
      // `false` = there was no request context to write to (nothing seeded one: CORRELATION_ID_MODE=disabled, or a call
      // outside a request). The request is still authenticated, but platform-http's rate limit, access log and exception
      // filter cannot tell who it is. Said once per process, at error: a misconfiguration, not a per-request event.
      if (!written && !JwtAuthGuard.warnedNoContext) {
        JwtAuthGuard.warnedNoContext = true;
        this.logger.error(
          'No request context to record the principal in: authenticated requests are keyed by address and carry no userId in the access log. Seed it with enableCorrelationId(app).',
        );
      }
    } catch (err) {
      this.logger.warn(
        { err: (err as Error)?.constructor?.name },
        'Could not record the principal in the request context',
      );
      const store = requestContextStorage.getStore();
      if (store) {
        store.userId = user.sub;
        store.sessionId = user.sessionId;
        store.workspaceId = user.workspaceId;
      }
    }
  }

  handleRequest<TUser extends { sub: string; workspaceId: string; sessionId: string }>(
    err: Error | null,
    user: TUser | false,
  ): TUser {
    if (err) {
      // Normalize unexpected infrastructure errors — don't re-throw raw DB/cache
      // errors which would produce a 500. Expected auth errors are UnauthorizedException.
      if (err instanceof UnauthorizedException) throw err;
      this.logger.error({ err }, 'Unexpected error in JWT handleRequest');
      throw new UnauthorizedException('Invalid or expired access token');
    }
    if (!user) {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    // Record who is calling after successful token verification
    this.recordPrincipal(user);

    return user;
  }
}

/** True when the Authorization header carries a Bearer token. */
function hasBearerToken(authorization: string | string[] | undefined): boolean {
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  return typeof value === 'string' && value.trim().toLowerCase().startsWith('bearer ');
}

/** The credential in an `Authorization: Bearer <value>` header, or undefined. */
function bearerValue(authorization: string | string[] | undefined): string | undefined {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  if (typeof header !== 'string') return undefined;
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith('bearer ')) return undefined;
  return trimmed.slice('bearer '.length).trim() || undefined;
}
