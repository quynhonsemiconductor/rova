/**
 * A DEEP LINK must be authorized, not merely resolvable — over real HTTP.
 *
 * `mini_rally_project_overview.md` :5 (product-docs `origin/main`): a user with no `project_members`
 * row has "the Project hidden and **direct URLs denied**". That is the security half of the
 * deep-linking requirement the BA lists as failing (`mini_rally_ui_business_review.md` :218, :256),
 * and it is the half a client-side fix cannot provide: the SPA change that goes with this spec makes
 * a link open the record in its OWN project context, which is precisely the change that would be
 * dangerous if the API were not already refusing the records the caller may not read.
 *
 * The two routes here are the ONLY resolvers behind the two entity deep links:
 *
 *   `/item/$itemKey`        → `GET /work-items/by-key`   (no `@RequirePermission`, by design)
 *   `/releases/$releaseId`  → `GET /releases/:id`        (`resource: 'release'` scope resolution)
 *
 * They reach the same answer by two different mechanisms, which is why both are asserted. `by-key`
 * carries no decorator because item keys are workspace-unique, so the owning project is unknown until
 * the row loads — the service resolves the row and THEN calls
 * `assertProjectPermission(work_item:view)`. A decorator here would have to guess the project from
 * the URL, the trap CLAUDE.md names ("a gate chosen for where the id lives rather than for what the
 * action is"). `GET /releases/:id` can express it, because `ProjectScopeResolver` loads the release
 * row for the guard.
 *
 * Three cases per route, because they are three different answers and the SPA branches on them:
 * granted → 200, no access → 403, absent record → 404.
 *
 * Every record used belongs to PAY, the seed's SECOND project. A spec that deep-linked into the
 * principal's own project would pass whether or not the boundary exists.
 *
 * A spec that called the SERVICE could not see any of this — the guard chain would not run. Same
 * blind spot that hid the `report:view` bug and the `by-key` `workspace:view` bug.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ACCESS_LEVEL_PERMISSIONS } from '@shared-kernel';
import { AppModule } from '../../apps/api/src/app.module';
import { SEEDED, grantProjectAccess } from './support/flow-harness';
import { provisionUser, signIn } from './support/session';

/**
 * `US-2` is the PAY project's seeded story key, and PAY's release id comes from the same fixture.
 * Hard-coding either would drift the moment the seed moves.
 */
const PAY_ITEM_KEY = 'US-2';
const PAY_RELEASE = SEEDED.pay.releaseId;

// No `/v1` prefix: `Test.createTestingModule` builds the app WITHOUT the bootstrap that sets the
// global prefix, so routes are mounted bare here. Getting that wrong reads as a 404 — which is
// exactly what a refused request must never be confused for, hence the explicit 403/404 assertions
// below rather than "not 200".

