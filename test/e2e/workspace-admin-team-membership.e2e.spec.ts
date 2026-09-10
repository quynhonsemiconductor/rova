/**
 * A WORKSPACE ADMIN MAY BE A TEAM MEMBER — operational scope only (BA feature, 2026-08-20).
 *
 * This reverses half of §2.1, and the half it does NOT reverse is what most of this file is about: a
 * Workspace Admin still holds no `work.project_members` row, so adding them to a Team must write the
 * roster row and nothing else. Their authority already comes from the workspace-wide grant, which is
 * why AC4's "Team membership does not convert their access to Admin or Editor" is a claim about what
 * is ABSENT after the write — and absence is exactly what a unit test with a mocked grant writer
 * cannot prove. Hence real HTTP against a real database.
 *
 * IT CREATES ITS OWN TEAM, and that is not tidiness. The seed puts the Workspace Admin on Team Alpha,
 * and `project-access-team-rule.e2e.spec.ts` ASSERTS that membership as the precondition of its
 * rollback proof — so an earlier version of this file, which removed the admin from Alpha in
 * `beforeAll`, passed alone and broke that spec in a full run. Same shape as the fixture leaks
 * CLAUDE.md records: a shared fixture is not a scratch pad. Creating a team also makes AC2's evidence
 * stronger than a seeded absence, because a team that has just been created with no members named is
 * exactly the case "not automatically a Team member" is about.
 *
 * Bearer token from `AuthService.devLogin`: Bearer callers are CSRF-exempt by design, and the test app
 * has no `/v1` prefix and no cookie plugin (`reply.setCookie is not a function`).
 */
import 'reflect-metadata';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AuthService, EntraTokenVerifier, type EntraClaims } from '@quynhonsemiconductor/identity';
import { AccessService } from '@modules/access';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { randomUUID } from 'crypto';

import { AppModule } from '../../apps/api/src/app.module';
import { ADMIN_USER_ID, DEVELOPER_ID, SEED_PROJECTS, WORKSPACE_ID } from '../../db/seeds/constants';
import { SSO_EMAIL_DOMAIN, SSO_TENANT_ID } from './support/sso-env';

const NXP = SEED_PROJECTS[0].id;

interface RosterRow {
  userId: string;
  isWorkspaceAdmin: boolean;
  displayName: string | null;
}

