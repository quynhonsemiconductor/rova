/**
 * The user DIRECTORY and the TEAM reads, over REAL HTTP, in both directions (RBE-07, RBE-08/PRJ-07).
 *
 * WHAT WAS WRONG
 *   • `GET /workspaces/:id/members-with-profile` was the codebase's single `@AuthzGap` — no
 *     authorization at all, and `PolicyGuard` ALLOWS a handler with no policy metadata. Every
 *     member's `phone`, `lastLoginAt` and role ids were readable by a per-project Editor and by a
 *     No Access principal (nobody with an active `project_members` row anywhere).
 *   • `GET /workspaces/:id/teams`, `GET /teams/:id` and `GET /teams/:id/members` carried nothing
 *     either, so every team's name, key, lead, member count, the name and key of every project it
 *     links to, and the roster's display names AND EMAILS were readable by any authenticated caller.
 *     §3.1 makes "View Project Details and Teams" a per-Project row.
 *
 * WHY THIS FILE AND NOT ONLY A SERVICE SPEC
 * The team and picker checks are `@AuthorizedInService`, so a service spec CAN see them, and
 * `libs/modules/workspace/src/application/{team,workspace}.service.spec.ts` assert the sentinels with
 * mocks. What a service spec cannot see is the GUARD: whether `workspace:view` on
 * `members-with-profile` really refuses an Editor through `PolicyGuard`, with a real cached
 * permission resolution, on the only surface a browser can reach. CLAUDE.md records that blind spot
 * twice. `test/roster-split-gate.spec.ts` reads the decorator metadata in the unit suite; this drives
 * the routes.
 *
 * BOTH DIRECTIONS, and the second is the one that matters here: over-restricting the picker feed
 * silently breaks every owner and assignee picker on Portfolio and Projects, which is exactly the
 * risk that deferred this fix once already. So each test that asserts a refusal has a sibling that
 * asserts an Editor still reads what they need.
 *
 * NOTES THAT COST SOMEONE AN HOUR BEFORE
 *   • No `/v1` prefix: `Test.createTestingModule` builds the app WITHOUT the bootstrap that sets the
 *     global prefix, so routes are mounted bare. A missing prefix reads as a 404, which must never be
 *     confused with a refusal — hence the explicit 403 / 404 / 200 assertions rather than "not 200".
 *   • No cookie plugin either, so `AuthService.devLogin` / `ssoLogin` for a bearer token rather than
 *     `bootstrapApp` (this app has no cookie plugin, `/v1` prefix or CSRF hook).
 *   • A dedicated principal per test, never `dev@qnsc.dev`: `work.project_members` survives until the
 *     next reset, so granting a shared fixture user a level is a lasting edit that has broken other
 *     specs before.
 */
import 'reflect-metadata';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../apps/api/src/app.module';
import {
  PAY_PROJECT_ID,
  SEED_PROJECTS,
  TEAM_ALPHA_ID,
  TEAM_BETA_ID,
  TEAM_GAMMA_ID,
  WORKSPACE_ID,
} from '../../db/seeds/constants';
import { grantProjectAccess } from './support/flow-harness';
import { provisionUser, signIn } from './support/session';

const NXP = SEED_PROJECTS[0].id;

const DIRECTORY = `/workspaces/${WORKSPACE_ID}/members-with-profile`;
const PICKER = `/workspaces/${WORKSPACE_ID}/member-options`;
const TEAM_LIST = `/workspaces/${WORKSPACE_ID}/teams`;

interface MemberOption {
  userId: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
  /**
   * The DECISION a picker needs — whether this person may be offered as a new owner — not the
   * `workspace_members.status` it derives from. See the field's docblock on `WorkspaceMemberOption`:
   * the raw status put a colleague's account state (`active | suspended | removed`) on the one feed in
   * the product with no permission code, read by every delivery participant and consumed by no client.
   */
  assignable: boolean;
}
interface TeamRow {
  id: string;
  projects: { projectId: string; key: string; name: string }[];
}

