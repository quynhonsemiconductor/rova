import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import { isMcpBridged, PermissionDeniedException } from '@platform';

/**
 * Refuses a request that is itself authenticated by an API token.
 *
 * Applied to the routes that mint, list and revoke tokens. Without it a leaked token is not one
 * credential but a credential factory: the holder mints a fresh token with a new expiry, and revoking
 * the one you found changes nothing. GitHub applies the same rule to personal access tokens for the
 * same reason.
 *
 * Deliberately a guard and not a check inside the service: the property is "how was this request
 * authenticated", which is an HTTP-layer fact, and putting it in the service would let a future caller
 * reach the service by another route and skip it.
 */
@Injectable()
export class RejectApiTokenAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ apiTokenId?: string }>();
    if (request.apiTokenId) {
      throw new PermissionDeniedException(
        'API_TOKEN_CANNOT_MANAGE_TOKENS',
        'API tokens cannot create or manage API tokens. Use an interactive session.',
      );
    }
    // An MCP session is a credential too, and must not become a credential factory: the same
    // rule, one line over, for the bridge (the mcp session id is not an apiTokenId, so the
    // check above cannot see it).
    if (isMcpBridged(request)) {
      throw new PermissionDeniedException(
        'MCP_CANNOT_MANAGE_TOKENS',
        'MCP sessions cannot create or manage API tokens. Use an interactive session.',
      );
    }
    return true;
  }
}
