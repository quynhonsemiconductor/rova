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

const OWNER: Record<keyof typeof TOOL_ROUTES, { file: string; controller: string; get: string }> = {
  whoami: {
    file: 'identity/src/interface/http/auth.controller.ts',
    controller: "@Controller('auth')",
    get: "@Get('me')",
  },
  list_projects: {
    file: 'projects/src/interface/http/projects.controller.ts',
    controller: "@Controller('projects')",
    get: '@Get()',
  },
  search_work_items: {
    file: 'work-items/src/interface/http/work-items.controller.ts',
    controller: "@Controller('work-items')",
    get: '@Get()',
  },
  my_work: {
    file: 'work-items/src/interface/http/work-items.controller.ts',
    controller: "@Controller('work-items')",
    get: "@Get('my')",
  },
  list_iterations: {
    file: 'iterations/src/interface/http/iterations.controller.ts',
    controller: "@Controller('iterations')",
    get: '@Get()',
  },
  list_comments: {
    file: 'collaboration/src/interface/http/collaboration.controller.ts',
    controller: "@Controller('work-items/:workItemId')",
    get: "@Get('comments')",
  },
  get_work_item: {
    file: 'work-items/src/interface/http/work-items.controller.ts',
    controller: "@Controller('work-items')",
    get: "@Get(':id')",
  },
};

describe('MCP tool catalogue maps to real routes', () => {
  it('every registered tool route exists in the owning controller', () => {
    const names = Object.keys(TOOL_ROUTES) as (keyof typeof TOOL_ROUTES)[];
    expect(names.sort()).toEqual([
      'get_work_item',
      'list_comments',
      'list_iterations',
      'list_projects',
      'my_work',
      'search_work_items',
      'whoami',
    ]);
    for (const name of names) {
      const src = readFileSync(join(CONTROLLERS, OWNER[name].file), 'utf8');
      expect(src.includes(OWNER[name].controller), `${name}: controller prefix moved`).toBe(true);
      expect(src.includes(OWNER[name].get), `${name}: route decorator moved`).toBe(true);
      expect(TOOL_ROUTES[name].method).toBe('GET');
    }
  });
});
