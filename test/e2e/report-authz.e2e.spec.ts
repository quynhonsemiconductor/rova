/**
 * The five report routes, over REAL HTTP, proving `report:view` actually denies.
 *
 * The gap this closes: every existing reporting assertion calls `ReportingService` directly as a
 * workspace admin. The decorators on `reporting.controller.ts` were therefore proven only to EXIST —
 * `test/route-policy.ratchet.spec.ts` counts undecorated handlers by reading source text, which cannot
 * tell a correct `@RequirePermission` from a misspelled one, a wrong code, or a project-tier code
 * whose scope resolves from the wrong field.
 *
 * That mattered: `report:view` reached the catalogue in Phase 6 but never reached an existing
 * workspace's tier roles (`db/seeds/bootstrap.ts` upserts them with `set: { name }`), so every report
 * answered 403 to everyone except Workspace Admin — whose `workspace:*` grant is the global anchor and
 * hid it in every test. Migration 0092 fixed the data; this proves the boundary itself, in both
 * directions, on the only surface a browser can reach.
 *
 * Boots the REAL `AppModule` and drives `app.inject()`, so the guard chain, the cached permission
 * resolution and the route all run as in production. The one stub is the Microsoft signature check,
 * which cannot be satisfied locally.
 */
import 'reflect-metadata';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ACCESS_LEVEL_PERMISSIONS } from '@shared-kernel';
import { AppModule } from '../../apps/api/src/app.module';
import {
  NXP_ITER_CURRENT_ID,
  NXP_RELEASE_1_ID,
  PAY_PROJECT_ID,
  SEED_PROJECTS,
} from '../../db/seeds/constants';
import { grantProjectAccess } from './support/flow-harness';
import { provisionUser, signIn } from './support/session';

const NXP = SEED_PROJECTS[0].id;
const ITERATION = NXP_ITER_CURRENT_ID;
const RELEASE = NXP_RELEASE_1_ID;

/**
 * Every reporting route, each with a FULLY VALID query.
 *
 * All five are listed deliberately rather than one as a sample: they carry the decorator
 * independently, and a route added without one is OPEN (`PolicyGuard` returns true when it finds no
 * metadata).
 *
 * The queries are complete because the VALIDATION PIPE runs before the guard — an incomplete query
 * returns 400 and the request never reaches authorization at all, so it would prove nothing. Found by
 * asserting 403 and getting 400. Both ids come from the seeded fixture, so a valid request is also a
 * request that can genuinely succeed once the grant exists.
 */
const ROUTES = [
  `/reports/iteration-burndown?projectId=${NXP}&iterationId=${ITERATION}`,
  `/reports/velocity?projectId=${NXP}&window=5`,
  `/reports/team-capacity?projectId=${NXP}&iterationId=${ITERATION}`,
  `/reports/release-tracking?projectId=${NXP}&releaseId=${RELEASE}`,
  `/reports/release-tracking/burnup?projectId=${NXP}&releaseId=${RELEASE}`,
] as const;

// No `/v1` prefix: `Test.createTestingModule` builds the app WITHOUT the bootstrap that sets the
// global prefix, so the routes are mounted bare here. `authz-revocation.e2e.spec.ts` probes
// `/audit-logs` for the same reason. Getting this wrong reads as a 404 — which is exactly what a
// missing route and a refused one must never be confused for, and is why the assertions below
// distinguish 403 from everything else rather than asserting "not 200".

