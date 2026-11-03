import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { AppConfigService, isMcpBridged, PermissionDeniedException } from '@platform';
import { MCP_WRITE_ROUTE_SET, mcpWriteRouteKey } from './write-policy';

/**
 * The REST-side belt for MCP writes (MCP v2 design §6.1). A global guard, registered AFTER
 * `McpPrincipalGuard` (which marks the request as MCP-bridged), so it sees both the marker and
 * the matched route template.
 *
 * An MCP-bridged GET is always allowed — reads are the v1 catalogue. Any other method is allowed
 * only when BOTH hold:
 *   - `MCP_WRITES_ENABLED` is on for this environment (the kill switch, default false), AND
 *   - `METHOD <matched route template>` is in `MCP_WRITE_ROUTES`, derived from the write tools.
 *
 * A request that is not MCP-bridged (the web, an API token, a test) passes untouched: this guard
 * narrows MCP and nothing else. Refusals are one uniform 403 with a stable code and no detail
 * about which condition failed, so a probe learns nothing about the catalogue.
 */
interface BridgedRequest {
  method?: string;
  routeOptions?: { url?: string };
}

@Injectable()
export class McpWriteGuard implements CanActivate {
  constructor(
    // Optional so a NEST MODULE that imports McpModule without the global platform config (a
    // fixture app) still instantiates this guard — and then writes are OFF, the safe default.
    // Production always has AppConfigService (PlatformModule is global).
    @Optional() private readonly config: AppConfigService | undefined,
    @Inject(MCP_WRITE_ROUTE_SET) private readonly routes: ReadonlySet<string>,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest<BridgedRequest & object>();
    if (!isMcpBridged(request)) return true;

    const method = (request.method ?? 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') return true;

    const route = request.routeOptions?.url;
    if (
      this.config?.get('MCP_WRITES_ENABLED') === true &&
      route !== undefined &&
      this.routes.has(mcpWriteRouteKey(method, route))
    ) {
      return true;
    }

    throw new PermissionDeniedException(
      'MCP_WRITE_NOT_ALLOWED',
      'This MCP session may not perform that write. Use the web app.',
    );
  }
}
