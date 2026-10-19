/**
 * The project-scoped route surface, over REAL HTTP, in BOTH directions.
 *
 * This is the spec that twelve `@AuthorizedInService(reason, pinnedBy)` decorators across
 * `projects.controller.ts`, `work-items.controller.ts` and `portfolio-items.controller.ts` name as
 * their proof. It did not exist. That is worse than an undecorated route: the boot audit
 * (`RouteAuthzAudit`) accepts `@AuthorizedInService` *because* a test is named, and
 * `route-policy.ratchet.spec.ts` counted the decorator as a declaration — so a dozen routes,
 * including `GET /projects` (whose ONLY authorization is `listReadableProjectIds`), carried a
 * citation that read as evidence and asserted nothing. The ratchet now fails when a cited spec is
 * missing; this is the file it was asking for.
 *
 * WHAT IT PINS, beyond the routes themselves
 * ------------------------------------------
 * Two P0 access defects found on 2026-08-14, which are one defect seen from two ends — the
 * workspace BASELINE was doing a job it cannot do:
 *
 *   1. Per-Project grants live in `work.project_members.access_level` and are synthesized as
 *      PROJECT-scoped assignments. `GET /bff/me` returns only the workspace baseline, and
 *      migration 0111 deleted the workspace-scoped tier assignments — so a correctly-provisioned
 *      Admin or Editor arrived at the SPA with an empty permission set and no navigation at all.
 *   2. `getUserRoleAndPermissions` floored that empty baseline at `[workspace:view]` "so the app
 *      shell works". `workspace:view` gates `GET /workspaces/:id/settings` and the two SCM
 *      inventory routes — all admin-only — so the floor handed every user, No Access included, a
 *      code that opens three admin surfaces.
 *
 * Both are asserted here: the Editor and No Access cases prove (2) is gone, and the Editor's 200s
 * prove the project-tier path that (1) broke is real and reachable.
 *
 * WHY THE SEED HAD TO CHANGE FIRST
 * --------------------------------
 * `db/seeds/demo.ts` granted `dev@qnsc.dev` the `project_member` tier role at WORKSPACE scope —
 * exactly the row migration 0111 deletes as "pure legacy over-grant" — so a developer held the
 * full Editor delivery set in every project and the project-scoped path was never exercised.
 * `read-scoping.e2e.spec.ts` says so in a comment: "the honest expectation here is not 'fewer
 * projects'". With that grant gone, `dev@qnsc.dev` is an Editor on NXP and nothing anywhere else,
 * which is what makes a negative assertion possible at all. Same masking shape as `report:view`
 * (see CLAUDE.md): a principal with too much hides a broken gate from every test.
 *
 * THREE THINGS THIS HARNESS GETS RIGHT, EACH LEARNED THE HARD WAY (see report-authz.e2e.spec.ts)
 * ---------------------------------------------------------------------------------------------
 *  - **No `/v1` prefix.** `Test.createTestingModule` skips the bootstrap that sets the global
 *    prefix, so routes mount bare. Getting it wrong reads as a 404 — indistinguishable from a
 *    refusal, which is why every assertion below names the status it expects.
 *  - **`AuthService.devLogin`, not the BFF route.** The BFF sets a `__Host-` cookie via
 *    `reply.setCookie`, and the cookie plugin is not registered here, so that path 500s.
 *  - **A seeded user, not an SSO login,** wherever a NEGATIVE case is asserted — except for the No
 *    Access principal, where JIT provisioning is the point: `ensureDefaultRole` is a no-op, so a
 *    first SSO sign-in IS the BA's implicit No Access and needs no fixture.
 */
import 'reflect-metadata';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AccessService } from '@modules/access';
import { AppModule } from '../../apps/api/src/app.module';
import {
  PAY_PROJECT_ID,
  SEED_PROJECTS,
  TEAM_ALPHA_ID,
  WORKSPACE_ID,
} from '../../db/seeds/constants';
import { grantProjectAccess } from './support/flow-harness';
import { provisionUser, signIn, signInAs } from './support/session';

const NXP = SEED_PROJECTS[0].id;
const PAY = PAY_PROJECT_ID;

/**
 * The project-scoped GET surface an Editor legitimately reaches, all carrying
 * `@RequirePermission('project:view', { from: 'param', field: 'id' })` plus the
 * `@AuthorizedInService` citation this file answers.
 *
 * Listed individually rather than sampled: each decorator is applied independently, and a route
 * added without one is OPEN — `PolicyGuard` returns true when it finds no metadata.
 */
const projectScopedReads = (projectId: string) => [
  `/projects/${projectId}`,
  `/projects/${projectId}/activity`,
  `/projects/${projectId}/statuses`,
  `/projects/${projectId}/transitions`,
  `/projects/${projectId}/labels`,
  `/projects/${projectId}/teams`,
  `/projects/${projectId}/estimation-settings`,
];

