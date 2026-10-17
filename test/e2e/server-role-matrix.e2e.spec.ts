/**
 * THE BA's ACCESS MATRIX, MEASURED OVER HTTP, FOR ALL FOUR PRINCIPALS.
 *
 * `product-docs` `origin/main` (`55e7dbb`),
 * `projects/mini-rally/04_Developement_tracking/Phase 4/02_Roles_Permissions/SRS.md`:
 *   §3.1 (lines 59-71) company + structure administration
 *   §3.2 (lines 77-87) delivery features
 * Both tables have four columns — Workspace Admin, per-project `Admin`, per-project `Editor`,
 * and No Access (§1:31, the ABSENCE of a `work.project_members` row; there is no `Viewer`).
 *
 * WHY THIS FILE EXISTS. Only Workspace Admin has ever really been exercised: it is the local dev
 * principal and the seed's default, and its `workspace:*` grant is the global anchor that fast-paths
 * every check. That masking is how the `report:view` bug survived to migration 0092, how
 * `GET /work-items/by-key` shipped carrying an admin-reserved code, and how `iteration:view` came to
 * gate a surface §3.2 hides. `route-policy.ratchet.spec.ts` reads SOURCE TEXT, so it cannot tell a
 * correct code from a misspelled one or from one the intended role cannot hold; a spec that calls a
 * service directly cannot see a guard defect at all. This drives real HTTP with real session cookies (identity's test-login)
 * and records the STATUS CODE each of the four principals actually gets.
 *
 * READ THIS BEFORE ADDING A PROBE — three properties every one of them must have:
 *
 *   1. BOTH DIRECTIONS. A refusal alone is satisfied by a route nobody can reach, and a grant alone
 *      by a gate that grants everyone. Every row below asserts allow AND deny.
 *   2. THE VALIDATION PIPE RUNS BEFORE THE GUARD. An incomplete query or body is a 400 that never
 *      reaches authorization, so it would make either expectation pass for the wrong reason. Every
 *      payload here is schema-valid.
 *   3. DENIED IS `403`, AND `403` ONLY. Anything else — 404, 409, 422 — means the guard let the
 *      caller THROUGH and the request then failed on its own merits, which is what "allowed" means
 *      for a probe deliberately aimed at an unresolvable dependent id (see below). So the assertion
 *      is always `status === 403`, never `status >= 400`.
 *
 * HOW THE WRITE PROBES AVOID MUTATING THE SHARED FIXTURE. Two shapes, and the choice is per route:
 *
 *   • CREATE-THEN-DELETE, where the same principal holds both codes (work items, iterations,
 *     releases, milestones). The allow direction is a real 201 and the row is removed again, so the
 *     probe is self-cleaning and measures the delete code too.
 *   • VALID SHAPE, UNRESOLVABLE DEPENDENT, where no delete exists (capacity plans, Team Status
 *     capacity, portfolio create, and every structural §3.1 write). The guard for these routes
 *     resolves the project from `projectId` in the body/query — or ignores the path id entirely for a
 *     workspace-tier code — so a real `projectId` plus a bogus dependent id reaches the guard,
 *     passes or fails there, and then dies in the service with 404/409/422 having written nothing.
 *     This is what makes an authorization measurement possible on a destructive route.
 *
 *   NOT usable for a `{ resource, from: 'param' }` route: `ProjectScopeResolver` returns undefined
 *   for a row that does not exist, and `PolicyGuard` then denies with 403 — for a Workspace Admin
 *   too. A bogus id there measures nothing, so those probes use real seeded ids and read-only or
 *   round-trip operations.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../apps/api/src/app.module';
import { SSO_EMAIL_DOMAIN } from './support/sso-env';
import { WORKSPACE_ID } from '../../db/seeds/constants';
import { ADMIN_USER_ID, grantProjectAccess, SEEDED } from './support/flow-harness';
import { provisionUser, signIn } from './support/session';

const NXP = SEEDED.nxp.projectId;
const ITER = SEEDED.nxp.iterationCurrentId;
const TEAM = SEEDED.nxp.teamAlphaId;

/** The four columns of §3.1 / §3.2, in the SRS's own order. */
const ROLES = ['wa', 'admin', 'editor', 'none'] as const;
type Role = (typeof ROLES)[number];

type Verdict = 'allow' | 'deny';
type Expectation = Record<Role, Verdict>;

/** Shorthands for the four shapes §3.1/§3.2 actually use. */
const WA_ONLY: Expectation = { wa: 'allow', admin: 'deny', editor: 'deny', none: 'deny' };
const ADMIN_UP: Expectation = { wa: 'allow', admin: 'allow', editor: 'deny', none: 'deny' };
const EDITOR_UP: Expectation = { wa: 'allow', admin: 'allow', editor: 'allow', none: 'deny' };

/**
 * Every measurement, for the report. `expected` is the BA's cell; `measured` is the status code the
 * server actually returned. Printed in `afterAll` so the audit document is transcribed from the run
 * rather than from a reading of the decorators.
 */
type Row = {
  srs: string;
  surface: string;
  action: string;
  route: string;
  code: string;
  expected: Expectation;
  measured: Partial<Record<Role, number>>;
  mismatches: string[];
};
const MATRIX: Row[] = [];

