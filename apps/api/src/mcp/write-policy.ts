import { TOOL_ROUTES, WRITE_TOOL_ROUTES, type WriteRoute } from './tools/registry';

/**
 * The REST-side route policy for MCP (design §6.1): what a bridged request may reach.
 *
 * READS are an explicit allowlist too. Every GET route the tool catalogue and its reference
 * resolvers compose is listed; a bridged GET/HEAD to anything else is refused. HTTP already says
 * a GET is side-effect free — the allowlist is the second half: a tool cannot reach a read-shaped
 * route nobody chose for it (an admin export, a directory feed) just because the method is GET.
 *
 * WRITES are derived from the catalogue's `WRITE_TOOL_ROUTES`, so a route is reachable from MCP
 * only by being a listed write tool's route, only while `MCP_WRITES_ENABLED` is on.
 *
 * Route templates are compared with their parameter NAMES ERASED (`:id`, `:workItemId` and
 * `:param` are the same `:param`): Fastify's matched template and the catalogue's hand-written
 * path spell parameters differently, and a name mismatch must not silently widen or narrow the
 * gate. `tools.routes.spec.ts` asserts every literal a tool composes is in one of these sets.
 */

/** DI tokens, so a unit test can supply its own sets. */
export const MCP_WRITE_ROUTE_SET = 'MCP_WRITE_ROUTE_SET';
export const MCP_READ_ROUTE_SET = 'MCP_READ_ROUTE_SET';

/**
 * The process-wide kill switch, set ONCE from the validated env at bootstrap. A module-level
 * value rather than an injected service: the guard is instantiated by McpModule, which does not
 * import the platform config module, and a Nest fixture that imports McpModule must get the safe
 * default (off) without carrying the whole config graph.
 */
let writesEnabled = false;

/** Called by the bootstrap with `MCP_WRITES_ENABLED`, before any route is registered. */
export function setMcpWritesEnabled(enabled: boolean): void {
  writesEnabled = enabled;
}

export function isMcpWritesEnabled(): boolean {
  return writesEnabled;
}

/** Erase parameter names: `/v1/work-items/:workItemId` and `/v1/work-items/:id` both match. */
export function normalizeRouteTemplate(url: string): string {
  return url.replace(/\/:[A-Za-z0-9_]+/g, '/:param');
}

/** `POST /v1/work-items` — the one spelling the gate and the catalogue use. */
export function mcpWriteRouteKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${normalizeRouteTemplate(url)}`;
}

/** `GET /v1/work-items/:param` — reads are keyed the same way, with HEAD folded in. */
export function mcpReadRouteKey(url: string): string {
  return `GET ${normalizeRouteTemplate(url)}`;
}

/**
 * The GET routes the catalogue tools and the shared reference resolver (`tools/refs.ts`) call
 * but that are not a tool's own registry route: picker feeds, junction feeds and sub-resources.
 * Listed by hand on purpose — the routes spec fails when a tool composes one that is missing.
 */
export const MCP_REFERENCE_READ_ROUTES: readonly string[] = [
  '/v1/iterations/options',
  '/v1/releases/options',
  // The paged notification feed (the tool's registry route names the unpaged one).
  '/v1/notifications/paged',
  // A parent work item, resolved by refs.ts for the parent ref on a detail row.
  '/v1/work-items/:id',
  // The second feed of work_item_code_changes (the tool's own route lists connections).
  '/v1/work-items/:id/changesets',
  // get_milestone's junction feeds.
  '/v1/milestones/:id/artifacts',
  '/v1/milestones/:id/projects',
  '/v1/milestones/:id/releases',
  // get_portfolio_item's child page and get_release's artifact dashboard.
  '/v1/portfolio-items/:id/children',
  '/v1/releases/:id/artifacts',
  // The people picker refs.ts uses to name an assignee/lead/author.
  '/v1/workspaces/:workspaceId/member-options',
  // Reference feeds of rova_project_vocabulary (statuses and the teams are tool routes).
  '/v1/projects/:id/transitions',
  '/v1/projects/:id/labels',
  '/v1/projects/:id/test-case-types',
  '/v1/projects/:id/teams',
  // Sub-resources of rova_work_item_details (tasks and test-cases are tool routes).
  '/v1/work-items/:id/relations',
  '/v1/work-items/:id/labels',
  '/v1/work-items/:id/time-logs',
  '/v1/work-items/:id/watchers',
  '/v1/work-items/:id/attachments',
  // rova_list_test_results resolves the case by key before reading its results.
  '/v1/test-cases/by-key/:key',
  // rova_list_comments on a portfolio subject; the resolver's record read when a list row
  // carries no projectId.
  '/v1/portfolio-items/:id/comments',
  '/v1/portfolio-items/:id',
];

/** Every route a bridged READ may reach: the catalogue's GETs plus the reference feeds. */
export const MCP_READ_ROUTES: ReadonlySet<string> = new Set([
  ...Object.values<{ method: string; url: string }>(TOOL_ROUTES)
    .filter((route) => route.method === 'GET')
    .map((route) => mcpReadRouteKey(route.url)),
  ...MCP_REFERENCE_READ_ROUTES.map((url) => mcpReadRouteKey(url)),
]);

export const MCP_WRITE_ROUTES: ReadonlySet<string> = new Set(
  Object.values<WriteRoute | readonly WriteRoute[]>(WRITE_TOOL_ROUTES)
    .flatMap((routes) =>
      Array.isArray(routes) ? (routes as readonly WriteRoute[]) : [routes as WriteRoute],
    )
    .map((route) => mcpWriteRouteKey(route.method, route.url)),
);

/**
 * The one decision both enforcement points share. GET/HEAD passes only for a listed read route;
 * any other method only when writes are enabled AND its template is a listed write route.
 */
export function mcpRequestAllowed(
  method: string,
  route: string | undefined,
  policy: { writesEnabled: boolean; reads: ReadonlySet<string>; writes: ReadonlySet<string> },
): boolean {
  if (route === undefined) return false;
  const upper = method.toUpperCase();
  if (upper === 'GET' || upper === 'HEAD') {
    return policy.reads.has(mcpReadRouteKey(route));
  }
  return policy.writesEnabled && policy.writes.has(mcpWriteRouteKey(upper, route));
}
