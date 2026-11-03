import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import {
  isMcpBridged,
  MCP_CALL_TOKEN_HEADER,
  peekMcpCallToken,
  PermissionDeniedException,
} from '@platform';
import {
  isMcpWritesEnabled,
  MCP_READ_ROUTE_SET,
  MCP_WRITE_ROUTE_SET,
  mcpRequestAllowed,
} from './write-policy';

/**
 * The REST-side gate for MCP requests (MCP v2 design §6.1). A global guard, registered AFTER
 * `McpPrincipalGuard` (which marks the request as MCP-bridged), so it sees both the marker and
 * the matched route template.
 *
 * A request counts as MCP-bridged when EITHER the principal guard consumed its call token OR the
 * request still CARRIES a live one (peeked, not consumed). The second test is load-bearing: a
 * `@Public()` route returns from the principal guard before it consumes the token, so a bridged
 * POST to a public route would otherwise reach the handler with no gate at all. Fail closed.
 *
 * Allowed (see mcpRequestAllowed):
 *   - GET/HEAD on a READ-allowlisted route (the catalogue plus the feeds its tools compose);
 *   - any other method only when `MCP_WRITES_ENABLED` is on AND the route is a listed write
 *     route, derived from the write tools.
 *
 * A request that is not MCP-bridged passes untouched: this guard narrows MCP and nothing else.
 * Refusals are one uniform 403 with a stable code and no detail about which condition failed.
 */
interface BridgedRequest {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  routeOptions?: { url?: string };
}

@Injectable()
export class McpWriteGuard implements CanActivate {
  constructor(
    @Inject(MCP_READ_ROUTE_SET) private readonly reads: ReadonlySet<string>,
    @Inject(MCP_WRITE_ROUTE_SET) private readonly writes: ReadonlySet<string>,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest<BridgedRequest & object>();
    const carriedToken = peekMcpCallToken(request.headers?.[MCP_CALL_TOKEN_HEADER]) !== undefined;
    if (!isMcpBridged(request) && !carriedToken) return true;

    if (
      mcpRequestAllowed(request.method ?? 'GET', request.routeOptions?.url, {
        writesEnabled: isMcpWritesEnabled(),
        reads: this.reads,
        writes: this.writes,
      })
    ) {
      return true;
    }

    throw new PermissionDeniedException(
      'MCP_WRITE_NOT_ALLOWED',
      'This MCP session may not perform that request. Use the web app.',
    );
  }
}