describe('deep-link authorization (e2e)', () => {
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

  function get(url: string, accessToken: string) {
    return app.inject({ method: 'GET', url, headers: { cookie: accessToken } });
  }

  /**
   * A FRESH principal per case, provisioned through SSO and granted nothing.
   *
   * Not a seeded fixture user: `grantProjectAccess` writes a real `work.project_members` row that
   * survives until the next reset, so granting a shared user a level changes what every later spec
   * sees — that is how `read-scoping.e2e.spec.ts` broke once. And `ensureDefaultRole` is a no-op
   * since migration 0111, so a JIT-provisioned user genuinely holds nothing: this IS the implicit
   * No Access principal the overview describes, rather than one arranged to look like it.
   */
  async function newPrincipal(): Promise<{ token: string; userId: string }> {
    const session = await provisionUser(app, 'deep-link', 'E2E Deep Link Reader');
    const userId = session.userId;
    return { token: session.accessToken, userId };
  }

  describe('/item/$itemKey → GET /work-items/by-key', () => {
    it('REFUSES a work item in a project the caller has no access to', async () => {
      const { token } = await newPrincipal();

      const response = await get(`/work-items/by-key?itemKey=${PAY_ITEM_KEY}`, token);

      // 403, not 404: the caller is authenticated and the row exists — it is the PERMISSION that is
      // missing, and the SPA's HTTP client turns exactly this into the `/403` Access Denied page.
      // A 404 here would also be defensible as non-disclosure, but it is not what this route does,
      // and the client branches on the difference (404 renders "no such item", 403 denies).
      expect(response.statusCode, response.body).toBe(403);
    });

    it('ALLOWS it once the caller is granted access to that project', async () => {
      const { token, userId } = await newPrincipal();
      // `work_item:view` really is in both levels, so the 403 above can only be the missing GRANT and
      // the 200 below can only be the grant arriving.
      expect(ACCESS_LEVEL_PERMISSIONS.editor).toContain('work_item:view');
      expect(ACCESS_LEVEL_PERMISSIONS.admin).toContain('work_item:view');

      // `admin` and not `editor`, since the 2026-08-17 ruling (`GAP-P4-RBAC-003` AC1): an Editor holds
      // no delivery scope until they are on a Team, so an editor grant alone no longer opens a record
      // — which is the next test, not a regression of this one. A per-project Admin has All Teams
      // (§3.1), so this case still isolates the GRANT as the only thing that changed.
      await grantProjectAccess(app, userId, SEEDED.pay.projectId, 'admin');
      const response = await get(`/work-items/by-key?itemKey=${PAY_ITEM_KEY}`, token);

      expect(response.statusCode, response.body).toBe(200);
      // The record carries its OWN project, which is what lets the client render it in that project
      // rather than in whichever one the recipient had selected. Without this field on the response
      // the SPA fix would have nothing to resolve against.
      expect(JSON.parse(response.body)['projectId']).toBe(SEEDED.pay.projectId);
    });

    /**
     * `GAP-P4-RBAC-003` AC1 through the deep-link route, which is where the BA found it: §2.2 requires
     * an Editor to hold at least one active Team, and "if pre-existing data violates that, the runtime
     * must treat the user as having no delivery scope". `grantProjectAccess` is the raw grant writer
     * used by fixtures, so it can still produce that shape — exactly like the legacy rows this rule
     * exists for. The Users & Permissions journey refuses it up front
     * (`PROJECT_EDITOR_REQUIRES_TEAM`, `project-access-team-rule.e2e.spec.ts`).
     */
    it('still REFUSES an Editor who is on no Team, grant or no grant (AC1)', async () => {
      const { token, userId } = await newPrincipal();

      await grantProjectAccess(app, userId, SEEDED.pay.projectId, 'editor');
      const response = await get(`/work-items/by-key?itemKey=${PAY_ITEM_KEY}`, token);

      expect(response.statusCode, response.body).toBe(403);
      expect(JSON.parse(response.body)['error']['code']).toBe('EDITOR_NO_TEAM_SCOPE');
    });

    it('answers 404 for a key that does not exist, even for an admin', async () => {
      // Asserted with the most privileged principal available, so a 404 is genuinely "no such row"
      // and not a permission failure wearing a 404. `admin@qnsc.dev` is the seeded Workspace Admin.
      const accessToken = await signIn(app, 'admin@qnsc.dev');

      const response = await get('/work-items/by-key?itemKey=US-999999', accessToken);

      expect(response.statusCode, response.body).toBe(404);
    });
  });

  describe('/releases/$releaseId → GET /releases/:id', () => {
    it('REFUSES a release in a project the caller has no access to', async () => {
      const { token } = await newPrincipal();

      const response = await get(`/releases/${PAY_RELEASE}`, token);

      expect(response.statusCode, response.body).toBe(403);
    });

    it('ALLOWS it once the caller is granted Admin on that project', async () => {
      const { token, userId } = await newPrincipal();
      /**
       * ADMIN, not Editor, and that is a real distinction rather than convenience: §3.2 makes
       * `Plan > Timeboxes` — Iterations, Releases and Milestones alike — an admin surface, so
       * `release:view` is absent from the Editor level. An Editor deep-linked to a Release therefore
       * gets a 403 BY DESIGN. Pinned here so a future "Editors cannot open releases" bug report is
       * answered by this line rather than re-litigated.
       */
      expect(ACCESS_LEVEL_PERMISSIONS.editor).not.toContain('release:view');
      expect(ACCESS_LEVEL_PERMISSIONS.admin).toContain('release:view');

      await grantProjectAccess(app, userId, SEEDED.pay.projectId, 'admin');
      const response = await get(`/releases/${PAY_RELEASE}`, token);

      expect(response.statusCode, response.body).toBe(200);
      expect(JSON.parse(response.body)['projectId']).toBe(SEEDED.pay.projectId);
    });

    it('refuses an Editor, because release:view is an admin code', async () => {
      const { token, userId } = await newPrincipal();

      await grantProjectAccess(app, userId, SEEDED.pay.projectId, 'editor');
      const response = await get(`/releases/${PAY_RELEASE}`, token);

      // The declared divergence above, asserted from the other side: a grant that is real but does
      // not carry the code is still a refusal, so the 200 in the previous case is the CODE and not
      // merely membership.
      expect(response.statusCode, response.body).toBe(403);
    });

    it('answers 404 for a release id that does not exist, even for an admin', async () => {
      const accessToken = await signIn(app, 'admin@qnsc.dev');

      const response = await get(`/releases/${randomUUID()}`, accessToken);

      // `ProjectScopeResolver` cannot find a project for a row that is not there, and it throws
      // `RELEASE_NOT_FOUND` rather than denying — so an absent record and a denied one stay
      // distinguishable, which the SPA relies on to show "not found" instead of Access Denied.
      expect(response.statusCode, response.body).toBe(404);
    });

    it('does not make either resolver anonymous', async () => {
      // The client-side change made deep links reachable from anywhere; this pins the thing that
      // would make that a mistake. `by-key` in particular carries NO `@RequirePermission`, and
      // `PolicyGuard` returns true when it finds no metadata — so authentication is the only thing
      // standing between that route and the whole workspace's work items.
      for (const url of [
        `/work-items/by-key?itemKey=${PAY_ITEM_KEY}`,
        `/releases/${PAY_RELEASE}`,
      ]) {
        const response = await app.inject({ method: 'GET', url });
        expect(response.statusCode, url).toBe(401);
      }
    });
  });
});
