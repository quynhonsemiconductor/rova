/**
 * Cross-project READS are scoped to what the caller may see.
 *
 * `GET /v1/projects` carried no `@RequirePermission`, and its query filtered on `workspace_id` +
 * `deleted_at IS NULL` and nothing else — so every project's key, name, description, owner, dates and
 * counts was readable by any authenticated principal, including one with zero role assignments.
 * PRJ-FR-001 requires "List chỉ project user được phép truy cập trong workspace hiện tại", and §10 is
 * explicit that workspace membership alone does not confer project visibility.
 *
 * `GET /v1/projects/:id/members` was open for the same reason — a route with no metadata is OPEN — so
 * the roster of a project the caller cannot see came back too.
 *
 * Driven over real HTTP with the roles that hit these boundaries: a service-level call skips
 * `PolicyGuard`, and the guard is half of what is being asserted.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../apps/api/src/app.module';
import { SEED_PROJECTS } from '../../db/seeds/constants';
import { signIn } from './support/session';

describe('cross-project read scoping (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  async function tokenFor(email: string): Promise<string> {
    const accessToken = await signIn(app, email);
    expect(accessToken, `test-login for ${email}`).toBeTruthy();
    return accessToken;
  }

  function get(url: string, token: string) {
    return app.inject({ method: 'GET', url, headers: { cookie: token } });
  }

  it('shows a Workspace Admin every project — `null` means UNRESTRICTED', async () => {
    // The sentinel half of `listReadableProjectIds`: a workspace-wide grant must not be narrowed. This
    // is the assertion that fails if someone "simplifies" null to an empty array.
    const admin = await tokenFor('admin@qnsc.dev');
    const response = await get('/projects?limit=100', admin);
    expect(response.statusCode).toBe(200);

    const keys = (JSON.parse(response.body).data as Array<{ key: string }>).map((p) => p.key);
    for (const seeded of SEED_PROJECTS) {
      expect(keys, `admin must see ${seeded.key}`).toContain(seeded.key);
    }
  });

  it('shows a member only what they can read, and never the whole workspace', async () => {
    /**
     * `dev@qnsc.dev` holds `project_member` at WORKSPACE scope, which grants `project:view` across the
     * workspace — so the honest expectation here is not "fewer projects" but "the same authorization
     * fact, applied". What must hold is that the list is derived from
     * `listReadableProjectIds` rather than from `workspace_id` alone, and that it is a subset of what
     * the admin sees.
     */
    const admin = await tokenFor('admin@qnsc.dev');
    const member = await tokenFor('dev@qnsc.dev');

    const adminKeys = new Set(
      (
        JSON.parse((await get('/projects?limit=100', admin)).body).data as Array<{ key: string }>
      ).map((p) => p.key),
    );
    const memberResponse = await get('/projects?limit=100', member);
    expect(memberResponse.statusCode).toBe(200);
    const memberProjects = JSON.parse(memberResponse.body).data as Array<{
      id: string;
      key: string;
    }>;

    expect(memberProjects.length).toBeGreaterThan(0);
    for (const project of memberProjects) {
      if (adminKeys.has(project.key)) continue;
      /**
       * `?limit=100` is ONE page, and this suite leaves hundreds of projects behind (see the
       * `createProject` cap in `test/e2e-fixtures.ratchet.spec.ts`) — so once the workspace passes 100
       * projects, a key missing from the admin's first page is evidence of PAGINATION, not of an
       * authorization asymmetry. Comparing two truncated pages made this spec fail on a full-suite run
       * while passing on a freshly seeded database, which reads exactly like a scoping regression.
       *
       * Ask the authorization question directly instead: `GET /projects/:id` is `project:view` scoped
       * to the path id, so a 200 IS "the admin can read this project" with no page in the way.
       */
      const direct = await get(`/projects/${project.id}`, admin);
      expect(direct.statusCode, `${project.key} must be visible to the admin too`).toBe(200);
    }
  });

  it("refuses a project's roster to a caller with no access to that project", async () => {
    // `project:view` scoped to the path id. An unknown project is a 404 from the scope resolver rather
    // than a 403, which is the resolver's documented behaviour — either way it is not the roster.
    const member = await tokenFor('dev@qnsc.dev');
    const response = await get(`/projects/${randomUUID()}/members`, member);
    expect([403, 404]).toContain(response.statusCode);
  });

  it("serves a project's roster to a Workspace Admin, and REFUSES it to an Editor", async () => {
    /**
     * SRS §3.1 gives "View Project `Users & Permissions`" to WA (Edit) and Admin (Read-only) and
     * marks it Hidden for an Editor — so the roster is one of the few project reads where holding
     * `project:view` is not enough. The route carries only `project:view`, which every level holds,
     * so `ProjectsService.listProjectMembers` checks the access LEVEL itself.
     *
     * This test previously asserted 200 for `dev@qnsc.dev` on the grounds that "all three tiers
     * hold project:view". That was true of the code and false of the contract, and it only passed
     * because the seed granted dev a workspace-scoped tier role, which made
     * `getProjectAccessLevel` resolve to something other than `editor`. With that over-grant gone
     * (migration 0112) the refusal is reachable, so both directions are asserted here.
     */
    const admin = await tokenFor('admin@qnsc.dev');
    const allowed = await get(`/projects/${SEED_PROJECTS[0].id}/members`, admin);
    expect(allowed.statusCode, allowed.body).toBe(200);

    const editor = await tokenFor('dev@qnsc.dev');
    const refused = await get(`/projects/${SEED_PROJECTS[0].id}/members`, editor);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(JSON.parse(refused.body).error.code).toBe('PROJECT_PERMISSION_DENIED');
  });

  it('still requires authentication for the project list', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/projects' });
    expect(anonymous.statusCode).toBe(401);
  });
});
