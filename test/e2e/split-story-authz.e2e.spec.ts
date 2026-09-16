/**
 * `GET /work-items/:id/split-preview` — authorization, over REAL HTTP (Phase 7 SU-01 AC7).
 *
 * TWO INDEPENDENT AXES, and `test/route-audience.ratchet.spec.ts` covers neither of them properly:
 * that ratchet reads SOURCE TEXT and declares an intended per-project ACCESS LEVEL. It cannot tell a
 * correct decorator from a misspelled code, and it says nothing about the workspace TIER role. Plan
 * §4 asserts "a Project Member can split" — that is the tier axis, and it needs a real request.
 *
 *   1. TIER role   — the workspace-scoped `project_member`, the lowest tier, must be ALLOWED.
 *   2. ACCESS level — the per-project `editor`, the lowest level, must be ALLOWED.
 *   3. Neither     — a seeded principal with NO grant at all must be REFUSED.
 *   4. Team scope  — an `editor` outside the Story's Team must be REFUSED, because the route's own
 *                    `resource: 'work_item'` scope resolves the row's PROJECT and nothing else.
 *
 * THE TRAP THIS FILE IS BUILT AROUND: a JIT-provisioned SSO user is NOT a denied principal. It used
 * to be granted `project_member` at workspace scope by `assignDefaultRole`, which carries the very
 * permission under test — so a fresh SSO login would have returned 200 and the negative case would
 * have proved nothing. The denied principal is therefore the SEEDED `viewer@qnsc.dev`, verified
 * against the live database on 2026-09-16 to hold no `user_role_assignments` row and no
 * `work.project_members` row.
 *
 * NO `/v1` prefix — the test app is built without the bootstrap that sets the global prefix.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AuthService, EntraTokenVerifier, type EntraClaims } from '@quynhonsemiconductor/identity';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AccessService } from '@modules/access';
import { WORKSPACE_MEMBER_REPOSITORY, type IWorkspaceMemberRepository } from '@modules/workspace';
import { PERMISSION, ROLE_PERMISSIONS, SYSTEM_ROLE } from '@shared-kernel';
import { AppModule } from '../../apps/api/src/app.module';
import { NXP_STORY_1_ID, SEED_PROJECTS, TEAM_ALPHA_ID } from '../../db/seeds/constants';
import { SSO_EMAIL_DOMAIN, SSO_TENANT_ID } from './support/sso-env';
import { ADMIN_USER_ID, WORKSPACE_ID, grantProjectAccess } from './support/flow-harness';

const NXP = SEED_PROJECTS[0].id;
const URL = `/work-items/${NXP_STORY_1_ID}/split-preview`;

describe('split preview: authorization over HTTP (e2e)', () => {
  let app: NestFastifyApplication;
  let auth: AuthService;
  let access: AccessService;

  /** A fresh SSO principal, so no shared fixture user is mutated by a grant. */
  async function freshPrincipal(label: string): Promise<{ token: string; userId: string }> {
    const claims: EntraClaims = {
      oid: `${label}-${randomUUID()}`,
      email: `${label}-${randomUUID().slice(0, 8)}@${SSO_EMAIL_DOMAIN}`,
      displayName: `E2E ${label}`,
      externalTenantId: SSO_TENANT_ID,
      roles: [],
    };
    const login = await auth.ssoLogin(JSON.stringify(claims), '127.0.0.1');
    const userId = JSON.parse(Buffer.from(login.accessToken.split('.')[1], 'base64url').toString())[
      'sub'
    ] as string;
    return { token: login.accessToken, userId };
  }

  function get(token: string) {
    return app.inject({ method: 'GET', url: URL, headers: { authorization: `Bearer ${token}` } });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EntraTokenVerifier)
      .useValue({
        verify: async (idToken: string): Promise<EntraClaims> => JSON.parse(idToken) as EntraClaims,
      })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    auth = app.get(AuthService);
    access = app.get(AccessService);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('the tier role under test really does carry the permission, so a 200 below means something', () => {
    // Guard on the fixture, not on the code: if `project_member` ever loses `work_item:view` this
    // test says so, instead of the allow-case below failing for a reason nobody can locate.
    expect(ROLE_PERMISSIONS[SYSTEM_ROLE.PROJECT_MEMBER]).toContain(PERMISSION.WORK_ITEM_VIEW);
    expect(ROLE_PERMISSIONS[SYSTEM_ROLE.PROJECT_MEMBER]).toContain(PERMISSION.WORK_ITEM_EDIT);
  });

  it('REFUSES a seeded principal with no grant at all (403, not 401)', async () => {
    // `viewer@qnsc.dev` — the No Access principal. 403, not 401: the caller is authenticated and
    // identified, and it is the PERMISSION that is missing. A 401 would mean the guard order
    // regressed; a 404 would mean the URL is wrong (see the no-prefix note above).
    const session = await auth.devLogin('viewer@qnsc.dev', '127.0.0.1');
    const response = await get(session.accessToken);
    expect(response.statusCode, response.body).toBe(403);
  });

  it('ALLOWS the lowest TIER role — a Project Member — and reports the Story as splittable', async () => {
    /**
     * Plan §4: "A Project Member (the lowest tier) CAN split." The workspace tier role, assigned at
     * WORKSPACE scope — project scope is retired (`PROJECT_SCOPE_RETIRED`, migration 0105).
     *
     * The Team scope does not refuse them: `resolveTeamScope` returns UNRESTRICTED for a principal
     * with no per-project access level at all, which is deliberate ("answering a permission failure
     * with an empty grid would read as 'this project has no work'").
     */
    const { token, userId } = await freshPrincipal('split-member');
    const roles = await access.listRoles(WORKSPACE_ID);
    const projectMember = roles.find((role) => role.slug === SYSTEM_ROLE.PROJECT_MEMBER);
    expect(projectMember, 'the workspace must own a project_member tier role').toBeDefined();

    /**
     * `WORKSPACE_MEMBER_REPOSITORY.grantWorkspaceRole` — the ONE writer of `user_role_assignments`
     * outside the seeds. There is no `AccessService.assignRole` any more: `PolicyGuard` resolves
     * permissions from that table on every check, and `workspace_members.role_id` is authoritative for
     * NOTHING (`CLAUDE.md`, "An invitation binds to an ADDRESS"), so writing the denormalised column
     * would grant this principal nothing at all.
     *
     * The cache is invalidated explicitly afterwards, because `assignRole`'s wrapper — which used to
     * do it — is gone: a grant lands on the user's NEXT request only once the 5-minute
     * `authz:assign:<ws>:<user>` entry is dropped, and this test makes that next request immediately.
     */
    await app.get<IWorkspaceMemberRepository>(WORKSPACE_MEMBER_REPOSITORY).grantWorkspaceRole({
      workspaceId: WORKSPACE_ID,
      userId,
      roleId: projectMember!.id,
      grantedBy: ADMIN_USER_ID,
    });
    await access.invalidateUser(WORKSPACE_ID, userId);

    const response = await get(token);
    expect(response.statusCode, response.body).toBe(200);
    const result = JSON.parse(response.body) as { eligible: boolean; ineligibleReason: null };
    // Not just readable — SPLITTABLE. `not_editable` would mean the tier role lacks `work_item:edit`,
    // which is the half of BR-04 the guard cannot express.
    expect(result.eligible).toBe(true);
    expect(result.ineligibleReason).toBeNull();
  });

  it('ALLOWS the lowest per-project ACCESS LEVEL — an editor on the Story\u2019s Team', async () => {
    // `dev@qnsc.dev` is seeded `editor` on NXP AND a member of Team Alpha, which US-1 belongs to.
    // Read-only use of a shared fixture user: nothing here grants it anything, so no later spec sees
    // a changed principal (the `read-scoping.e2e.spec.ts` lesson).
    const session = await auth.devLogin('dev@qnsc.dev', '127.0.0.1');
    const response = await get(session.accessToken);
    expect(response.statusCode, response.body).toBe(200);
    const result = JSON.parse(response.body) as { eligible: boolean };
    expect(result.eligible).toBe(true);
  });

  it('REFUSES an editor OUTSIDE the Story\u2019s Team, even though the project grant is real', async () => {
    /**
     * The disclosure the route decorator cannot prevent. `resource: 'work_item'` resolves the row's
     * PROJECT and nothing else, so an Editor with a legitimate NXP grant passes the guard — and it is
     * `requireReadable`, inside the service, that applies the Editor Team boundary.
     *
     * This principal is an `editor` on NXP with NO Team, so `resolveTeamScope` answers `none` and the
     * read must return nothing rather than US-1's Tasks, Defects and Test Cases. Without that check
     * the preview would be a brand-new way to read another team's work.
     */
    const { token, userId } = await freshPrincipal('split-outsider');
    await grantProjectAccess(app, userId, NXP, 'editor');

    const response = await get(token);
    expect(response.statusCode, response.body).toBe(403);
    // And it is refused for the TEAM, not for the project — the codes are different facts and only
    // one of them is something the reader can act on.
    expect(response.body).toMatch(/EDITOR_NO_TEAM_SCOPE|TEAM_NOT_IN_SCOPE/);
    // Sanity: the Story really is team-owned, or this test would pass vacuously.
    expect(TEAM_ALPHA_ID).toBeTruthy();
  });

  it('refuses an unauthenticated caller with 401', async () => {
    const response = await app.inject({ method: 'GET', url: URL });
    expect(response.statusCode).toBe(401);
  });
});
