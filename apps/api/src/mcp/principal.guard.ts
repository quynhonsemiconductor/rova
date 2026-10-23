import { type CanActivate, type ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isUuid } from '@quynhonsemiconductor/identity';
import { markPreAuthenticated } from '@quynhonsemiconductor/identity/nest';
import { requestContextStorage, setRequestPrincipal } from '@quynhonsemiconductor/observability';
import {
  consumeMcpCallToken,
  IS_PUBLIC_KEY,
  type JwtPayload,
  MCP_CALL_TOKEN_HEADER,
} from '@platform';

interface McpRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: JwtPayload;
  apiTokenId?: string;
}

/**
 * Bridges the MCP in-process principal into the request the session path already reads.
 *
 * A global guard, imported BETWEEN `ApiTokensModule` and `AuthModule` (global guard order is
 * module order, and both neighbours matter): `ApiTokenGuard` runs first for a `rly_` token,
 * and identity's global `SessionGuard` runs after this one.
 *
 * When the request carries a live single-use MCP call token (minted only by the MCP transport,
 * inside the process — see principal.ts for why this is not AsyncLocalStorage), this guard
 * consumes it and writes the principal where the rest of the codebase reads it:
 *
 *  - `request.user`, the `JwtPayload` every controller and `PolicyGuard` reads — so authorization
 *    is the SAME decision, from the same database reads, as the person's session path;
 *  - the request context (`setRequestPrincipal`), so the rate limiter keys by the person and the
 *    access log names them — the same contract `ApiTokenGuard` keeps (its `recordPrincipal`);
 *  - `markPreAuthenticated(req, { userId })`, so `SessionGuard` stands aside AND still runs its
 *    ban check on the user, exactly as it does for an API token.
 *
 * With NO context set it does nothing: an `inject()` outside MCP falls through to the session
 * path, has no cookie, and is refused 401 by `SessionGuard`. The context is not ambient.
 *
 * It reads NOTHING from the request — no header, no body: a network request cannot forge the
 * in-process principal (pinned by principal.guard.spec.ts and the route spec).
 */
@Injectable()
export class McpPrincipalGuard implements CanActivate {
  private readonly logger = new Logger(McpPrincipalGuard.name);
  /** The no-request-context error is logged once per process. */
  private static warnedNoContext = false;

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<McpRequest>();

    // An API token authenticated the request already (ApiTokenGuard ran first); MCP never overrides it.
    if (request.apiTokenId) return true;

    // ONLY the header named by the constant, and only as a one-time key into the in-process
    // token store: the header carries an opaque token, never a principal, and is consumed here.
    const raw = request.headers[MCP_CALL_TOKEN_HEADER];
    const mcp = consumeMcpCallToken(Array.isArray(raw) ? raw[0] : raw);
    if (!mcp) return true;

    request.user = {
      sub: mcp.userId,
      sessionId: mcp.sessionId,
      workspaceId: mcp.workspaceId,
      // Empty, always. `PolicyGuard` resolves permissions from the database per request.
      permissions: [],
    };

    // Same contract as ApiTokenGuard.recordPrincipal: the rate limit, idempotency key, access log
    // and exception filter read the person from here. Never fails the request.
    try {
      const written = setRequestPrincipal({
        userId: mcp.userId,
        sessionId: mcp.sessionId,
        workspaceId: mcp.workspaceId,
      });
      if (!written && !McpPrincipalGuard.warnedNoContext) {
        McpPrincipalGuard.warnedNoContext = true;
        this.logger.error(
          'No request context to record the MCP principal in: seed it with enableCorrelationId(app).',
        );
      }
    } catch (err) {
      this.logger.warn(
        { err: (err as Error)?.constructor?.name },
        'Could not record the MCP principal in the request context',
      );
      const store = requestContextStorage.getStore();
      if (store && isUuid(mcp.userId)) store.userId = mcp.userId;
    }

    // SessionGuard stands aside, but still runs its ban check on this user — a banned person's
    // MCP tools stop the same way their session does.
    markPreAuthenticated(request, { userId: mcp.userId });
    return true;
  }
}
