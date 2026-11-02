import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { contextIdOf } from '@quynhonsemiconductor/identity';
import { isMcpBridged } from '../mcp-call-token';
import { IS_PUBLIC_KEY } from './public-key';
import type { JwtPayload } from './principal';

/** What identity's global `SessionGuard` leaves on the request: the `{ session, user }` of the cookie. */
interface RequestWithSession {
  session?: {
    session: { id: string; contextId?: string | null };
    user: { id: string };
  };
  user?: JwtPayload;
  apiTokenId?: string;
}

/**
 * Authentication for rova's routes, on top of identity 8: the route-level half that `@Auth()` and `@AuthPolicy()` mount.
 *
 * `@quynhonsemiconductor/identity`'s `SessionGuard` is registered globally (`APP_GUARD`) by the identity module. It
 * resolves the session cookie, refuses a request without one, refuses a banned user, and puts `{ session, user }` on the
 * request. A request authenticated by an API token has no session: `ApiTokenGuard` (a global guard that runs BEFORE
 * `SessionGuard`) verified the token, wrote `request.user` and told `SessionGuard` to stand aside. This guard turns
 * either into the one principal the rest of the codebase reads.
 *
 * It does NOT read the database: permissions are resolved per request by `PolicyGuard`.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  private readonly logger = new Logger(SessionAuthGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithSession>();

    // Authenticated by an API token: the principal is already on the request (ApiTokenGuard).
    if (request.apiTokenId && request.user?.sub) return true;

    // Authenticated by the MCP principal bridge: McpPrincipalGuard consumed an in-process call
    // token — a credential that exists only inside the process, never on the wire — and wrote
    // `request.user` directly. There is no session and no token id by design (a tool call is not
    // a login); see apps/api/src/mcp/principal.guard.ts. The marker, not `request.user`'s mere
    // presence, is the proof: a bare user object alone must never pass this belt.
    if (isMcpBridged(request) && request.user?.sub) return true;

    const found = request.session;
    if (!found?.user?.id) {
      // identity's global guard answers first; this is the belt for a route mounted without it
      this.logger.warn('SessionAuthGuard reached a route with no identity session');
      throw new UnauthorizedException('Sign in required');
    }

    request.user = {
      sub: found.user.id,
      sessionId: found.session.id,
      workspaceId: contextIdOf(found) ?? '',
      permissions: [],
    };
    return true;
  }
}