describe('user directory and team reads: authorization over HTTP (e2e)', () => {
  let app: NestFastifyApplication;

  function get(url: string, accessToken: string) {
    return app.inject({ method: 'GET', url, headers: { cookie: accessToken } });
  }

  /**
   * A brand-new SSO principal, which under the 3-level model is NO ACCESS: `ensureDefaultRole` is a
   * no-op and migration 0111 deleted the workspace-scoped tier assignments, so this user holds no
   * grant anywhere until one is written. That is the negative principal the two findings describe.
   */
  async function newPrincipal(label: string): Promise<{ token: string; userId: string }> {
    const login = await provisionUser(app, `${label}`, `E2E ${label}`);
    const userId = login.userId;
    return { token: login.accessToken, userId };
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

  // ── RBE-07: the roster split ───────────────────────────────────────────────

  it('REFUSES the User Management roster to a No Access principal and to an Editor', async () => {
    const nobody = await newPrincipal('no-access-directory');
    // 403, not 401: the caller is authenticated and identified — it is the PERMISSION that is
    // missing. A 401 here would mean the guard order regressed.
    expect((await get(DIRECTORY, nobody.token)).statusCode).toBe(403);

    const editor = await newPrincipal('editor-directory');
    await grantProjectAccess(app, editor.userId, NXP, 'editor');
    expect((await get(DIRECTORY, editor.token)).statusCode).toBe(403);
  });

  it('REFUSES the User Management roster to a per-project Admin too', async () => {
    // §3.1 keeps the company roster with the Workspace Admin; `phone` and `lastLoginAt` are not
    // delivery data, and a per-project Admin is a delivery role.
    const admin = await newPrincipal('admin-directory');
    await grantProjectAccess(app, admin.userId, NXP, 'admin');

    expect((await get(DIRECTORY, admin.token)).statusCode).toBe(403);
  });

  it('ALLOWS the User Management roster to a Workspace Admin, with the sensitive fields', async () => {
    // The other direction: a gate on a code nobody holds would break Settings > Members rather than
    // protect it. Asserting a field, not just the status, so a future response-shape change that
    // dropped the reason this route is gated at all is visible here.
    const wa = { accessToken: await signIn(app, 'admin@qnsc.dev') };

    const response = await get(DIRECTORY, wa.accessToken);

    expect(response.statusCode).toBe(200);
    const rows = response.json<Record<string, unknown>[]>();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty('lastLoginAt');
    expect(rows[0]).toHaveProperty('roleSlug');
  });

  it('ALLOWS the picker feed to an Editor, at the four display fields and no more', async () => {
    /**
     * The assertion that stops this fix from being "gate the roster and move on". Every owner and
     * assignee picker on Portfolio and Projects reads this feed, and an Editor must be able to
     * resolve a person to a name.
     */
    const editor = await newPrincipal('editor-picker');
    await grantProjectAccess(app, editor.userId, NXP, 'editor');

    const response = await get(PICKER, editor.token);

    expect(response.statusCode).toBe(200);
    const rows = response.json<MemberOption[]>();
    expect(rows.length).toBeGreaterThan(0);
    /**
     * An EXACT key set, both directions — the assertion that catches a field JOINING the feed, which
     * is how this one drifted: it shipped with a fifth field, the raw `workspace_members.status`,
     * while the schema's own docblock said "four display fields and nothing else". `assignable` is
     * that field's replacement — the decision (may a picker offer this person?) rather than the
     * account state it comes from, so an inactive member still resolves to a NAME for an item they
     * already own without their status being disclosed to everyone who can see a project.
     */
    expect(Object.keys(rows[0]).sort()).toEqual([
      'assignable',
      'avatarUrl',
      'displayName',
      'email',
      'userId',
    ]);
  });

  it('gives the picker feed NOBODY to a No Access principal — scoped, not merely denied', async () => {
    /**
     * `[]`, not 403: the scope is `listReadableProjectIds`, whose empty array means "no project, so
     * no colleagues", and a picker with nothing to offer is the honest rendering of that. What must
     * NOT happen is the pre-fix behaviour — the whole company roster.
     */
    const nobody = await newPrincipal('no-access-picker');

    const response = await get(PICKER, nobody.token);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  // ── RBE-08 / PRJ-07: the team reads ────────────────────────────────────────

  it('gives an Editor the teams of the project they can read, and NOT another project’s', async () => {
    // Alpha and Beta are linked to NXP; Gamma only to PAY. Both directions in one assertion.
    const editor = await newPrincipal('editor-teams');
    await grantProjectAccess(app, editor.userId, NXP, 'editor');

    const response = await get(TEAM_LIST, editor.token);

    expect(response.statusCode).toBe(200);
    const ids = response.json<TeamRow[]>().map((t) => t.id);
    expect(ids).toContain(TEAM_ALPHA_ID);
    expect(ids).toContain(TEAM_BETA_ID);
    expect(ids).not.toContain(TEAM_GAMMA_ID);
  });

  it('does not leak an unreadable project’s key through a team’s projects array', async () => {
    /**
     * A team may be linked to several projects, so the row itself passing the filter is not enough —
     * the nested `projects` array carries every linked project's KEY and NAME, which is the same leak
     * one field deeper. Asserted over EVERY returned row rather than a named team, so the property
     * holds for any team a future seed links to two projects: a PAY-only Editor must never read NXP's
     * key or name, from any field.
     */
    const editor = await newPrincipal('editor-team-projects');
    await grantProjectAccess(app, editor.userId, PAY_PROJECT_ID, 'editor');

    const response = await get(TEAM_LIST, editor.token);

    expect(response.statusCode).toBe(200);
    for (const team of response.json<TeamRow[]>()) {
      expect(team.projects.map((p) => p.projectId)).toEqual([PAY_PROJECT_ID]);
    }
  });

  it('gives a No Access principal NO team at all', async () => {
    const nobody = await newPrincipal('no-access-teams');

    const response = await get(TEAM_LIST, nobody.token);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it('gives a Workspace Admin every team (null = UNRESTRICTED)', async () => {
    const wa = { accessToken: await signIn(app, 'admin@qnsc.dev') };

    const response = await get(TEAM_LIST, wa.accessToken);

    expect(response.statusCode).toBe(200);
    const ids = response.json<TeamRow[]>().map((t) => t.id);
    expect(ids).toContain(TEAM_ALPHA_ID);
    expect(ids).toContain(TEAM_GAMMA_ID);
  });

  it('404s a team detail and roster the reader cannot reach, and serves the ones they can', async () => {
    /**
     * 404 rather than 403 on purpose: a surface that hides a row from the list and then confirms its
     * existence on the detail route has not hidden it. The roster matters most — the repository joins
     * `identity.users`, so it carries every member's display name AND EMAIL, which is the directory
     * leak of RBE-07 reached through a team id instead.
     */
    const editor = await newPrincipal('editor-team-detail');
    await grantProjectAccess(app, editor.userId, NXP, 'editor');

    expect((await get(`/teams/${TEAM_ALPHA_ID}`, editor.token)).statusCode).toBe(200);
    expect((await get(`/teams/${TEAM_ALPHA_ID}/members`, editor.token)).statusCode).toBe(200);

    expect((await get(`/teams/${TEAM_GAMMA_ID}`, editor.token)).statusCode).toBe(404);
    expect((await get(`/teams/${TEAM_GAMMA_ID}/members`, editor.token)).statusCode).toBe(404);
  });

  it('404s every team detail for a No Access principal', async () => {
    const nobody = await newPrincipal('no-access-team-detail');

    expect((await get(`/teams/${TEAM_ALPHA_ID}`, nobody.token)).statusCode).toBe(404);
    expect((await get(`/teams/${TEAM_ALPHA_ID}/members`, nobody.token)).statusCode).toBe(404);
  });
});
