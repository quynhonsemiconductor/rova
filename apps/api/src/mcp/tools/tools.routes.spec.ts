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
  { file: string; controller: string; get: string; permission?: string }
> = {
  whoami: {
    file: 'identity/src/interface/http/auth.controller.ts',
    controller: "@Controller('auth')",
    get: "@Get('me')",
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
    permission: "'work_item:view'",
  },
  my_work: {
    file: 'work-items/src/interface/http/work-items.controller.ts',
    controller: "@Controller('work-items')",
    get: "@Get('my')",
    // SelfScoped: the caller's own items, narrowed by listReadableProjectIds
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
};

describe('MCP tool catalogue maps to real routes', () => {
  it('every registered tool route exists in the owning controller', () => {
    const names = Object.keys(TOOL_ROUTES) as (keyof typeof TOOL_ROUTES)[];
    expect(names.sort()).toEqual([
      'get_project',
      'get_work_item',
      'get_work_item_by_key',
      'iteration_options',
      'iteration_status',
      'list_backlog',
      'list_comments',
      'list_iterations',
      'list_project_members',
      'list_projects',
      'my_work',
      'search_work_items',
      'whoami',
      'work_item_activity',
    ]);
    expect(names.length).toBe(14);
    for (const name of names) {
      const src = readFileSync(join(CONTROLLERS, OWNER[name].file), 'utf8');
      expect(src.includes(OWNER[name].controller), `${name}: controller prefix moved`).toBe(true);
      expect(src.includes(OWNER[name].get), `${name}: route decorator moved`).toBe(true);
      expect(TOOL_ROUTES[name].method).toBe('GET');
      // gate g: the route must sit behind PolicyGuard — either an explicit permission code or
      // an explicit self-scope/reference marker in the entry's comment (whoami: @SelfScoped;
      // list_projects/list_backlog: AccessService-scoped in-service lists; my_work: SelfScoped).
      if (OWNER[name].permission) {
        expect(src.includes(OWNER[name].permission), `${name}: permission code moved`).toBe(true);
      }
    }
  });
});