describe('a Workspace Admin as a Team member', () => {
  let app: NestFastifyApplication;
  let token: string;
  let access: AccessService;
  /** This file's OWN team — never a seeded one. See the docblock. */
  let teamId: string;

  const as = (
    method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
    url: string,
    payload?: Record<string, unknown>,
  ) => app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });

  const roster = async (): Promise<RosterRow[]> =>
    (await as('GET', `/teams/${teamId}/members`)).json();

  /** User ids out of any picker/roster payload, typed once so the assertions stay readable. */
  const userIdsOf = (body: unknown): string[] =>
    (body as Array<{ userId: string }>).map((m) => m.userId);

  /**
   * The Project `Users & Permissions` roster as served.
   *
   * Since 2026-08-21 it CONTAINS the Workspace Admin — as a synthesized, read-only row flagged
   * `isWorkspaceAdmin` — so presence here no longer says anything about §2.1. The rule is now checked
   * two ways: the row must carry the flag and no access level, and
   * `AccessService.getProjectAccessLevel` must still resolve `null` (no `work.project_members` record).
   */
  const projectAccessRows = async (): Promise<
    Array<{ userId: string; isWorkspaceAdmin?: boolean; accessLevel: string | null }>
  > => {
    const res = await as('GET', `/projects/${NXP}/members`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // So this file can JIT-provision an outsider through `ssoLogin` — the only path that creates a
      // workspace member with NO project access, which is the candidate the refusal is about. Same
      // override `directory-team-authz.e2e.spec.ts` uses.
      .overrideProvider(EntraTokenVerifier)
      .useValue({
        verify: async (idToken: string): Promise<EntraClaims> => JSON.parse(idToken) as EntraClaims,
      })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    token = (await app.get(AuthService).devLogin('admin@qnsc.dev')).accessToken;
    access = app.get(AccessService);

    // `varchar(10)`, uppercase, and unique per run — a fixed key would collide with itself on the
    // second run, since a team cannot be deleted (only deactivated, DB design §488).
    const key = `W${randomUUID().replace(/-/g, '').slice(0, 9).toUpperCase()}`;
    const created = await as('POST', `/workspaces/${WORKSPACE_ID}/teams`, {
      name: `WA membership ${key}`,
      key,
      projectIds: [NXP],
      // One ORDINARY member, named explicitly. It gives the badge something to contrast against, and
      // it makes AC2 sharper: a team created WITH a member still does not enrol the admin.
      memberUserIds: [DEVELOPER_ID],
    });
    expect(created.statusCode, created.body).toBe(201);
    teamId = created.json().id;
  }, 60_000);

  afterAll(async () => {
    // Deactivated rather than left active: the team picker and `GET /projects/:id/teams` are populations
    // other specs measure, and an archived team keeps its history (§488) so nothing is destroyed.
    await as('DELETE', `/teams/${teamId}/members/${ADMIN_USER_ID}`);
    await as('PATCH', `/teams/${teamId}`, { status: 'archived' });
    await app?.close();
  });

  it('is NOT a member until someone says so (AC2)', async () => {
    expect((await roster()).map((m) => m.userId)).not.toContain(ADMIN_USER_ID);
  });

  it('is added, and the roster badges them rather than showing a level (AC1)', async () => {
    const added = await as('POST', `/teams/${teamId}/members`, { userId: ADMIN_USER_ID });

    expect(added.statusCode).toBe(201);
    expect(added.json().isWorkspaceAdmin).toBe(true);

    const row = (await roster()).find((m) => m.userId === ADMIN_USER_ID);
    expect(row).toBeDefined();
    expect(row?.isWorkspaceAdmin).toBe(true);
    // The badge is only meaningful if the ordinary members are distinguishable from it.
    expect((await roster()).some((m) => !m.isWorkspaceAdmin)).toBe(true);
  });

  it('gains NO project-access assignment from the membership (AC1/AC4)', async () => {
    await as('POST', `/teams/${teamId}/members`, { userId: ADMIN_USER_ID });

    // RBE-06 grants `editor` from a roster row for everyone else; for a Workspace Admin the grant
    // writer skips, because §2.1 says they are not a Project user. This is the assertion that the
    // reversal did not take the other half with it — and it is now made on the LEVEL, not on absence
    // from the roster, because the roster displays them on purpose (see `projectAccessRows`).
    const row = (await projectAccessRows()).find((r) => r.userId === ADMIN_USER_ID);
    expect(row?.isWorkspaceAdmin).toBe(true);
    expect(row?.accessLevel).toBeNull();
    expect(await access.getProjectAccessLevel(WORKSPACE_ID, ADMIN_USER_ID, NXP)).toBeNull();
  });

  /**
   * A team roster row is project-scoped work, so the candidate must already belong to a project the
   * team serves (BA report 2026-08-21: "Backend validation must also reject adding a user who does not
   * belong to the Project"). The picker was narrowed in the same change; this is the half a narrowed
   * picker cannot provide.
   */
  it("refuses a workspace user who belongs to none of the team's projects", async () => {
    /**
     * A JIT-provisioned SSO principal is the honest outsider — `devLogin` cannot be used, it refuses
     * an address with no account ("No active account exists for this email"). `ssoLogin` provisions
     * the user and its workspace membership, and under the 3-level model grants no project access at
     * all, so this is a legitimate workspace member with nothing in `work.project_members`: exactly
     * the candidate the BA found being offered. A fresh address per run, never a shared fixture —
     * `work.project_members` survives to the next reset, so touching a seeded user is a lasting edit
     * other specs measure.
     */
    const label = `team-outsider-${randomUUID().slice(0, 8)}`;
    const login = await app.get(AuthService).ssoLogin(
      JSON.stringify({
        oid: `${label}-${randomUUID()}`,
        email: `${label}@${SSO_EMAIL_DOMAIN}`,
        displayName: 'E2E outsider',
        externalTenantId: SSO_TENANT_ID,
        roles: [],
      }),
      '127.0.0.1',
    );
    const outsiderId = JSON.parse(
      Buffer.from(login.accessToken.split('.')[1], 'base64url').toString(),
    ).sub as string;
    expect(await access.getProjectAccessLevel(WORKSPACE_ID, outsiderId, NXP)).toBeNull();

    const res = await as('POST', `/teams/${teamId}/members`, { userId: outsiderId });

    expect(res.statusCode).toBe(412);
    expect(res.json().error.code).toBe('TEAM_MEMBER_NOT_PROJECT_MEMBER');
    // And nothing was written on the way to the refusal.
    expect((await roster()).map((m) => m.userId)).not.toContain(outsiderId);
  });

  it('admits a Workspace Admin, who holds no project row at all', async () => {
    // The refusal above must not catch the principals §2.1 keeps off `project_members` — otherwise it
    // would close the only path to this file's own feature.
    const res = await as('POST', `/teams/${teamId}/members`, { userId: ADMIN_USER_ID });

    expect([201, 409]).toContain(res.statusCode);
  });

  it('keeps full Workspace authority while on the Team (AC4)', async () => {
    await as('POST', `/teams/${teamId}/members`, { userId: ADMIN_USER_ID });

    expect(await access.isWorkspaceAdmin(WORKSPACE_ID, ADMIN_USER_ID)).toBe(true);
    // Read through the permission resolver rather than the role table: `workspace:*` is what actually
    // grants, and a project-tier code proves the grant still reaches project surfaces.
    expect(
      await access.hasProjectPermission(
        { sub: ADMIN_USER_ID, workspaceId: WORKSPACE_ID } as never,
        NXP,
        'work_item:edit',
      ),
    ).toBe(true);
  });

  it('is selectable as a Work Item Owner in that Team (AC3)', async () => {
    await as('POST', `/teams/${teamId}/members`, { userId: ADMIN_USER_ID });

    const res = await as('GET', `/projects/${NXP}/member-options?teamId=${teamId}`);

    expect(res.statusCode).toBe(200);
    expect(userIdsOf(res.json())).toContain(ADMIN_USER_ID);
  });

  it('is selectable as a Project Owner whether or not they are on a Team (AC3)', async () => {
    // The workspace picker feed, which is what the Project Owner field reads.
    const res = await as('GET', `/workspaces/${WORKSPACE_ID}/member-options`);

    expect(res.statusCode).toBe(200);
    expect(userIdsOf(res.json())).toContain(ADMIN_USER_ID);
  });

  it('loses only the membership on removal (AC5)', async () => {
    await as('POST', `/teams/${teamId}/members`, { userId: ADMIN_USER_ID });

    const removed = await as('DELETE', `/teams/${teamId}/members/${ADMIN_USER_ID}`);

    expect(removed.statusCode).toBe(204);
    expect((await roster()).map((m) => m.userId)).not.toContain(ADMIN_USER_ID);
    expect(await access.isWorkspaceAdmin(WORKSPACE_ID, ADMIN_USER_ID)).toBe(true);
    expect(
      await access.hasProjectPermission(
        { sub: ADMIN_USER_ID, workspaceId: WORKSPACE_ID } as never,
        NXP,
        'work_item:edit',
      ),
    ).toBe(true);
  });

  it('reports the same membership state to every view that carries it (AC6)', async () => {
    await as('POST', `/teams/${teamId}/members`, { userId: ADMIN_USER_ID });

    const teams: Array<{ teamId: string; memberCount?: number }> = (
      await as('GET', `/projects/${NXP}/teams`)
    ).json();
    const own = teams.find((t) => t.teamId === teamId);
    const rosterSize = (await roster()).length;

    // The count beside the roster and the roster itself are the pair this repo has seen disagree
    // before (a WA hidden from one and counted by the other).
    if (own?.memberCount !== undefined) expect(own.memberCount).toBe(rosterSize);
  });
});
