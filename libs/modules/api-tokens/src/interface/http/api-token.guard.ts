import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import { requestContextStorage, setRequestPrincipal } from '@quynhonsemiconductor/observability';
import { isUuid } from '@quynhonsemiconductor/identity';
import { markPreAuthenticated } from '@quynhonsemiconductor/identity/nest';
import {
  bearerValue,
  InjectDrizzle,
  IS_PUBLIC_KEY,
  isApiTokenValue,
  type ApiTokenPrincipal,
  type DrizzleDB,
} from '@platform';
import { user as identityUser } from '../../../../../../db/schema/identity-auth';
import { ApiTokensService } from '../../application/api-tokens.service';

interface TokenRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: ApiTokenPrincipal;
  apiTokenId?: string;
}

/**
 * Authenticates an API token (`Authorization: Bearer rly_...`): a global guard that runs BEFORE identity's `SessionGuard`.
 *
 * WHY BEFORE. `SessionGuard` is global and answers 401 to a request with no session cookie. A token request has none, so
 * this guard verifies the token, writes the principal into the request context (so the rate limit keys by user and the
 * access log names the caller) and calls `markPreAuthenticated(req, { userId })` to tell `SessionGuard` to stand aside.
 * `SessionGuard` then does what the session path's checks would have done and this credential skipped: it refuses a BANNED
 * user (`isUserBanned`) and a marked request whose principal was not written. A user banned or offboarded is therefore
 * refused here too: a token is not a way around a ban. The registration order is the whole mechanism, so it is pinned by
 * `test/e2e/api-tokens.e2e.spec.ts`.
 *
 * Opaque and looked up in the database on every request, so revocation is a row update and the owner's permissions are
 * always read fresh (`PolicyGuard`). Every failure is the same 401 with the same message: distinguishing "expired" from
 * "never existed" tells an attacker which of their guesses was once real.
 *
 * Anything that is not a `rly_` value (no header, a stale JWT from an old tab, a cookie request) is left to
 * `SessionGuard`; a `@Public()` route authenticates nobody.
 */
@Injectable()
export class ApiTokenGuard implements CanActivate {
  private readonly logger = new Logger(ApiTokenGuard.name);
  /** The no-request-context error is logged once per process. */
  private static warnedNoContext = false;

  constructor(
    private readonly tokens: ApiTokensService,
    private readonly reflector: Reflector,
    @InjectDrizzle() private readonly db: DrizzleDB,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<TokenRequest>();
    const bearer = bearerValue(req.headers['authorization']);
    if (!bearer || !isApiTokenValue(bearer)) return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const verified = await this.tokens.verify(bearer);
    if (!verified) throw new UnauthorizedException('Invalid, expired or revoked API token');

    // The ban check that follows (`isUserBanned`) believes a user it cannot find is NOT banned. A token whose owner has no identity
    // user (not backfilled, never signed in on v8) would therefore sail past it: such a user cannot have been banned, and cannot be.
    // Refused with the same 401 as any unusable token; they sign in once, which creates the row, and the token works again.
    const [owner] = await this.db
      .select({ id: identityUser.id })
      .from(identityUser)
      .where(eq(identityUser.id, verified.userId))
      .limit(1);
    if (!owner) {
      this.logger.warn(
        { tokenId: verified.id },
        'API token refused: its owner has no identity user',
      );
      throw new UnauthorizedException('Invalid, expired or revoked API token');
    }

    req.user = {
      sub: verified.userId,
      workspaceId: verified.workspaceId,
      // The token's own id, in the place a session id would be: audit rows name the credential, not a session that never
      // existed (a token is not a login).
      sessionId: verified.id,
      // Empty, always. `PolicyGuard` resolves permissions from the database per request.
      permissions: [],
      apiTokenId: verified.id,
      ...(verified.scopes ? { scopes: verified.scopes } : {}),
    };
    req.apiTokenId = verified.id;

    this.recordPrincipal(verified);
    markPreAuthenticated(req, { userId: verified.userId });
    return true;
  }

  /**
   * Record WHO is calling in the request context, once: the contract with `platform-http` (>= 5), whose rate limit,
   * idempotency key, access log and exception filter read the user from there. Never fails the request: a value
   * `setRequestPrincipal` refuses (it should not happen: ids are uuids) is logged by class, and the fallback writes ONLY a
   * UUID user id and session id, never the workspace, so the access log can never carry something that is not an id.
   */
  private recordPrincipal(token: { id: string; userId: string; workspaceId: string }): void {
    try {
      const written = setRequestPrincipal({
        userId: token.userId,
        sessionId: token.id,
        workspaceId: token.workspaceId,
      });
      if (!written && !ApiTokenGuard.warnedNoContext) {
        ApiTokenGuard.warnedNoContext = true;
        this.logger.error(
          'No request context to record the API-token principal in: seed it with enableCorrelationId(app).',
        );
      }
    } catch (err) {
      this.logger.warn(
        { err: (err as Error)?.constructor?.name },
        'Could not record the API-token principal in the request context',
      );
      const store = requestContextStorage.getStore();
      if (store) {
        if (isUuid(token.userId)) store.userId = token.userId;
        if (isUuid(token.id)) store.sessionId = token.id;
      }
    }
  }
}
