import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOL_ROUTES } from './registry';

/**
 * ROVA-MCP-DESIGN §7.2: every tool maps to a REAL route. The registry carries each tool's REST
 * method + path; this spec asserts the path appears in the controller that owns it — with the
 * method decorator beside it — so a route rename or deletion breaks THIS test until the tool is
 * updated, instead of rotting silently into 404s at agent time.
 */

const CONTROLLERS = join(__dirname, '..', '..', '..', '..', '..', 'libs', 'modules');

/**
 * GATE G (MCP-PLAN §9/§10): every tool maps to an EXISTING route that carries
 * `@RequirePermission` (or is explicitly self-scoped) — no tool bypasses PolicyGuard. The
 * permission code is asserted too, so a route silently dropping its guard breaks this test.
 */
const OWNER: Record<
  keyof typeof TOOL_ROUTES,
  {
    file: string;
    controller: string;
    get: string;
    /** The route's @RequirePermission code, when it declares one. */
    permission?: string;
    /** The route uses @AuthorizedInService (resolve-then-check in the service). */
    authorizedInService?: string;
    /** The route is @SelfScoped (the caller's own data). */
    selfScoped?: boolean;
  }
> = {
  whoami: {
    file: 'identity/src/interface/http/auth.controller.ts',
    controller: "@Controller('auth')",
    get: "@Get('me')",
    selfScoped: true,
  },
  list_projects: {
    file: 'projects/src/interface/http/projects.controller.ts',
    controller: "@Controller('projects')",
    get: '@Get()',
    // cross-project list scoped by AccessService.listReadableProjectIds
  },
  get_project: {
    file: 'projects/src/interface/http/projects.controller.ts',
    controller: "@Controller('projects')",
    get: "@Get(':id')",
    permission: "'project:view'",
    // assertWorkspaceMember, then readable-by-actor, inside the service
    authorizedInService: "'project:view'",
  },
  list_project_members: {
    file: 'projects/src/interface/http/projects.controller.ts',
    controller: "@Controller('projects')",
    get: "@Get(':id/members')",
    permission: "'project:view'",
  },
  search_work_items: {
    file: 'work-items/src/interface/http/work-items.controller.ts',
    controller: "@Controller('work-items')",
    get: '@Get()',
    permission: "'work_item:view'",
  },
  get_work_item: {
    file: 'work-items/src/interface/http/work-items.controller.ts',
    controller: "@Controller('work-items')",
    get: "@Get(':id')",
    permission: "'work_item:view'",
  },
  get_work_item_by_key: {
    file: 'work-items/src/interface/http/work-items.controller.ts',
    controller: "@Controller('work-items')",
    get: "@Get('by-key')",
    // resolve-then-check: @AuthorizedInService + assertProjectPermission(WORK_ITEM_VIEW)
    // in work-items.service.ts getWorkItemByKey
    authorizedInService: 'WORK_ITEM_VIEW',
  },
  my_work: {
    file: 'work-items/src/interface/http/work-items.controller.ts',
    controller: "@Controller('work-items')",
    get: "@Get('my')",
    selfScoped: true,
  },
  list_backlog: {
    file: 'work-items/src/interface/http/work-items.controller.ts',
    controller: "@Controller('work-items')",
    get: "@Get('backlog')",
    permission: "'work_item:view'",
  },
  work_item_activity: {
    file: 'work-items/src/interface/http/work-items.controller.ts',
    controller: "@Controller('work-items')",
    get: "@Get(':id/activity')",
    permission: "'work_item:view'",
  },
  list_iterations: {
    file: 'iterations/src/interface/http/iterations.controller.ts',
    controller: "@Controller('iterations')",
    get: '@Get()',
    permission: "'timebox:view'",
  },
  iteration_options: {
    file: 'iterations/src/interface/http/iterations.controller.ts',
    controller: "@Controller('iterations')",
    get: "@Get('options')",
    permission: "'iteration:view'",
  },
  iteration_status: {
    file: 'iterations/src/interface/http/iterations.controller.ts',
    controller: "@Controller('iterations')",
    get: "@Get(':id/status')",
    permission: "'iteration:view'",
  },
  list_comments: {
    file: 'collaboration/src/interface/http/collaboration.controller.ts',
    controller: "@Controller('work-items/:workItemId')",
    get: "@Get('comments')",
    permission: "'work_item:view'",
  },
  list_releases: {
    file: 'releases/src/interface/http/releases.controller.ts',
    controller: "@Controller('releases')",
    get: '@Get()',
    permission: "'release:view'",
  },
  list_milestones: {
    file: 'milestones/src/interface/http/milestones.controller.ts',
    controller: "@Controller('milestones')",
    get: '@Get()',
    permission: "'milestone:view'",
  },
  iteration_burndown: {
    file: 'reporting/src/interface/http/reporting.controller.ts',
    controller: "@Controller('reports')",
    get: "@Get('iteration-burndown')",
    permission: "'report:view'",
  },
  velocity: {
    file: 'reporting/src/interface/http/reporting.controller.ts',
    controller: "@Controller('reports')",
    get: "@Get('velocity')",
    permission: "'report:view'",
  },
  team_capacity: {
    file: 'reporting/src/interface/http/reporting.controller.ts',
    controller: "@Controller('reports')",
    get: "@Get('team-capacity')",
    permission: "'report:view'",
  },
  unread_notifications: {
    file: 'notifications/src/interface/http/notifications.controller.ts',
    controller: "@Controller('notifications')",
    get: "@Get('unread-count')",
    selfScoped: true,
  },
};