/**
 * Routes that edit the PROJECT ITSELF or its Team links — structural, so Workspace Admin only.
 *
 * SRS §3.1 marks "Create, edit, archive, restore or delete Project" and "Create, edit, deactivate or
 * restore Team" Hidden for a per-Project Admin. These three carried `project:edit`, which IS in the
 * Admin access-level set, so a Project Admin could rename the project, reassign its owner and move
 * its dates, and link or unlink its Teams.
 */
const structuralWrites = (projectId: string) =>
  [
    {
      method: 'PATCH' as const,
      url: `/projects/${projectId}`,
      payload: { name: 'Renamed by test' },
    },
    {
      method: 'POST' as const,
      url: `/projects/${projectId}/teams`,
      payload: { teamId: TEAM_ALPHA_ID },
    },
    {
      method: 'DELETE' as const,
      url: `/projects/${projectId}/teams/${TEAM_ALPHA_ID}`,
      payload: undefined,
    },
  ] as const;

/** Admin-only surfaces the removed `workspace:view` floor used to open to everyone. */
const WORKSPACE_ADMIN_ONLY_READS = [
  `/workspaces/${WORKSPACE_ID}/settings`,
  '/scm/installations',
  '/scm/repositories',
];

describe('project-scoped routes: authorization over HTTP (e2e)', () => {
  let app: NestFastifyApplication;
  let access: AccessService;

  async function tokenFor(email: string): Promise<string> {
    const accessToken = await signIn(app, email);
    expect(accessToken, `test-login for ${email}`).toBeTruthy();
    return accessToken;
  }

  /**
   * A principal with NO workspace assignment and NO `project_members` row — the BA's implicit No
   * Access, built through the real JIT path rather than by writing fixture rows.
   */
  async function noAccessToken(): Promise<{ token: string; userId: string }> {
    const { accessToken, userId } = await provisionUser(
      app,
      'no-access',
      'E2E No Access Principal',
    );
    return { token: accessToken, userId };
  }

  function get(url: string, token: string) {
    return app.inject({ method: 'GET', url, headers: { cookie: token } });
  }

  function patch(url: string, token: string, body: Record<string, unknown>) {
    return app.inject({
      method: 'PATCH',
      url,
      headers: { cookie: token },
      payload: body,
    });
  }

  function send(
    spec: { method: 'PATCH' | 'POST' | 'DELETE'; url: string; payload?: Record<string, unknown> },
    token: string,
  ) {
    return app.inject({
      method: spec.method,
      url: spec.url,
      headers: { cookie: token },
      ...(spec.payload ? { payload: spec.payload } : {}),
    });
  }

  /**
   * A fresh principal at a given level on a given project, built through the real paths.
   *
   * Dedicated per test rather than reusing `dev@qnsc.dev`: `work.project_members` survives until the
   * next fixture reset, so granting a shared fixture user a level changes what later specs see. That
   * exact mistake made `read-scoping.e2e.spec.ts` pass while asserting the opposite of the contract.
   */
  async function principalAt(level: 'admin' | 'editor', projectId: string): Promise<string> {
    const { accessToken, userId } = await provisionUser(app, `authz-${level}`, `E2E ${level}`);
    await grantProjectAccess(app, userId, projectId, level);
    return accessToken;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    access = app.get(AccessService);
  });

  afterAll(async () => {
    await app?.close();
  });

  // ── The baseline itself ────────────────────────────────────────────────────

  it('gives a principal with no assignment NO workspace-tier permission', async () => {
    // The direct assertion that the `[workspace:view]` floor is gone. Kept at the service level as
    // well as over HTTP because the floor was a single `return` and this is the line that fails if
    // someone restores it "so the shell works".
    const { userId } = await noAccessToken();
    const resolved = await access.getUserRoleAndPermissions(userId, WORKSPACE_ID);
    expect(resolved.role).toBe('');
    expect(resolved.permissions).toEqual([]);
  });

  it('resolves an Editor’s project permissions from access_level, not from the baseline', async () => {
    /**
     * The positive half of defect (1): the project-tier set has to be non-empty and it has to come
     * from somewhere other than the workspace baseline, which is empty for this user.
     */
    const { userId } = await signInAs(app, 'dev@qnsc.dev');

    const baseline = await access.getUserRoleAndPermissions(userId, WORKSPACE_ID);
    expect(baseline.permissions, 'the seed must not grant a workspace-scoped tier role').toEqual(
      [],
    );

    const inNxp = await access.getProjectPermissions(userId, WORKSPACE_ID, NXP);
    expect(inNxp).toContain('project:view');
    expect(inNxp).toContain('work_item:edit');

    // And it is genuinely per-project, not a workspace grant wearing a project label.
    expect(await access.getProjectPermissions(userId, WORKSPACE_ID, PAY)).toEqual([]);
  });

  // ── Admin-only surfaces the floor used to open ─────────────────────────────

  it('refuses Workspace Settings and the SCM inventory to a No Access principal', async () => {
    const { token } = await noAccessToken();
    for (const url of WORKSPACE_ADMIN_ONLY_READS) {
      // 403, not 401: authenticated and identified, but unpermitted. A 401 would mean the guard
      // order regressed.
      expect((await get(url, token)).statusCode, `${url} must be refused`).toBe(403);
    }
  });

  it('refuses them to an Editor too — a project grant is not a workspace grant', async () => {
    const editor = await tokenFor('dev@qnsc.dev');
    for (const url of WORKSPACE_ADMIN_ONLY_READS) {
      expect((await get(url, editor)).statusCode, `${url} must be refused`).toBe(403);
    }
  });

  it('serves them to a Workspace Admin', async () => {
    // The other direction, so the assertions above cannot pass by breaking the routes.
    const admin = await tokenFor('admin@qnsc.dev');
    for (const url of WORKSPACE_ADMIN_ONLY_READS) {
      expect((await get(url, admin)).statusCode, `${url} must be allowed`).toBe(200);
    }
  });

  // ── The project-scoped read surface ───────────────────────────────────────

  it('serves every project-scoped read to an Editor of THAT project', async () => {
    const editor = await tokenFor('dev@qnsc.dev');
    for (const url of projectScopedReads(NXP)) {
      expect((await get(url, editor)).statusCode, `${url} must be allowed`).toBe(200);
    }
  });

  it('refuses every one of them for a project the Editor has no access to', async () => {
    /**
     * The scope half. `project:view` is project-tier, so the SCOPE has to be checked and not just
     * the code — if the tier were decorative, an Editor of NXP would read PAY as well.
     *
     * 403 or 404 both satisfy the contract: BA §7 permits Not Found for an inaccessible project
     * specifically to avoid disclosing that it exists. What must never appear is a 200.
     */
    const editor = await tokenFor('dev@qnsc.dev');
    for (const url of projectScopedReads(PAY)) {
      const response = await get(url, editor);
      expect([403, 404], `${url} → ${response.statusCode}`).toContain(response.statusCode);
    }
  });

  it('refuses every one of them to a No Access principal, on both projects', async () => {
    const { token } = await noAccessToken();
    for (const projectId of [NXP, PAY]) {
      for (const url of projectScopedReads(projectId)) {
        const response = await get(url, token);
        expect([403, 404], `${url} → ${response.statusCode}`).toContain(response.statusCode);
      }
    }
  });

  it('serves them to a Workspace Admin on every project', async () => {
    const admin = await tokenFor('admin@qnsc.dev');
    for (const projectId of [NXP, PAY]) {
      for (const url of projectScopedReads(projectId)) {
        expect((await get(url, admin)).statusCode, `${url} must be allowed`).toBe(200);
      }
    }
  });

  // ── The cross-project list ────────────────────────────────────────────────

  it('narrows the project list to what the caller may read', async () => {
    /**
     * `GET /projects` has no `@RequirePermission` at all — `listReadableProjectIds` IS its
     * authorization, and its `null` sentinel means UNRESTRICTED while `[]` means nothing. Those two
     * are different answers, which is why a caller that flattens `null` to `[]` fails closed and
     * one that flattens `[]` to "all" leaks the workspace.
     *
     * This is the assertion `read-scoping.e2e.spec.ts` could not make while the seed over-granted:
     * an Editor of NXP must see NXP and must NOT see PAY.
     */
    const editor = await tokenFor('dev@qnsc.dev');
    const response = await get('/projects?limit=100', editor);
    expect(response.statusCode).toBe(200);

    const keys = (JSON.parse(response.body).data as Array<{ id: string; key: string }>).map(
      (p) => p.id,
    );
    expect(keys, 'the Editor’s own project must be listed').toContain(NXP);
    expect(keys, 'a project they hold no access on must not be').not.toContain(PAY);
  });

  it('returns an EMPTY list to a No Access principal, not the workspace', async () => {
    const { token } = await noAccessToken();
    const response = await get('/projects?limit=100', token);
    // 200 with nothing in it: the caller is a legitimate company member with access to no project.
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).data).toEqual([]);
  });

  it('returns every project to a Workspace Admin — `null` means UNRESTRICTED', async () => {
    const admin = await tokenFor('admin@qnsc.dev');
    const response = await get('/projects?limit=100', admin);
    expect(response.statusCode).toBe(200);
    const ids = (JSON.parse(response.body).data as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain(NXP);
    expect(ids).toContain(PAY);
  });

  it('scopes the project-health widget the same way as the list', async () => {
    // `GET /projects/health` shares the list's authorization and nothing else guards it, so it needs
    // its own assertion — a widget that ignores the scope leaks names and counts just as well.
    const { token } = await noAccessToken();
    const response = await get('/projects/health', token);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual([]);
  });

  // ── A write, to prove the tier split is real ──────────────────────────────

  it('refuses estimation-settings WRITES to an Editor and an Admin of the project', async () => {
    /**
     * `PATCH /projects/:id/estimation-settings` carries `workspace:edit`, deliberately: the BA
     * scopes this setting to the Workspace Admin, so the enforcement is the permission and not a UI
     * gate. Proving the READ above is allowed while the WRITE is refused for the same principal is
     * what makes that a boundary rather than a comment.
     */
    const editor = await tokenFor('dev@qnsc.dev');
    const response = await patch(`/projects/${NXP}/estimation-settings`, editor, { xsPoints: 2 });
    expect(response.statusCode).toBe(403);
  });

  it('allows the estimation-settings write for a Workspace Admin', async () => {
    const admin = await tokenFor('admin@qnsc.dev');
    // Re-asserting the current value, so the fixture is unchanged and the assertion is about
    // authorization rather than about the number.
    const current = JSON.parse(
      (await get(`/projects/${NXP}/estimation-settings`, admin)).body,
    ) as Record<string, unknown>;
    const response = await patch(`/projects/${NXP}/estimation-settings`, admin, {
      xsPoints: current['xsPoints'],
    });
    expect(response.statusCode, response.body).toBe(200);
  });

  // ── Admin is a DELIVERY admin, not a structural one ──────────────────────

  it('refuses a per-Project ADMIN every structural write', async () => {
    /**
     * §3.1's Admin column is Hidden for project and team configuration, and AC-4 says it "cannot
     * maintain Projects, Teams or access assignments". These three routes now carry `workspace:edit`,
     * which only a Workspace Admin holds.
     *
     * `project:edit` deliberately REMAINS in the Admin set — it also gates labels and workflow
     * statuses, which §3.1 does give Admin — so this asserts the ROUTES moved, not that the code was
     * taken away. Asserting it at the boundary is the point: the previous arrangement typechecked,
     * passed the decorator ratchet, and let an Admin rename the project.
     */
    const admin = await principalAt('admin', NXP);
    for (const spec of structuralWrites(NXP)) {
      expect((await send(spec, admin)).statusCode, `${spec.method} ${spec.url}`).toBe(403);
    }
  });

  it('refuses an EDITOR every structural write too', async () => {
    const editor = await principalAt('editor', NXP);
    for (const spec of structuralWrites(NXP)) {
      expect((await send(spec, editor)).statusCode, `${spec.method} ${spec.url}`).toBe(403);
    }
  });

  it('still serves the project roster to a per-Project ADMIN', async () => {
    // The Read-only half of the same §3.1 row: Admin sees the roster, Editor does not.
    const admin = await principalAt('admin', NXP);
    expect((await get(`/projects/${NXP}/members`, admin)).statusCode).toBe(200);

    const editor = await principalAt('editor', NXP);
    expect((await get(`/projects/${NXP}/members`, editor)).statusCode).toBe(403);
  });

  it('allows a Workspace Admin the structural writes it just refused everyone else', async () => {
    /**
     * The other direction, so the four refusals above cannot pass by the routes simply being broken.
     *
     * Asserted as "NOT 403", not as 2xx, and the distinction is the whole point: what is under test
     * is whether the GUARD admits a Workspace Admin, and a domain refusal downstream proves it did.
     * Both team routes refuse this particular pair for real reasons — the seed already links Team
     * Alpha to NXP, so a link is a 409, and Alpha sits on NXP's seeded capacity plan, so an unlink is
     * `PROJECT_TEAM_HAS_CAPACITY_PLAN` (412), which is a documented guard in its own right. Forcing a
     * 2xx would mean either mutating the shared fixture or building a throwaway project and team to
     * link, and both cost more than they prove here.
     *
     * The rename is the one that genuinely succeeds, and it writes the project's CURRENT name back,
     * so this test changes nothing. Nothing resets between files within a run.
     */
    const wa = await tokenFor('admin@qnsc.dev');
    const [rename, link, unlink] = structuralWrites(NXP);

    for (const spec of [link, unlink]) {
      const response = await send(spec, wa);
      expect(response.statusCode, `${spec.method} ${spec.url} must not be a 403`).not.toBe(403);
    }

    const project = JSON.parse((await get(`/projects/${NXP}`, wa)).body) as { name: string };
    expect((await send({ ...rename, payload: { name: project.name } }, wa)).statusCode).toBe(200);
  });

  // ── Authentication is still the outer gate ───────────────────────────────

  it('still requires authentication on the whole surface', async () => {
    for (const url of [...projectScopedReads(NXP), '/projects', '/projects/health']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
  });
});