describe('server role matrix (e2e)', () => {
  let app: NestFastifyApplication;
  const token: Record<Role, string> = { wa: '', admin: '', editor: '', none: '' };
  let adminUserId = '';
  /** A seeded task under NXP's story — the Team Status task-edit probe needs a real one. */
  let taskId = '';
  let taskTitle = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    /**
     * THE FOUR PRINCIPALS.
     *
     *   wa      `admin@qnsc.dev`  — the seeded Workspace Admin (`workspace:*`).
     *   admin   a FRESH SSO user granted `access_level = 'admin'` on NXP. Fresh rather than seeded,
     *           because no seeded principal holds this level and upgrading a shared fixture user is a
     *           lasting edit to `work.project_members` that survives until the next reset — that is
     *           how upgrading `dev@qnsc.dev` once broke `read-scoping.e2e.spec.ts`. A JIT SSO login
     *           lands with ZERO access (`AccessService.ensureDefaultRole` is a deliberate no-op), so
     *           the level granted here is the ONLY thing this principal holds.
     *   editor  `dev@qnsc.dev` — the seeded per-project Editor on NXP, with NO workspace-tier
     *           baseline at all (migration 0111/0112). A baseline would union into
     *           `getProjectPermissions` and make every project look granted.
     *   none    `viewer@qnsc.dev` — no assignment anywhere, which is the BA's implicit No Access.
     *
     * `grantProjectAccess` (not raw SQL) because it invalidates the 5-minute per-(workspace, user)
     * assignment cache; a row written behind the service is invisible until then, and the assertions
     * would be wrong for the wrong reason.
     */
    token.wa = await bearer('admin@qnsc.dev');
    token.editor = await bearer('dev@qnsc.dev');
    token.none = await bearer('viewer@qnsc.dev');

    const login = await provisionUser(app, 'role-matrix-admin', 'E2E Project Admin');
    adminUserId = login.userId;
    await grantProjectAccess(app, adminUserId, NXP, 'admin');
    token.admin = login.accessToken;

    const tasks = await request('wa', 'GET', `/work-items/${SEEDED.nxp.storyId}/tasks`);
    const rows = JSON.parse(tasks.body) as Array<{ id: string; title: string }>;
    expect(rows.length, 'the seed must give NXP-1 at least one task').toBeGreaterThan(0);
    taskId = rows[0].id;
    taskTitle = rows[0].title;
  });

  afterAll(async () => {
    await app?.close();
    // The whole measured table, so the audit document is a transcript.
    const lines = MATRIX.map(
      (r) =>
        `${r.srs.padEnd(9)} ${r.surface.padEnd(26)} ${r.action.padEnd(14)} ${r.route.padEnd(52)} ` +
        `${r.code.padEnd(24)} ` +
        ROLES.map((role) => `${role}=${r.measured[role] ?? '-'}`)
          .join(' ')
          .padEnd(38) +
        (r.mismatches.length ? `  MISMATCH: ${r.mismatches.join('; ')}` : ''),
    );
    // eslint-disable-next-line no-console
    console.log(`\n===== MEASURED ROLE MATRIX =====\n${lines.join('\n')}\n`);
  });

  // ── plumbing ───────────────────────────────────────────────────────────────

  /** The session cookie from identity's test-login; the test app has no CSRF hook. */
  async function bearer(email: string): Promise<string> {
    const accessToken = await signIn(app, email);
    expect(accessToken, `test-login for ${email}`).toBeTruthy();
    return accessToken;
  }

  function request(
    role: Role,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
  ) {
    return app.inject({
      method,
      url,
      headers: { cookie: token[role] },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }

  /**
   * Measure ONE route across all four principals and assert each against the BA's cell.
   *
   * `run` returns the status for a role. It is a callback rather than a fixed request so a probe can
   * be a create-then-delete round trip (which needs the created id) without leaving the table.
   *
   * The assertion is deliberately `=== 403` and not `>= 400`: for the unresolvable-dependent probes,
   * a 404/409/422 IS the allow signal — the guard let the caller through and the service refused the
   * request on its own merits. Collapsing the two would make every probe pass.
   */
  async function probe(
    meta: Omit<Row, 'measured' | 'mismatches'>,
    run: (role: Role) => Promise<number>,
  ): Promise<Row> {
    const row: Row = { ...meta, measured: {}, mismatches: [] };
    MATRIX.push(row);
    for (const role of ROLES) {
      const status = await run(role);
      row.measured[role] = status;
      const verdict: Verdict = status === 403 ? 'deny' : 'allow';
      if (verdict !== meta.expected[role]) {
        row.mismatches.push(`${role} expected ${meta.expected[role]}, measured ${status}`);
      }
    }
    return row;
  }

  /** Assert a probe matched the BA table in BOTH directions, naming the SRS line on failure. */
  function assertMatches(row: Row): void {
    expect(
      row.mismatches,
      `${row.route} (${row.code}) — SRS ${row.srs} "${row.surface}: ${row.action}"`,
    ).toEqual([]);
  }

  const get = (role: Role, url: string) => request(role, 'GET', url).then((r) => r.statusCode);

  /**
   * A create whose row is removed again by the same principal. Returns the CREATE status; the delete
   * is asserted separately so a failed cleanup cannot be mistaken for a permission result.
   */
  async function createThenDelete(
    role: Role,
    createUrl: string,
    payload: unknown,
    deleteUrl: (id: string) => string,
    /**
     * Where the new row's id lives in the response. Defaults to `id`, but
     * `POST /iterations/:id/work-items` answers `{ workItemId, itemKey }` — it is the Iteration
     * Status create, not the work-item create, and its DTO says so.
     */
    idOf: (body: Record<string, string>) => string = (body) => body.id,
  ): Promise<number> {
    const created = await request(role, 'POST', createUrl, payload);
    if (created.statusCode >= 300) return created.statusCode;
    const id = idOf(JSON.parse(created.body) as Record<string, string>);
    const removed = await request(role, 'DELETE', deleteUrl(id));
    expect(
      removed.statusCode,
      `cleanup of ${deleteUrl(id)} by ${role} — a leaked fixture row is a later spec's failure`,
    ).toBeLessThan(300);
    return created.statusCode;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §3.1 — Company and structure administration (SRS lines 59-71)
  // ═══════════════════════════════════════════════════════════════════════════

  it('§3.1:61 — Workspace Settings are Workspace Admin only, read AND write', async () => {
    const read = await probe(
      {
        srs: '§3.1:61',
        surface: 'Workspace Settings',
        action: 'view',
        route: 'GET /workspaces/:id/settings',
        code: 'workspace:view',
        expected: WA_ONLY,
      },
      (role) => get(role, `/workspaces/${WORKSPACE_ID}/settings`),
    );
    assertMatches(read);

    /**
     * A BOGUS workspace id, deliberately. `workspace:edit` is workspace-tier, so `PolicyGuard`
     * checks the caller's baseline and never looks at the path id — the controller's own
     * `assertActive` then 404s. So the guard's decision is measured without writing a settings row
     * anyone else reads.
     */
    const write = await probe(
      {
        srs: '§3.1:61',
        surface: 'Workspace Settings',
        action: 'edit',
        route: 'PATCH /workspaces/:id/settings',
        code: 'workspace:edit',
        expected: WA_ONLY,
      },
      (role) =>
        request(role, 'PATCH', `/workspaces/${randomUUID()}/settings`, {
          timezone: 'UTC',
        }).then((r) => r.statusCode),
    );
    assertMatches(write);
  });

  it('§3.1:62-63 — the company user roster and invitations are Workspace Admin only', async () => {
    assertMatches(
      await probe(
        {
          srs: '§3.1:62',
          surface: 'Company Users',
          action: 'view',
          route: 'GET /workspaces/:id/members-with-profile',
          code: 'workspace:view',
          expected: WA_ONLY,
        },
        (role) => get(role, `/workspaces/${WORKSPACE_ID}/members-with-profile`),
      ),
    );

    assertMatches(
      await probe(
        {
          srs: '§3.1:63',
          surface: 'Invite company user',
          action: 'view',
          route: 'GET /workspaces/:id/invitations',
          code: 'users:invite',
          expected: WA_ONLY,
        },
        (role) => get(role, `/workspaces/${WORKSPACE_ID}/invitations`),
      ),
    );

    assertMatches(
      await probe(
        {
          srs: '§3.1:63',
          surface: 'Invite company user',
          action: 'create',
          route: 'POST /workspaces/:id/invitations',
          code: 'users:invite',
          expected: WA_ONLY,
        },
        (role) =>
          request(role, 'POST', `/workspaces/${randomUUID()}/invitations`, {
            email: `role-matrix-${randomUUID().slice(0, 8)}@${SSO_EMAIL_DOMAIN}`,
          }).then((r) => r.statusCode),
      ),
    );
  });

  it('§3.1:64,71 — the project roster is Workspace Admin Edit, Admin READ-ONLY, Editor Hidden', async () => {
    /**
     * The route carries `project:view`, which EVERY level holds, so the level check lives in
     * `ProjectsService.listProjectMembers`. That divergence between the decorator and the effective
     * audience is exactly what a decorator sweep cannot see.
     */
    assertMatches(
      await probe(
        {
          srs: '§3.1:64,71',
          surface: 'Project Users & Permissions',
          action: 'view',
          route: 'GET /projects/:id/members',
          code: 'project:view (+ level check in service)',
          expected: ADMIN_UP,
        },
        (role) => get(role, `/projects/${NXP}/members`),
      ),
    );

    /**
     * And the WRITE half — "Read-only view only" for Admin means this must refuse them. Real project
     * id (the guard resolves the level from it) plus a bogus `userId`, so a Workspace Admin reaches
     * the service and dies on USER_NOT_FOUND without granting anyone anything.
     */
    assertMatches(
      await probe(
        {
          srs: '§3.1:64',
          surface: 'Assign Project access',
          action: 'grant',
          route: 'POST /projects/:id/members',
          code: 'project:manage_members',
          expected: WA_ONLY,
        },
        (role) =>
          request(role, 'POST', `/projects/${NXP}/members`, {
            userId: randomUUID(),
            accessLevel: 'editor',
          }).then((r) => r.statusCode),
      ),
    );
  });

  it('§3.1:66 — the Audit Log is Workspace Admin only', async () => {
    assertMatches(
      await probe(
        {
          srs: '§3.1:66',
          surface: 'Audit Log',
          action: 'view',
          route: 'GET /audit-logs',
          code: 'audit:view',
          expected: WA_ONLY,
        },
        (role) => get(role, '/audit-logs'),
      ),
    );
  });

  it('§3.1:68 — Project create / edit / archive / delete are Workspace Admin only', async () => {
    /**
     * `key: 'NXP'` is the seeded project's own key, so a Workspace Admin gets `PROJECT_KEY_TAKEN`
     * (409) and no project is created. `test/e2e-fixtures.ratchet.spec.ts` caps `createProject`
     * calls precisely because this suite used to leak ~84 projects a run.
     */
    assertMatches(
      await probe(
        {
          srs: '§3.1:68',
          surface: 'Project lifecycle',
          action: 'create',
          route: 'POST /projects',
          code: 'project:create',
          expected: WA_ONLY,
        },
        (role) =>
          request(role, 'POST', '/projects', {
            key: SEEDED.nxp.key,
            name: 'Role matrix duplicate-key probe',
          }).then((r) => r.statusCode),
      ),
    );

    // Workspace-tier code ⇒ the path id is not consulted by the guard; a bogus one 404s in the
    // service. This is the row CLAUDE.md records as the deliberate BA-over-Rally ruling: a
    // per-project Admin has NO structural authority, so this carries `workspace:edit`.
    assertMatches(
      await probe(
        {
          srs: '§3.1:68',
          surface: 'Project lifecycle',
          action: 'edit',
          route: 'PATCH /projects/:id',
          code: 'workspace:edit',
          expected: WA_ONLY,
        },
        (role) =>
          request(role, 'PATCH', `/projects/${randomUUID()}`, { name: 'probe' }).then(
            (r) => r.statusCode,
          ),
      ),
    );

    /**
     * `project:archive` / `project:delete` are project-TIER with `{ from: 'param', field: 'id' }` and
     * NO `resource`, so the guard treats the path id AS the project id and never checks it exists.
     * A random uuid therefore resolves to "no assignment on that project" for every non-WA principal
     * (403) while the Workspace Admin's `workspace:*` baseline passes and the service 404s. Nothing
     * is archived or deleted.
     */
    assertMatches(
      await probe(
        {
          srs: '§3.1:68',
          surface: 'Project lifecycle',
          action: 'archive',
          route: 'POST /projects/:id/archive',
          code: 'project:archive',
          expected: WA_ONLY,
        },
        (role) =>
          request(role, 'POST', `/projects/${randomUUID()}/archive`, {}).then((r) => r.statusCode),
      ),
    );

    assertMatches(
      await probe(
        {
          srs: '§3.1:68',
          surface: 'Project lifecycle',
          action: 'delete',
          route: 'DELETE /projects/:id',
          code: 'project:delete',
          expected: WA_ONLY,
        },
        (role) => request(role, 'DELETE', `/projects/${randomUUID()}`).then((r) => r.statusCode),
      ),
    );
  });

  it('§3.1:69 — Team create / edit and Team membership are Workspace Admin only', async () => {
    assertMatches(
      await probe(
        {
          srs: '§3.1:69',
          surface: 'Team lifecycle',
          action: 'create',
          route: 'POST /workspaces/:id/teams',
          code: 'teams:create',
          expected: WA_ONLY,
        },
        (role) =>
          request(role, 'POST', `/workspaces/${randomUUID()}/teams`, {
            name: 'Role matrix probe team',
            key: 'RMPROBE',
            projectIds: [NXP],
          }).then((r) => r.statusCode),
      ),
    );

    assertMatches(
      await probe(
        {
          srs: '§3.1:69',
          surface: 'Team lifecycle',
          action: 'edit',
          route: 'PATCH /teams/:id',
          code: 'teams:edit',
          expected: WA_ONLY,
        },
        (role) =>
          request(role, 'PATCH', `/teams/${randomUUID()}`, { name: 'probe' }).then(
            (r) => r.statusCode,
          ),
      ),
    );

    assertMatches(
      await probe(
        {
          srs: '§3.1:64,69',
          surface: 'Team membership',
          action: 'grant',
          route: 'POST /teams/:id/members',
          code: 'teams:manage_members',
          expected: WA_ONLY,
        },
        (role) =>
          request(role, 'POST', `/teams/${randomUUID()}/members`, { userId: randomUUID() }).then(
            (r) => r.statusCode,
          ),
      ),
    );
  });

  it('§3.1:70 — Project Details and Teams are readable by Admin and Editor, hidden from No Access', async () => {
    for (const [action, route, url] of [
      ['view', 'GET /projects/:id', `/projects/${NXP}`],
      ['view teams', 'GET /projects/:id/teams', `/projects/${NXP}/teams`],
    ] as const) {
      assertMatches(
        await probe(
          {
            srs: '§3.1:70',
            surface: 'Project Details and Teams',
            action,
            route,
            code: 'project:view',
            expected: EDITOR_UP,
          },
          (role) => get(role, url),
        ),
      );
    }

    /**
     * The TEAM roster read is scoped in `TeamService` by `listReadableProjectIds`, and an unreachable
     * team is 404 rather than 403 — deliberately, so the detail route cannot confirm the existence of
     * a team the list hides (§7:199, "a guessed identifier may show Not Found"). So No Access is
     * expected to be ALLOWED past the guard here and refused by the service, which is why this probe
     * is asserted on the body and not through `probe()`'s 403 rule.
     */
    const rosterStatuses: Partial<Record<Role, number>> = {};
    for (const role of ROLES) rosterStatuses[role] = await get(role, `/teams/${TEAM}/members`);
    MATRIX.push({
      srs: '§3.1:70',
      surface: 'Project Details and Teams',
      action: 'team roster',
      route: 'GET /teams/:id/members',
      code: '(in-service: listReadableProjectIds)',
      expected: EDITOR_UP,
      measured: rosterStatuses,
      mismatches: [],
    });
    expect(rosterStatuses.wa, 'WA reads the team roster').toBe(200);
    expect(rosterStatuses.admin, 'a project Admin reads the team roster').toBe(200);
    expect(
      rosterStatuses.editor,
      'an Editor reads the team roster (§3.1:70 read-only, scoped)',
    ).toBe(200);
    expect(
      rosterStatuses.none,
      'No Access must not reach a team roster — 404 by design, not 403',
    ).toBe(404);
  });

  /**
   * §3.1:67 `View Workspaces & Projects` — `All Projects` / `Assigned Project` / `Assigned Project`
   * / Hidden. `GET /projects` carries no permission code by design: it is a cross-project list
   * scoped in the service by `AccessService.listReadableProjectIds`, whose `null` (UNRESTRICTED) and
   * `[]` (nothing) sentinels no decorator can carry. So the honest server answer for No Access is
   * `200` with an EMPTY page, not a 403 — the row is Hidden in the SPA because the list is empty.
   * Measured as a COUNT for that reason.
   */
  it('§3.1:67 — the project list is scoped per principal, and empty for No Access', async () => {
    const counts: Partial<Record<Role, number>> = {};
    const statuses: Partial<Record<Role, number>> = {};
    for (const role of ROLES) {
      const res = await request(role, 'GET', '/projects?limit=100');
      statuses[role] = res.statusCode;
      counts[role] = (JSON.parse(res.body) as { data: unknown[] }).data.length;
    }
    MATRIX.push({
      srs: '§3.1:67',
      surface: 'Workspaces & Projects',
      action: `list (rows: ${ROLES.map((r) => `${r}=${counts[r]}`).join(' ')})`,
      route: 'GET /projects',
      code: '(in-service: listReadableProjectIds)',
      expected: { wa: 'allow', admin: 'allow', editor: 'allow', none: 'allow' },
      measured: statuses,
      mismatches: [],
    });

    expect(statuses.none, 'a cross-project list answers, it does not 403').toBe(200);
    expect(counts.wa, 'WA sees both seeded projects').toBeGreaterThanOrEqual(2);
    expect(counts.admin, 'a project Admin sees exactly their assigned project').toBe(1);
    expect(counts.editor, 'an Editor sees exactly their assigned project').toBe(1);
    expect(counts.none, 'No Access sees nothing — §3.1:67 Hidden').toBe(0);
  });

  /**
   * §3.1:65 `View Permission Model` — View / View / Hidden / Hidden.
   *
   * THERE IS NO SERVER ROUTE FOR THIS ROW. `apps/web/src/pages/settings/ui/permission-model-tab.tsx`
   * is a static table compiled into the SPA and gated client-side on `project:edit`; it fetches
   * nothing. (`GET /roles` is the workspace-tier role catalogue, `roles:view`, WA-only — a different
   * surface, asserted in `authz-cluster.e2e.spec.ts`.) The measurable server fact is therefore the
   * PREMISE of the client gate: `project:edit` must resolve for WA and Admin and not for the other
   * two, read back over HTTP from the route the SPA itself uses.
   */
  it('§3.1:65 — the Permission Model has no route; its client gate `project:edit` resolves per the BA', async () => {
    const held: Partial<Record<Role, boolean>> = {};
    const statuses: Partial<Record<Role, number>> = {};
    for (const role of ROLES) {
      const res = await request(role, 'GET', `/projects/${NXP}/my-permissions`);
      statuses[role] = res.statusCode;
      const body = JSON.parse(res.body) as { permissions?: string[] };
      held[role] =
        (body.permissions ?? []).includes('project:edit') ||
        (body.permissions ?? []).includes('workspace:*');
    }
    MATRIX.push({
      srs: '§3.1:65',
      surface: 'Permission Model',
      action: `client gate project:edit (${ROLES.map((r) => `${r}=${held[r]}`).join(' ')})`,
      route: 'GET /projects/:projectId/my-permissions',
      code: '(self-scoped; NO route serves the tab)',
      expected: { wa: 'allow', admin: 'allow', editor: 'allow', none: 'allow' },
      measured: statuses,
      mismatches: [],
    });

    expect(held.wa, 'WA holds project:edit (via workspace:*)').toBe(true);
    expect(held.admin, 'a project Admin holds project:edit — §3.1:65 View').toBe(true);
    expect(held.editor, 'an Editor must not — §3.1:65 Hidden').toBe(false);
    expect(held.none, 'No Access must not — §3.1:65 Hidden').toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // §3.2 — Delivery features (SRS lines 77-87)
  // ═══════════════════════════════════════════════════════════════════════════

  it('§3.2:79 — Backlog and US/DE/Task: Create, View, Edit, Delete for all three levels', async () => {
    assertMatches(
      await probe(
        {
          srs: '§3.2:79',
          surface: 'Backlog / US-DE-Task',
          action: 'view',
          route: 'GET /work-items/backlog',
          code: 'work_item:view',
          expected: EDITOR_UP,
        },
        (role) => get(role, `/work-items/backlog?projectId=${NXP}`),
      ),
    );

    // Create-then-delete: the same principal holds `work_item:create` and `work_item:delete` at
    // every level the BA grants, so the round trip measures both and leaves nothing behind.
    assertMatches(
      await probe(
        {
          srs: '§3.2:79',
          surface: 'Backlog / US-DE-Task',
          action: 'create+delete',
          route: 'POST /work-items → DELETE /work-items/:id',
          code: 'work_item:create / :delete',
          expected: EDITOR_UP,
        },
        (role) =>
          createThenDelete(
            role,
            '/work-items',
            { projectId: NXP, type: 'story', title: `Role matrix story ${role} ${Date.now()}` },
            (id) => `/work-items/${id}`,
          ),
      ),
    );

    // EDIT, on a row the principal created — so a granted principal really writes and a denied one
    // is refused, without touching a seeded item every other spec reads.
    const editStatuses: Partial<Record<Role, number>> = {};
    for (const role of ROLES) {
      const created = await request(role, 'POST', '/work-items', {
        projectId: NXP,
        type: 'story',
        title: `Role matrix edit ${role} ${Date.now()}`,
      });
      if (created.statusCode >= 300) {
        // Denied at create ⇒ measure EDIT against a seeded row instead. A refusal writes nothing.
        editStatuses[role] = (
          await request(role, 'PATCH', `/work-items/${SEEDED.nxp.storyId}`, { title: 'probe' })
        ).statusCode;
        continue;
      }
      const { id } = JSON.parse(created.body) as { id: string };
      editStatuses[role] = (
        await request(role, 'PATCH', `/work-items/${id}`, { title: `edited ${role}` })
      ).statusCode;
      const removed = await request(role, 'DELETE', `/work-items/${id}`);
      expect(removed.statusCode, `cleanup of the edit probe row for ${role}`).toBeLessThan(300);
    }
    const editRow: Row = {
      srs: '§3.2:79',
      surface: 'Backlog / US-DE-Task',
      action: 'edit',
      route: 'PATCH /work-items/:id',
      code: 'work_item:edit',
      expected: EDITOR_UP,
      measured: editStatuses,
      mismatches: [],
    };
    MATRIX.push(editRow);
    for (const role of ROLES) {
      const verdict: Verdict = editStatuses[role] === 403 ? 'deny' : 'allow';
      if (verdict !== EDITOR_UP[role]) {
        editRow.mismatches.push(
          `${role} expected ${EDITOR_UP[role]}, measured ${editStatuses[role]}`,
        );
      }
    }
    assertMatches(editRow);

    // A Task is part of the same §3.2 row, and it is created THROUGH its parent Story.
    assertMatches(
      await probe(
        {
          srs: '§3.2:79',
          surface: 'Backlog / US-DE-Task',
          action: 'create task',
          route: 'POST /work-items/:id/tasks → DELETE /work-items/:id',
          code: 'work_item:create / :delete',
          expected: EDITOR_UP,
        },
        (role) =>
          createThenDelete(
            role,
            `/work-items/${SEEDED.nxp.storyId}/tasks`,
            { title: `Role matrix task ${role} ${Date.now()}` },
            (id) => `/work-items/${id}`,
          ),
      ),
    );
  });

  it('§3.2:80 — Iteration Status: View and update for all three levels', async () => {
    assertMatches(
      await probe(
        {
          srs: '§3.2:80',
          surface: 'Iteration Status',
          action: 'view',
          route: 'GET /iterations/:id/status',
          code: 'iteration:view',
          expected: EDITOR_UP,
        },
        (role) => get(role, `/iterations/${ITER}/status`),
      ),
    );

    /**
     * The `Add New` button on this screen. It used to require `iteration:edit` — which an Editor does
     * not hold — while the button was gated on `work_item:create`, which they do; so an Editor saw
     * the button and got a 403 for an item they can create from the Backlog. Both halves are
     * measured here, and the created item is removed again.
     */
    assertMatches(
      await probe(
        {
          srs: '§3.2:80',
          surface: 'Iteration Status',
          action: 'add item',
          route: 'POST /iterations/:id/work-items → DELETE /work-items/:id',
          code: 'work_item:create',
          expected: EDITOR_UP,
        },
        (role) =>
          createThenDelete(
            role,
            `/iterations/${ITER}/work-items`,
            { type: 'story', title: `Role matrix iteration story ${role} ${Date.now()}` },
            (id) => `/work-items/${id}`,
            (body) => body.workItemId,
          ),
      ),
    );
  });

  it('§3.2:81 — Quality / Defects: Create, View, Edit, Delete for all three levels', async () => {
    assertMatches(
      await probe(
        {
          srs: '§3.2:81',
          surface: 'Quality / Defects',
          action: 'view',
          route: 'GET /quality/defects',
          code: 'quality:view',
          expected: EDITOR_UP,
        },
        (role) => get(role, `/quality/defects?projectId=${NXP}`),
      ),
    );

    /**
     * EDIT, writing the seeded defect's CURRENT title back — so an allowed principal really reaches
     * the write path and no displayed value changes. A defect cannot be created-then-deleted the way
     * a story can; see the Delete probe immediately below for why.
     */
    const current = await request('wa', 'GET', `/work-items/${SEEDED.nxp.defectId}`);
    const defectTitle = (JSON.parse(current.body) as { title: string }).title;
    assertMatches(
      await probe(
        {
          srs: '§3.2:81',
          surface: 'Quality / Defects',
          action: 'edit',
          route: 'PATCH /work-items/:id',
          code: 'work_item:edit',
          expected: EDITOR_UP,
        },
        (role) =>
          request(role, 'PATCH', `/work-items/${SEEDED.nxp.defectId}`, { title: defectTitle }).then(
            (r) => r.statusCode,
          ),
      ),
    );

    /**
     * DELETE — the mismatch this block used to record is RESOLVED (BA report, 2026-08-20).
     *
     * §3.2:81 gives `Quality / Defects` the verb `Delete` in all three granted columns; Phase 3.4 said
     * the opposite and the server implemented Phase 3.4, refusing every principal with
     * `DEFECT_DELETE_FORBIDDEN`. This block measured that and said so, with a note not to fix either
     * side without a ruling. The BA reporting "cannot delete defect in Backlog and Iteration Status"
     * IS the ruling: §3.2:81 wins, and the refusal is gone.
     *
     * So the expectation is now the ordinary authorization one — the three granted levels delete, No
     * Access is refused — and a tester following the matrix finds the Delete the matrix promises.
     */
    /**
     * A THROWAWAY defect per role, not the seeded one. The delete succeeds now, so probing
     * `SEEDED.nxp.defectId` would consume a fixture other specs read — the leak this file's own
     * comments warn about. Created on Team Alpha, which the Editor principal is on, so what is measured
     * is AUTHORIZATION rather than the Project-Backlog team rule.
     */
    const deleteStatuses: Partial<Record<Role, number>> = {};
    for (const role of ROLES) {
      const created = await request('wa', 'POST', '/work-items', {
        projectId: NXP,
        type: 'defect',
        title: `role matrix delete probe ${randomUUID().slice(0, 8)}`,
        teamId: TEAM,
      });
      expect(created.statusCode, created.body).toBe(201);
      const probeId = (JSON.parse(created.body) as { id: string }).id;
      deleteStatuses[role] = (await request(role, 'DELETE', `/work-items/${probeId}`)).statusCode;
    }
    MATRIX.push({
      srs: '§3.2:81',
      surface: 'Quality / Defects',
      action: 'delete',
      route: 'DELETE /work-items/:id (defect)',
      code: 'work_item:delete',
      expected: EDITOR_UP,
      measured: deleteStatuses,
      mismatches: [
        // Resolved 2026-08-20: the row is measured against `EDITOR_UP` like every other verb now.
      ],
    });
    for (const role of ['wa', 'admin', 'editor'] as const) {
      expect(deleteStatuses[role], `${role} holds work_item:delete and §3.2:81 grants it`).toBe(
        204,
      );
    }
    expect(deleteStatuses.none, 'No Access is refused by the guard').toBe(403);
    // The seeded defect is untouched: every probe above deleted a row it created.
    expect((await request('wa', 'GET', `/work-items/${SEEDED.nxp.defectId}`)).statusCode).toBe(200);
  });

  it('§3.2:82 — Timeboxes / Iterations: Admin and WA only; HIDDEN from an Editor', async () => {
    /**
     * The RECORD list — `goal`, `theme`, `notes`, `plannedVelocity` — is the `Plan > Timeboxes` grid
     * and carries `timebox:view`. `iteration:view` gated it until migration 0120, so an Editor read
     * the whole timebox inventory on a screen the BA hides. `authz-cluster.e2e.spec.ts` owns the
     * matching "Iteration Status stays open" half; this row is the §3.2:82 cell.
     */
    for (const [action, route, url] of [
      ['view list', 'GET /iterations', `/iterations?projectId=${NXP}`],
      ['view record', 'GET /iterations/:id', `/iterations/${ITER}`],
      ['view history', 'GET /iterations/:id/activity', `/iterations/${ITER}/activity`],
    ] as const) {
      assertMatches(
        await probe(
          {
            srs: '§3.2:82',
            surface: 'Timeboxes / Iterations',
            action,
            route,
            code: 'timebox:view',
            expected: ADMIN_UP,
          },
          (role) => get(role, url),
        ),
      );
    }

    assertMatches(
      await probe(
        {
          srs: '§3.2:82',
          surface: 'Timeboxes / Iterations',
          action: 'create+delete',
          route: 'POST /iterations → DELETE /iterations/:id',
          code: 'iteration:create / :delete',
          expected: ADMIN_UP,
        },
        (role) =>
          createThenDelete(
            role,
            '/iterations',
            { projectId: NXP, name: `Role matrix sprint ${role} ${Date.now()}` },
            (id) => `/iterations/${id}`,
          ),
      ),
    );
  });

  it('§3.2:83 — Releases and Milestones: Admin and WA only; HIDDEN from an Editor', async () => {
    for (const [surface, action, route, url, code] of [
      ['Releases', 'view', 'GET /releases', `/releases?projectId=${NXP}`, 'release:view'],
      ['Milestones', 'view', 'GET /milestones', `/milestones?projectId=${NXP}`, 'milestone:view'],
    ] as const) {
      assertMatches(
        await probe({ srs: '§3.2:83', surface, action, route, code, expected: ADMIN_UP }, (role) =>
          get(role, url),
        ),
      );
    }

    assertMatches(
      await probe(
        {
          srs: '§3.2:83',
          surface: 'Releases',
          action: 'create+delete',
          route: 'POST /releases → DELETE /releases/:id',
          code: 'release:create / :delete',
          expected: ADMIN_UP,
        },
        (role) =>
          createThenDelete(
            role,
            '/releases',
            { projectId: NXP, name: `Role matrix release ${role} ${Date.now()}` },
            (id) => `/releases/${id}`,
          ),
      ),
    );

    assertMatches(
      await probe(
        {
          srs: '§3.2:83',
          surface: 'Milestones',
          action: 'create+delete',
          route: 'POST /milestones → DELETE /milestones/:id',
          code: 'milestone:create / :delete',
          expected: ADMIN_UP,
        },
        (role) =>
          createThenDelete(
            role,
            '/milestones',
            {
              projectId: NXP,
              name: `Role matrix milestone ${role} ${Date.now()}`,
              releaseIds: [],
            },
            (id) => `/milestones/${id}`,
          ),
      ),
    );
  });

  it('§3.2:84 — Team Status: WA/Admin view AND update; Editor VIEW ONLY (no capacity/task edits)', async () => {
    assertMatches(
      await probe(
        {
          srs: '§3.2:84',
          surface: 'Team Status',
          action: 'view',
          route: 'GET /team-status',
          code: 'team_status:view',
          expected: EDITOR_UP,
        },
        (role) => get(role, `/team-status?projectId=${NXP}&iterationId=${ITER}`),
      ),
    );

    /**
     * Capacity edit. Real `projectId` (the guard's scope) plus a BOGUS `iterationId` and no `teamId`,
     * so `updateCapacity` resolves the team from an iteration that does not exist and 404s — nothing
     * is written to `member_capacity`, whose numbers Team Status and the Team Capacity report both
     * render.
     */
    assertMatches(
      await probe(
        {
          srs: '§3.2:84',
          surface: 'Team Status',
          action: 'edit capacity',
          route: 'PATCH /team-status/capacity',
          code: 'team_status:edit',
          expected: ADMIN_UP,
        },
        (role) =>
          request(role, 'PATCH', '/team-status/capacity', {
            projectId: NXP,
            iterationId: randomUUID(),
            userId: adminUserId,
            capacityHours: 8,
          }).then((r) => r.statusCode),
      ),
    );

    /**
     * Task edit from Team Status. This one needs a REAL task id — the guard is
     * `{ resource: 'work_item', from: 'param', field: 'taskId' }`, and an unresolvable id denies
     * everyone including a Workspace Admin, so a bogus id would measure nothing. The payload writes
     * the task's CURRENT title back, so an allowed principal's 200 changes no displayed value.
     */
    assertMatches(
      await probe(
        {
          srs: '§3.2:84',
          surface: 'Team Status',
          action: 'edit task',
          route: 'PATCH /team-status/tasks/:taskId',
          code: 'team_status:edit',
          expected: ADMIN_UP,
        },
        (role) =>
          request(role, 'PATCH', `/team-status/tasks/${taskId}`, { title: taskTitle }).then(
            (r) => r.statusCode,
          ),
      ),
    );
  });

  it('§3.2:85 — Portfolio Items: Admin and WA only; HIDDEN from an Editor', async () => {
    /**
     * The GRID answers `200` with NO ROWS for an Editor rather than 403: `projectId` is optional on
     * that route (a WA lists across projects), so the scope is a service-side filter over
     * `listReadableProjectIds` and `[]` is its honest answer. The RECORD is the 403 — measured below.
     */
    const gridCounts: Partial<Record<Role, number>> = {};
    const gridStatuses: Partial<Record<Role, number>> = {};
    for (const role of ROLES) {
      const res = await request(role, 'GET', `/portfolio-items?type=feature&projectId=${NXP}`);
      gridStatuses[role] = res.statusCode;
      gridCounts[role] =
        res.statusCode === 200 ? (JSON.parse(res.body) as { data: unknown[] }).data.length : -1;
    }
    MATRIX.push({
      srs: '§3.2:85',
      surface: 'Portfolio Items',
      action: `grid (rows: ${ROLES.map((r) => `${r}=${gridCounts[r]}`).join(' ')})`,
      route: 'GET /portfolio-items',
      code: '(in-service: listReadableProjectIds)',
      expected: { wa: 'allow', admin: 'allow', editor: 'allow', none: 'allow' },
      measured: gridStatuses,
      mismatches: [],
    });
    expect(gridCounts.wa, 'NXP seeds an Epic and seven Features').toBeGreaterThan(0);
    expect(gridCounts.admin, 'a project Admin sees them').toBeGreaterThan(0);
    expect(gridCounts.editor, '§3.2:85 hides Portfolio Items from an Editor').toBe(0);
    expect(gridCounts.none, 'No Access sees nothing').toBe(0);

    assertMatches(
      await probe(
        {
          srs: '§3.2:85',
          surface: 'Portfolio Items',
          action: 'view record',
          route: 'GET /portfolio-items/:id',
          code: 'portfolio:view',
          expected: ADMIN_UP,
        },
        (role) => get(role, `/portfolio-items/${SEEDED.nxp.featureId}`),
      ),
    );

    /**
     * CREATE, with a bogus `parentId`: `assertReferences` refuses it with 422
     * `PORTFOLIO_ITEM_INVALID_PARENT` AFTER the guard has decided, so the allow direction is measured
     * without minting a Feature. Portfolio items have no hard delete, and `portfolio_items.rank` is
     * `varchar(255)` extended by appending — the column that twice stopped this suite dead — so a
     * create-then-delete round trip is not available here.
     */
    assertMatches(
      await probe(
        {
          srs: '§3.2:85',
          surface: 'Portfolio Items',
          action: 'create',
          route: 'POST /portfolio-items',
          code: 'portfolio:create',
          expected: ADMIN_UP,
        },
        (role) =>
          request(role, 'POST', '/portfolio-items', {
            projectId: NXP,
            type: 'feature',
            name: `Role matrix feature ${role}`,
            parentId: randomUUID(),
          }).then((r) => r.statusCode),
      ),
    );

    // ARCHIVE — the fourth verb in the §3.2:85 cell. Round-tripped through `unarchive` so the
    // seeded Feature ends where it started; a denied principal's 403 changes nothing either way.
    assertMatches(
      await probe(
        {
          srs: '§3.2:85',
          surface: 'Portfolio Items',
          action: 'archive',
          route: 'POST /portfolio-items/:id/archive',
          code: 'portfolio:archive',
          expected: ADMIN_UP,
        },
        async (role) => {
          const archived = await request(
            role,
            'POST',
            `/portfolio-items/${SEEDED.nxp.featureId}/archive`,
            {},
          );
          if (archived.statusCode < 300) {
            const restored = await request(
              role,
              'POST',
              `/portfolio-items/${SEEDED.nxp.featureId}/unarchive`,
              {},
            );
            expect(
              restored.statusCode,
              `the seeded Feature must be restored after the ${role} archive probe`,
            ).toBeLessThan(300);
          }
          return archived.statusCode;
        },
      ),
    );
  });

  it('§3.2:86 — Capacity Planning: Admin and WA only; HIDDEN from an Editor', async () => {
    for (const [action, route, url] of [
      ['list', 'GET /capacity-plans', `/capacity-plans?projectId=${NXP}`],
      ['view draft', 'GET /capacity-plans/:id', `/capacity-plans/${SEEDED.nxp.capacityPlanId}`],
    ] as const) {
      assertMatches(
        await probe(
          {
            srs: '§3.2:86',
            surface: 'Capacity Planning',
            action,
            route,
            code: 'capacity:view',
            expected: ADMIN_UP,
          },
          (role) => get(role, url),
        ),
      );
    }

    /**
     * CREATE on a release that ALREADY has a plan: `uq_capacity_plan_project_release` is checked in
     * the service and answers 409 `CAPACITY_PLAN_EXISTS` after the guard, so no plan is created.
     */
    assertMatches(
      await probe(
        {
          srs: '§3.2:86',
          surface: 'Capacity Planning',
          action: 'create',
          route: 'POST /capacity-plans',
          code: 'capacity:manage',
          expected: ADMIN_UP,
        },
        (role) =>
          request(role, 'POST', '/capacity-plans', {
            projectId: NXP,
            releaseId: SEEDED.nxp.releaseId,
            name: `Role matrix plan ${role}`,
            unit: 'points',
          }).then((r) => r.statusCode),
      ),
    );

    /**
     * PUBLISH, aimed at the plan that is ALREADY published — `requireDraft` answers
     * `CAPACITY_PLAN_NOT_DRAFT` after the guard, so publishing writes nothing back to any Feature.
     * That matters: publish is the one capacity action whose blast radius reaches outside the plan.
     */
    assertMatches(
      await probe(
        {
          srs: '§3.2:86',
          surface: 'Capacity Planning',
          action: 'publish',
          route: 'POST /capacity-plans/:id/publish',
          code: 'capacity:publish',
          expected: ADMIN_UP,
        },
        (role) =>
          request(
            role,
            'POST',
            `/capacity-plans/${SEEDED.nxp.publishedCapacityPlanId}/publish`,
            {},
          ).then((r) => r.statusCode),
      ),
    );
  });

  it('§3.2:87 — Release Tracking and Reports: View for Admin and WA; HIDDEN from an Editor', async () => {
    for (const [action, route, url] of [
      [
        'burndown',
        'GET /reports/iteration-burndown',
        `/reports/iteration-burndown?projectId=${NXP}&iterationId=${ITER}`,
      ],
      ['velocity', 'GET /reports/velocity', `/reports/velocity?projectId=${NXP}`],
      [
        'team capacity',
        'GET /reports/team-capacity',
        `/reports/team-capacity?projectId=${NXP}&iterationId=${ITER}`,
      ],
      [
        'release tracking',
        'GET /reports/release-tracking',
        `/reports/release-tracking?projectId=${NXP}&releaseId=${SEEDED.nxp.releaseId}`,
      ],
      [
        'burnup',
        'GET /reports/release-tracking/burnup',
        `/reports/release-tracking/burnup?projectId=${NXP}&releaseId=${SEEDED.nxp.releaseId}`,
      ],
    ] as const) {
      assertMatches(
        await probe(
          {
            srs: '§3.2:87',
            surface: 'Release Tracking / Reports',
            action,
            route,
            code: 'report:view',
            expected: ADMIN_UP,
          },
          (role) => get(role, url),
        ),
      );
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Rows where the BA is SILENT — recorded, not invented
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * PROJECT DELIVERY CONFIGURATION — labels and workflow statuses/transitions.
   *
   * §3.1 has NO row for either. The two nearest cells point opposite ways: line 68 hides
   * `Create, edit … Project` from an Admin, and line 70 gives them `View Project Details and Teams |
   * Read-only` — yet §3.1:73's own summary says "`Admin` is powerful for delivery management", which
   * is the sentence `project:edit` staying in the Admin set rests on (CLAUDE.md, "A per-Project
   * `Admin` has NO structural authority"). So this is a DECLARED READING, not a BA rule, and it is
   * measured here rather than asserted against a matrix cell that does not exist.
   *
   * Worth knowing that the app's own read-only Permission Model tab lists
   * `Project Settings … admin: false`, which is the opposite of what the server does. That
   * disagreement is a finding for the audit, not something this spec can resolve.
   */
  it('BA SILENT — project label and workflow configuration is writable by an Admin (declared reading)', async () => {
    for (const [action, route, url, payload] of [
      [
        'create label',
        'POST /projects/:id/labels',
        `/projects/${NXP}/labels`,
        { name: `rm-${randomUUID().slice(0, 8)}` },
      ],
      [
        'create status',
        'POST /projects/:projectId/statuses',
        `/projects/${NXP}/statuses`,
        { name: `rm-${randomUUID().slice(0, 6)}`, category: 'in_progress' },
      ],
    ] as const) {
      const statuses: Partial<Record<Role, number>> = {};
      for (const role of ROLES) {
        const res = await request(role, 'POST', url, payload);
        statuses[role] = res.statusCode;
        // Remove anything that was really created, so the probe leaves the project's
        // configuration exactly as it found it.
        if (res.statusCode < 300) {
          const { id } = JSON.parse(res.body) as { id: string };
          const path =
            action === 'create label'
              ? `/projects/${NXP}/labels/${id}`
              : `/projects/${NXP}/statuses/${id}`;
          await request(role, 'DELETE', path);
        }
      }
      MATRIX.push({
        srs: '(silent)',
        surface: 'Project delivery config',
        action,
        route,
        code: 'project:edit',
        expected: ADMIN_UP,
        measured: statuses,
        mismatches: [],
      });
      expect(statuses.wa, `${route} for a Workspace Admin`).toBeLessThan(300);
      expect(statuses.editor, `${route} must be refused to an Editor`).toBe(403);
      expect(statuses.none, `${route} must be refused to No Access`).toBe(403);
    }
  });

  /**
   * `GET /workspaces/:id` — the workspace RECORD (name, slug, description, avatar).
   *
   * §3.1:61 hides `View Workspace Settings` from everyone but a Workspace Admin, and the SETTINGS
   * route honours that (`workspace:view`, asserted above). This route is a different thing: it is
   * `@AuthorizedInService` with `assertActive` only, so ANY authenticated member of the workspace —
   * including a No Access principal — reads it. The BA writes no row for the workspace record itself,
   * and the SPA's app shell needs a workspace name to render for a user who has no project yet, so
   * this is recorded as SILENT rather than as a defect.
   */
  it('BA SILENT — the workspace record is readable by every authenticated member', async () => {
    const statuses: Partial<Record<Role, number>> = {};
    for (const role of ROLES) statuses[role] = await get(role, `/workspaces/${WORKSPACE_ID}`);
    MATRIX.push({
      srs: '(silent)',
      surface: 'Workspace record',
      action: 'view',
      route: 'GET /workspaces/:id',
      code: '(in-service: assertActive)',
      expected: { wa: 'allow', admin: 'allow', editor: 'allow', none: 'allow' },
      measured: statuses,
      mismatches: [],
    });
    for (const role of ROLES) {
      expect(statuses[role], `GET /workspaces/:id for ${role}`).toBe(200);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // §3.2:91-92 — the two "Additional rules" under the delivery table
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * §3.2:91 — "Admin actions are limited to the assigned Project even when the same account has a
   * different level elsewhere", and §2.2 — "Access in one Project never grants access to another".
   *
   * The Admin principal holds `admin` on NXP and nothing on PAY; the Editor holds `editor` on NXP and
   * nothing on PAY. `SEEDED.pay` exists precisely so this has something to be false on.
   */
  it('§3.2:91 — a level on one project grants nothing on another', async () => {
    const PAY = SEEDED.pay.projectId;
    for (const [surface, route, url, code] of [
      ['Project Details', 'GET /projects/:id', `/projects/${PAY}`, 'project:view'],
      [
        'Backlog',
        'GET /work-items/backlog',
        `/work-items/backlog?projectId=${PAY}`,
        'work_item:view',
      ],
      ['Reports', 'GET /reports/velocity', `/reports/velocity?projectId=${PAY}`, 'report:view'],
      [
        'Capacity Planning',
        'GET /capacity-plans',
        `/capacity-plans?projectId=${PAY}`,
        'capacity:view',
      ],
    ] as const) {
      assertMatches(
        await probe(
          {
            srs: '§3.2:91',
            surface: `${surface} on the OTHER project`,
            action: 'view',
            route,
            code,
            expected: WA_ONLY,
          },
          (role) => get(role, url),
        ),
      );
    }
  });

  /**
   * §3.2:92 — "Editor results, selectors, search and mutations are limited to assigned Teams."
   *
   * IMPLEMENTED, and this block is INVERTED from what it was. It used to MEASURE a declared divergence
   * ("there is no team authorization scope", ruling 2026-08-14) and assert only that the request had
   * been decided either way, because the BA's sentence and the code disagreed on purpose. The BA
   * closed that on 2026-08-17: "Null means Project Backlog, accessible only to Workspace Admin and
   * Project Admin. Editor must select one of their assigned Teams when creating a Work Item and cannot
   * access team-less items."
   *
   * So there are now two refusals to assert, and the difference between them is the whole point of the
   * ruling: naming ANOTHER team is `TEAM_NOT_IN_SCOPE`, and naming NONE is `WORK_ITEM_TEAM_REQUIRED` —
   * a missing required choice on a form, not "you may not open that". The per-record and per-list
   * halves live in `test/e2e/editor-team-scope.e2e.spec.ts`; this file keeps the row so the audit
   * table still covers the whole Editor surface.
   */
  it('§3.2:92 — Editor writes ARE team-scoped, and the Project Backlog is admin-only', async () => {
    const teamsRes = await request('wa', 'GET', `/projects/${NXP}/teams`);
    const teams = JSON.parse(teamsRes.body) as Array<{ id: string }>;
    // A team of this project that the Editor is NOT on. `dev@qnsc.dev` is DEVELOPER_ID.
    let foreignTeam: string | undefined;
    for (const team of teams) {
      const members = await request('wa', 'GET', `/teams/${team.id}/members`);
      if (members.statusCode !== 200) continue;
      const ids = (JSON.parse(members.body) as Array<{ userId: string }>).map((m) => m.userId);
      if (!ids.includes('00000000-0000-7000-8000-000000000020')) {
        foreignTeam = team.id;
        break;
      }
    }

    // No team at all — the Project Backlog, which only a WA or Project Admin may file into.
    const untearmed = await request('editor', 'POST', '/work-items', {
      projectId: NXP,
      type: 'story',
      title: `Role matrix backlog probe ${Date.now()}`,
    });
    expect(untearmed.statusCode).toBe(412);
    expect(JSON.parse(untearmed.body).error.code).toBe('WORK_ITEM_TEAM_REQUIRED');

    // Another team — refused for a different reason, and the codes must not be interchangeable.
    let foreignStatus: number | undefined;
    if (foreignTeam) {
      const created = await request('editor', 'POST', '/work-items', {
        projectId: NXP,
        type: 'story',
        title: `Role matrix team-scope probe ${Date.now()}`,
        teamId: foreignTeam,
      });
      foreignStatus = created.statusCode;
      expect(created.statusCode).toBe(403);
      expect(JSON.parse(created.body).error.code).toBe('TEAM_NOT_IN_SCOPE');
    }

    MATRIX.push({
      srs: '§3.2:92',
      surface: 'Editor team scope',
      action: foreignTeam
        ? 'create with no team, and in a team the Editor is not on'
        : 'create with no team (no foreign team available in the fixture)',
      route: 'POST /work-items',
      code: 'work_item:create',
      expected: { wa: 'allow', admin: 'allow', editor: 'deny', none: 'deny' },
      measured: { editor: foreignStatus ?? untearmed.statusCode },
      mismatches: [],
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Feeds an Editor reads BENEATH a surface §3.2 hides — declared splits
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Each of these is the reference half of a §3.2 row whose GRID is Hidden for an Editor, and each is
   * a DELIBERATE decision recorded elsewhere — not drift. They are measured here so the audit table
   * shows the whole Editor surface rather than only the refusals:
   *
   *   • `/iterations/options` + `/assignable` — §3.2:80 gives the Editor `Iteration Status | View and
   *     update`, and that screen's picker, the Backlog's iteration filter, Team Status's picker and
   *     Quality's all read them. `timebox:view` is what hides the RECORD list above.
   *   • `/releases/options` — an Editor may already write `PUT :id/milestones` and read the Backlog's
   *     Release column, so the picker has to populate; the authority to MOVE an item between releases
   *     is refused separately (`assertMayAssignRelease`, measured below).
   *   • `/milestones/options` — same shape; `PUT /work-items/:id/milestones` is `work_item:edit`.
   *   • `/portfolio-items/options` — the `Feature` field on a Story. THE BA IS SILENT on whether an
   *     Editor may set it; §5.2:124 makes that field the only way Feature membership is ever set and
   *     §3.2:79 gives them the Story, so this is a declared reading put to the BA. Release is decided
   *     the OTHER way and says so in words (BL §8:294), which is why that one is refused.
   */
  it('reference feeds stay open to an Editor beneath the grids §3.2 hides (declared splits)', async () => {
    for (const [surface, route, url, code] of [
      [
        'Iterations',
        'GET /iterations/options',
        `/iterations/options?projectId=${NXP}`,
        'iteration:view',
      ],
      [
        'Iterations',
        'GET /iterations/assignable',
        `/iterations/assignable?projectId=${NXP}`,
        'iteration:view',
      ],
      ['Releases', 'GET /releases/options', `/releases/options?projectId=${NXP}`, 'project:view'],
      [
        'Milestones',
        'GET /milestones/options',
        `/milestones/options?projectId=${NXP}`,
        'project:view',
      ],
      [
        'Portfolio Items',
        'GET /portfolio-items/options',
        `/portfolio-items/options?projectId=${NXP}`,
        'work_item:view',
      ],
    ] as const) {
      assertMatches(
        await probe(
          {
            srs: '(declared split)',
            surface: `${surface} reference feed`,
            action: 'view',
            route,
            code,
            expected: EDITOR_UP,
          },
          (role) => get(role, url),
        ),
      );
    }
  });

  /**
   * `GET /work-items/by-key` — the SOLE resolver behind `/item/$itemKey`, so every notification click
   * and every ID cell goes through it. It carried `workspace:view` (admin-reserved), which 403'd both
   * non-admin levels for an item they may read; it now carries no decorator at all, because an item
   * key is workspace-unique and the owning project is unknown until the row loads. The service
   * resolves it and then asserts `work_item:view` on THAT project — which is what this measures.
   */
  it('the item-key resolver serves every granted level and refuses No Access', async () => {
    const story = await request('wa', 'GET', `/work-items/${SEEDED.nxp.storyId}`);
    const itemKey = (JSON.parse(story.body) as { itemKey: string }).itemKey;
    assertMatches(
      await probe(
        {
          srs: '§3.2:79',
          surface: 'Item key resolver',
          action: 'view',
          route: 'GET /work-items/by-key',
          code: '(in-service: resolve then work_item:view)',
          expected: EDITOR_UP,
        },
        (role) => get(role, `/work-items/by-key?itemKey=${itemKey}`),
      ),
    );
  });

  /**
   * BL §8:294 — an Editor "cannot assign Release". Outside §3.1/§3.2, and decided the OPPOSITE way to
   * the `Feature` field: the BA wrote a sentence for this one.
   *
   * FIELD-level, not route-level: `PATCH /work-items/:id` is gated on `work_item:edit`, which an
   * Editor holds for every other field in the same body, and the refusal fires only when the patch
   * actually MOVES the release (`assertMayAssignRelease` → `release:view`). So each principal patches
   * a story THEY created, which has no release yet — an unrelated edit on an item already in a
   * release must not be refused, and that asymmetry is the reason a shared fixture row cannot measure
   * this.
   */
  it('BL §8:294 — an Editor may edit a Story but may not move it into a Release', async () => {
    assertMatches(
      await probe(
        {
          srs: 'BL §8:294',
          surface: 'Work item Release field',
          action: 'assign release',
          route: 'PATCH /work-items/:id { releaseId }',
          code: 'work_item:edit + release:view (field-level)',
          expected: ADMIN_UP,
        },
        async (role) => {
          const created = await request(role, 'POST', '/work-items', {
            projectId: NXP,
            type: 'story',
            title: `Role matrix release probe ${role} ${Date.now()}`,
          });
          if (created.statusCode >= 300) {
            // No Access cannot create; measure the field on a seeded row instead. A refusal writes
            // nothing, and this principal is refused at the guard before the field is looked at.
            return (
              await request(role, 'PATCH', `/work-items/${SEEDED.nxp.storyId}`, {
                releaseId: SEEDED.nxp.secondReleaseId,
              })
            ).statusCode;
          }
          const { id } = JSON.parse(created.body) as { id: string };
          const patched = await request(role, 'PATCH', `/work-items/${id}`, {
            releaseId: SEEDED.nxp.releaseId,
          });
          const removed = await request(role, 'DELETE', `/work-items/${id}`);
          expect(removed.statusCode, `cleanup of the release probe row for ${role}`).toBeLessThan(
            300,
          );
          return patched.statusCode;
        },
      ),
    );
  });

  /**
   * `GET /workspaces/:id/member-options` — the company picker feed, split off the User Management
   * roster (RBE-07) so that gating the roster on `workspace:view` did not empty every owner picker.
   * It carries NO permission code and is scoped in the service by `listReadableProjectIds`.
   *
   * §3.1:62 hides `View company Users` from everyone but a Workspace Admin, and the ADMINISTRATIVE
   * roster honours that (measured above). This feed is the other half, and the BA writes no row for
   * it — so it is recorded as SILENT, with the row COUNT measured, because "200" and "200 with the
   * whole company directory in it" are very different answers. That distinction is the whole reason
   * the count is asserted and not just the status: this test is what caught the feed returning 1149
   * rows to a per-project Editor, and it is what now holds the narrowing in place.
   */
  it('BA SILENT — the company picker feed answers everyone, scoped by readable projects', async () => {
    const counts: Partial<Record<Role, number>> = {};
    const statuses: Partial<Record<Role, number>> = {};
    for (const role of ROLES) {
      const res = await request(role, 'GET', `/workspaces/${WORKSPACE_ID}/member-options`);
      statuses[role] = res.statusCode;
      const body = JSON.parse(res.body) as unknown;
      counts[role] = Array.isArray(body)
        ? body.length
        : ((body as { data?: unknown[] }).data ?? []).length;
    }
    MATRIX.push({
      srs: '(silent)',
      surface: 'Company picker feed',
      action: `view (rows: ${ROLES.map((r) => `${r}=${counts[r]}`).join(' ')})`,
      route: 'GET /workspaces/:id/member-options',
      code: '(in-service: listReadableProjectIds)',
      expected: { wa: 'allow', admin: 'allow', editor: 'allow', none: 'allow' },
      measured: statuses,
      mismatches: [],
    });
    expect(statuses.none, 'the picker feed answers rather than 403ing').toBe(200);
    expect(
      counts.none,
      'a No Access principal must see NOBODY — the feed is scoped by readable projects, and an ' +
        'unscoped answer here is the company directory reached through a picker',
    ).toBe(0);
    /**
     * An Editor sees STRICTLY FEWER than a Workspace Admin, and both bounds matter.
     *
     * It used to be `toBe(counts.wa)` — an assertion that recorded the leak rather than refusing it,
     * which was right while the fix was out of scope and is wrong now that it is not. Fewer, because
     * §3.1:62 hides the company user list from them; more than none, because their own project's
     * members are what the Projects list renders as owner names, and an emptied picker is the
     * regression the roster split (RBE-07) already caused once.
     */
    expect(counts.editor, 'an Editor must not receive the company directory').toBeLessThan(
      counts.wa ?? 0,
    );
    expect(counts.editor, 'nor an empty picker — their own project has members').toBeGreaterThan(0);
  });

  /**
   * THE ONE MEASURED MISMATCH IN THE "a role can do what the BA hides" DIRECTION — NOW CLOSED.
   *
   * This landed as `it.fails` with the note below, on the reasoning that an assertion carrying the
   * BA's rule is worth more failing than weakened. The feed was then narrowed and the marker came
   * off, so the spec now holds the fix instead of describing its absence.
   *
   * §3.1:62 `View company Users | Edit | Hidden | Hidden | Hidden`. `listMemberOptions` uses
   * `listReadableProjectIds` as a BINARY gate — "does this caller have ANY readable project?" — and
   * then returns `memberRepo.listMemberOptions(workspaceId)`, the whole workspace. So a per-project
   * Editor reads every company user's `displayName` and `email`, the same count a Workspace Admin
   * gets. `db/permissions.catalog.ts` describes this route as "scoped in the service by
   * `listReadableProjectIds`", which is true of the gate and false of the projection — the same shape
   * as the Team Status comment that claimed a parity it only half had.
   *
   * HOW IT WAS FIXED, since "narrow it" was not obviously available. The note that shipped with the
   * route argued the population could NOT be narrowed, because `project_members` alone cannot name a
   * project's owner — §2.1 (migration 0118) keeps a Workspace Admin off every roster, and a WA is
   * exactly who tends to own a project. That half was true; the conclusion was not. The population is
   * now the UNION of what a readable project actually references — its active members AND its lead —
   * which resolves every owner the reader can see by construction and still stops being a directory.
   *
   * The route stays 200 rather than becoming a 403: it is the picker feed for surfaces an Editor may
   * legitimately read (the Projects list gives them owner NAMES under §3.1:70 "Read-only, scoped"), so
   * refusing it would empty a column they are entitled to — the trap that made the first roster fix a
   * regression (RBE-07). Reduce the population, not the audience.
   */
  it('§3.1:62 — an Editor reads only the people their own projects reference', async () => {
    const res = await request('editor', 'GET', `/workspaces/${WORKSPACE_ID}/member-options`);
    expect(res.statusCode).toBe(200);
    const rows = JSON.parse(res.body) as Array<{ userId: string; email?: string }>;
    const wa = JSON.parse(
      (await request('wa', 'GET', `/workspaces/${WORKSPACE_ID}/member-options`)).body,
    ) as unknown[];

    // Strictly fewer than the company directory a Workspace Admin sees. Measured at the time of
    // writing: 1105 for a WA against a handful for the Editor.
    expect(rows.length).toBeLessThan(wa.length);
    // …and NOT empty, which is the other way this could be "fixed" and would be a regression: the
    // Editor's own project has members, and their names are what the Projects list renders.
    expect(rows.length).toBeGreaterThan(0);
    // The project's LEAD resolves too, even though §2.1 keeps a Workspace Admin off the roster — the
    // union's whole purpose, and the reason a roster-only narrowing was rejected.
    expect(rows.some((r) => r.userId === ADMIN_USER_ID)).toBe(true);
  });
});