describe('MCP tool catalogue maps to real routes', () => {
  it('every registered tool route exists in the owning controller', () => {
    const names = Object.keys(TOOL_ROUTES) as (keyof typeof TOOL_ROUTES)[];
    expect(names.sort()).toEqual([
      'get_project',
      'get_work_item',
      'get_work_item_by_key',
      'iteration_burndown',
      'iteration_options',
      'iteration_status',
      'list_backlog',
      'list_comments',
      'list_iterations',
      'list_milestones',
      'list_project_members',
      'list_projects',
      'list_releases',
      'my_work',
      'search_work_items',
      'team_capacity',
      'unread_notifications',
      'velocity',
      'whoami',
      'work_item_activity',
    ]);
    expect(names.length).toBe(20);
    for (const name of names) {
      const src = readFileSync(join(CONTROLLERS, OWNER[name].file), 'utf8');
      expect(src.includes(OWNER[name].controller), `${name}: controller prefix moved`).toBe(true);
      expect(src.includes(OWNER[name].get), `${name}: route decorator moved`).toBe(true);
      expect(TOOL_ROUTES[name].method).toBe('GET');
      // gate g: slice the mapped method's decorator block (from its @Get to the next
      // decorator at the same indent) and check the guard INSIDE it — a file-wide includes
      // would match a guard that lives on a different route.
      // anchored at a line start: prose may mention decorators inside comments
      const from = src.indexOf('\n  ' + OWNER[name].get);
      expect(from, `${name}: route decorator not found`).toBeGreaterThan(-1);
      // the decorated declaration runs from the route's @Get to the method's `async` keyword
      // (rova style: decorators, then `async methodName(`) — every guard decorator in
      // between belongs to this route
      const asyncAt = src.indexOf('\n  async ', from);
      const nextRoute = src.indexOf('\n  @Get', from + 1);
      const block =
        asyncAt === -1 || (nextRoute !== -1 && nextRoute < asyncAt)
          ? src.slice(from, nextRoute === -1 ? from + 1500 : nextRoute)
          : src.slice(from, asyncAt);
      if (OWNER[name].permission) {
        expect(block.includes(OWNER[name].permission), `${name}: permission code moved`).toBe(true);
      }
      if (OWNER[name].authorizedInService) {
        expect(
          block.includes('@AuthorizedInService'),
          `${name}: expected @AuthorizedInService on the by-key route`,
        ).toBe(true);
        expect(
          block.includes(OWNER[name].authorizedInService),
          `${name}: in-service check moved`,
        ).toBe(true);
      }
      if (OWNER[name].selfScoped) {
        // @SelfScoped must sit ON the mapped method's decorator block — not merely somewhere
        // in the controller file
        expect(
          block.includes('@SelfScoped('),
          `${name}: expected @SelfScoped on the mapped method`,
        ).toBe(true);
      }
    }
  });
});
