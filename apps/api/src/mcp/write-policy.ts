import { WRITE_TOOL_ROUTES } from './tools/registry';

/**
 * The REST-side write allowlist (MCP v2 design §6.1): the exact `METHOD path-template` pairs an
 * MCP-bridged request may reach. It is DERIVED from the tool catalogue's `WRITE_TOOL_ROUTES`, not
 * maintained by hand, so a route can be reachable from MCP only by being a listed write tool's
 * route — and `tools.routes.spec.ts` asserts the two sets are equal.
 *
 * Every other non-GET request through the bridge is refused 403 `MCP_WRITE_NOT_ALLOWED` by
 * {@link McpWriteGuard}, whatever a tool bug or a future edit tries to call.
 */

/** DI token for the allowlist, so a unit test can supply its own set. */
export const MCP_WRITE_ROUTE_SET = 'MCP_WRITE_ROUTE_SET';

/** `POST /v1/work-items` — the one spelling both the guard and the catalogue use. */
export function mcpWriteRouteKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`;
}

export const MCP_WRITE_ROUTES: ReadonlySet<string> = new Set(
  Object.values<{ method: string; url: string }>(WRITE_TOOL_ROUTES).map((route) =>
    mcpWriteRouteKey(route.method, route.url),
  ),
);