describe('report routes: authorization over HTTP (e2e)', () => {
  let app: NestFastifyApplication;

  /**
   * Sign in as a SEEDED user and return a bearer token.
   *
   * `AuthService.devLogin` rather than the BFF route: the BFF sets a `__Host-` cookie via
   * `reply.setCookie`, and `Test.createTestingModule` builds the app without the bootstrap that
   * registers the cookie plugin — so that path 500s here with `reply.setCookie is not a function`.
   * The service returns the same tokens the controller would wrap, and it is hard-blocked when
   * `nodeEnv` is production, so it cannot become a backdoor.
   *
   * A seeded user rather than an SSO login, because `ssoLogin` JIT-provisions the default role — which
   * carries the very permission under test and would make the negative case impossible to express.
   */
  async function tokenFor(email: string): Promise<string> {
    const result = { accessToken: await signIn(app, email) };
    expect(result.accessToken, `test-login for ${email}`).toBeTruthy();
    return result.accessToken;
  }

  function get(url: string, accessToken: string) {
    return app.inject({ method: 'GET', url, headers: { cookie: accessToken } });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('REFUSES every report route to a principal without report:view', async () => {
    /**
     * The boundary as it actually exists.
     *
     * A JIT-provisioned SSO user USED to be the wrong negative case, because `assignDefaultRole`
     * granted `project_member` at workspace scope and that role carried `report:view` — so a fresh
     * login returned 200. `ensureDefaultRole` is now a no-op and migration 0111 deleted those rows,
     * so a JIT user would work here too; the seeded `viewer@qnsc.dev` is kept because it is
     * DELIBERATELY narrow rather than accidentally empty — two custom roles carrying `project:view`
     * and `work_item:view` between them and nothing else, so a 403 below is the missing
     * `report:view` and not a principal with no grants at all.
     */
    const session = await tokenFor('viewer@qnsc.dev');

    for (const url of ROUTES) {
      const response = await get(url, session);
      // 403, not 401: the caller is authenticated and identified — it is the PERMISSION that is
      // missing. A 401 would mean the guard order regressed.
      expect(response.statusCode, `${url} must be refused`).toBe(403);
    }
  });

  it('ALLOWS them for a principal granted Admin on that project', async () => {
    /**
     * Under the 3-level model the Editor level no longer carries `report:view` (§5, migration 0109),
     * so the allowed principal is an Admin. Granted with `access_level: 'admin'` rather than
     * `assignRole(..., 'project', NXP)`, which now throws `PROJECT_SCOPE_RETIRED`; the permission
     * set is identical, since `ACCESS_LEVEL_PERMISSIONS.admin` IS `ROLE_PERMISSIONS[PROJECT_ADMIN]`.
     *
     * On a DEDICATED user, not `dev@qnsc.dev`. Granting a shared fixture user a level is a lasting
     * edit: `work.project_members` survives until the next reset, so upgrading dev to Admin here
     * changed what every later spec saw. It broke `read-scoping.e2e.spec.ts`, which asserts that an
     * Editor is refused the project roster — dev had silently stopped being an Editor. A spec that
     * needs a grant should create the principal it grants to.
     */
    const session = await provisionUser(app, 'report-reader', 'E2E Report Reader');
    const userId = session.userId;

    await grantProjectAccess(app, userId, NXP, 'admin');

    for (const url of ROUTES) {
      const response = await get(url, session.accessToken);
      expect(response.statusCode, `${url} must be allowed`).toBe(200);
    }
  });

  it('refuses a project-scoped grant pointed at a DIFFERENT project', async () => {
    /**
     * `report:view` is project-tier, so the SCOPE has to be checked and not just the code. This
     * grants the viewer a role carrying `report:view` on a project that is not NXP; if the tier were
     * decorative, that would open NXP's reports too.
     */
    // The level really does carry the code, so a 403 below can only be the SCOPE refusing.
    expect(ACCESS_LEVEL_PERMISSIONS.admin).toContain('report:view');

    /**
     * PAY, the seed's second project, rather than a random uuid: `access_level` is a real
     * `project_members` row and the write path validates the project exists. `SEEDED.pay` exists
     * precisely so a test needing "somewhere else" has one.
     *
     * Also a dedicated principal, for the reason above — and here it matters twice over, because
     * `viewer@qnsc.dev` is the negative case in the first test of this file. Granting it Admin
     * anywhere would eventually make that test meaningless.
     */
    const login = await provisionUser(app, 'cross-project', 'E2E Cross-project Reader');
    const userId = login.userId;
    await grantProjectAccess(app, userId, PAY_PROJECT_ID, 'admin');

    const session = login.accessToken;
    for (const url of ROUTES) {
      expect((await get(url, session)).statusCode, `${url} cross-project`).toBe(403);
    }
  });
});
