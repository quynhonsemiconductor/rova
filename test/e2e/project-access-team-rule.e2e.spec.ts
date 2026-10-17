/**
 * PRJ-08 over HTTP: an Editor must have at least one Team, and the combined write is ATOMIC.
 *
 * The rule is `assertTeamAssignmentForLevel` in `libs/modules/access/src/domain/project-access.ts`,
 * reached through `ProjectsService.setProjectAccess` behind `POST /projects/:id/members`. §2.2 states
 * it ("Editor must be assigned to at least one active Team"), so does the §2.2 level table ("One
 * assigned Project and one or more explicitly assigned Teams") and
 * `00_Documents/mini_rally_usecase_role_mapping.md:81`.
 *
 * WHY THIS EXISTS ALONGSIDE THE UNIT SPEC. `projects.service.spec.ts` covers all four cases against a
 * STUB transaction, and a stub cannot prove a rollback — `uow.run` there just invokes the callback, so
 * "the level did not land" is only ever "the mock was not called". The whole point of the combined
 * endpoint is that the level and the team rows share one real transaction, and the only way to see
 * that is to make a write fail against a real database and then look at the rows. That is the last
 * test in this file.
 *
 * THE TEAMLESS-PROJECT EXEMPTION IS NOT HERE, deliberately: neither seeded project is teamless (the
 * demo seed links Alpha and Beta to NXP, and `second-project.ts` links one to PAY), and creating a
 * project would push `test/e2e-fixtures.ratchet.spec.ts`'s `createProject` cap — a ratchet that may
 * only fall — for a branch of a pure function the unit spec already pins in both directions.
 *
 * No `/v1` prefix: `Test.createTestingModule` builds the app WITHOUT the bootstrap that sets the
 * global prefix. Sessions come from identity's test-login (`support/session.ts`); this app has no CSRF hook
 * (that is `bootstrapApp`'s), so there is no token dance.
 *
 * THE REFUSAL IS 412, NOT 422. `PreconditionFailedException` maps to `PRECONDITION_FAILED` → 412 in
 * `@quynhonsemiconductor/platform-http`, while every route in this repo declares `@ApiCommonErrors(…, 422)` for a
 * business-rule violation — `HttpErrorCode` in `libs/platform/src/auth/decorators.ts` does not even
 * admit 412. That mismatch is pre-existing and repo-wide (every `PreconditionFailedException` route
 * has it); asserted here as the RUNTIME status so this spec pins what the API actually answers rather
 * than what its Swagger claims.
 */
import { randomUUID } from 'node:crypto';

import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../apps/api/src/app.module';
import {
  ADMIN_USER_ID,
  SEED_PROJECTS,
  TEAM_ALPHA_ID,
  TEAM_BETA_ID,
} from '../../db/seeds/constants';
import { provisionUser, signIn } from './support/session';

const NXP = SEED_PROJECTS[0].id;
const MEMBERS = `/projects/${NXP}/members`;

interface ProjectMemberRow {
  userId: string;
  accessLevel: string | null;
}
interface TeamMemberRow {
  userId: string;
}

describe('PRJ-08: an Editor needs a Team, enforced over HTTP (e2e)', () => {
  let app: NestFastifyApplication;
  let waToken: string;

  function post(url: string, body: unknown) {
    return app.inject({
      method: 'POST',
      url,
      headers: { cookie: waToken },
      payload: body as Record<string, unknown>,
    });
  }

  function get(url: string) {
    return app.inject({ method: 'GET', url, headers: { cookie: waToken } });
  }

  /**
   * A brand-new SSO principal: under the 3-level model that is NO ACCESS (`ensureDefaultRole` is a
   * no-op and migration 0111 deleted the workspace-scoped tier assignments), and an active
   * `workspace_members` row — exactly the candidate the Users & Permissions screen grants a level to.
   * A fresh user per test so no assertion depends on another's leftover rows.
   */
  async function newPrincipal(label: string): Promise<string> {
    return (await provisionUser(app, `${label}`, `E2E ${label}`)).userId;
  }

  async function levelOf(userId: string): Promise<string | null | undefined> {
    const res = await get(MEMBERS);
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as ProjectMemberRow[]).find((m) => m.userId === userId)
      ?.accessLevel;
  }

  async function teamHasMember(teamId: string, userId: string): Promise<boolean> {
    const res = await get(`/teams/${teamId}/members`);
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as TeamMemberRow[]).some((m) => m.userId === userId);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    // The Workspace Admin is the only principal §3.1 lets assign project access. `admin@qnsc.dev`,
    // not `dev@qnsc.dev`: the seeded WA is `ADMIN_USER_ID`, whose address is the former, and
    // `devLogin` PROVISIONS an unknown address — so the wrong one returns a perfectly valid token for
    // a principal holding nothing, and every assertion here reads 403 instead of the status it means.
    const login = { accessToken: await signIn(app, 'admin@qnsc.dev') };
    expect(login.accessToken, 'test-login for admin@qnsc.dev').toBeTruthy();
    waToken = login.accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('REFUSES an Editor with zero teams, and writes nothing', async () => {
    const userId = await newPrincipal('prj08-refused');

    const res = await post(MEMBERS, { userId, accessLevel: 'editor', teamIds: [] });

    expect(res.statusCode).toBe(412);
    expect(JSON.parse(res.body).error.code).toBe('PROJECT_EDITOR_REQUIRES_TEAM');
    // Not merely refused — no row at all. The rule is decided before the transaction opens, so a
    // NULL-level row cannot be left behind for a later reader to interpret as membership.
    expect(await levelOf(userId)).toBeUndefined();
  });

  it('REFUSES a bare level change to Editor when the member holds no team', async () => {
    // `teamIds` ABSENT means "leave the memberships alone", so the rule is judged against the ones
    // the user already has — which is none. Absent is not the same as `[]`, and neither is accepted.
    const userId = await newPrincipal('prj08-bare');

    const res = await post(MEMBERS, { userId, accessLevel: 'editor' });

    expect(res.statusCode).toBe(412);
    expect(JSON.parse(res.body).error.code).toBe('PROJECT_EDITOR_REQUIRES_TEAM');
  });

  it('ACCEPTS an Editor with one team, writing the level AND the roster row', async () => {
    // The other direction, and the reason it matters: a rule that only ever refuses passes just as
    // well when the level has been made unusable.
    const userId = await newPrincipal('prj08-accepted');

    const res = await post(MEMBERS, {
      userId,
      accessLevel: 'editor',
      teamIds: [TEAM_ALPHA_ID],
    });

    expect(res.statusCode).toBe(201);
    expect(await levelOf(userId)).toBe('editor');
    expect(await teamHasMember(TEAM_ALPHA_ID, userId)).toBe(true);
  });

  it('ACCEPTS an Admin with zero teams — All Teams is the ABSENCE of a scope', async () => {
    // §2.2: "Admin always receives `All Teams`; individual Team selection is not shown", so an Admin
    // needs no `team_members` row and must not be asked for one.
    const userId = await newPrincipal('prj08-admin');

    const res = await post(MEMBERS, { userId, accessLevel: 'admin' });

    expect(res.statusCode).toBe(201);
    expect(await levelOf(userId)).toBe('admin');
    expect(await teamHasMember(TEAM_ALPHA_ID, userId)).toBe(false);
  });

  it('is ATOMIC against a real database: a refused level rolls the team write back', async () => {
    /**
     * The proof a stubbed transaction cannot give.
     *
     * `setProjectAccess` writes the team rows and THEN the level, in one transaction. The Workspace
     * Admin is the failure this can be provoked with over HTTP: §2.1 keeps a WA off every project
     * roster, so `grantProjectAccess` refuses with `PROJECT_MEMBER_IS_WORKSPACE_ADMIN` — after the
     * team row for Beta has already been inserted inside the same transaction. If that transaction
     * is not real, the WA is left on Team Beta by a request that returned an error.
     *
     * Alpha is included in the requested set on purpose: the WA is a seeded member of it, so the diff
     * is "add Beta, remove nothing" and a broken rollback cannot damage the shared fixture — it can
     * only leave the extra row this test then finds.
     */
    expect(await teamHasMember(TEAM_ALPHA_ID, ADMIN_USER_ID)).toBe(true);
    expect(await teamHasMember(TEAM_BETA_ID, ADMIN_USER_ID)).toBe(false);

    const res = await post(MEMBERS, {
      userId: ADMIN_USER_ID,
      accessLevel: 'editor',
      teamIds: [TEAM_ALPHA_ID, TEAM_BETA_ID],
    });

    expect(res.statusCode).toBe(412);
    expect(JSON.parse(res.body).error.code).toBe('PROJECT_MEMBER_IS_WORKSPACE_ADMIN');
    expect(await teamHasMember(TEAM_BETA_ID, ADMIN_USER_ID)).toBe(false);
    expect(await teamHasMember(TEAM_ALPHA_ID, ADMIN_USER_ID)).toBe(true);
  });

  it('refuses a team that is not linked to this project', async () => {
    // Linking a team is `POST /projects/:id/teams`, a `workspace:edit` action — a permissions write
    // must not reshape the project's delivery model as a side effect.
    const userId = await newPrincipal('prj08-foreign-team');

    const res = await post(MEMBERS, {
      userId,
      accessLevel: 'editor',
      teamIds: [randomUUID()],
    });

    expect(res.statusCode).toBe(412);
    expect(JSON.parse(res.body).error.code).toBe('PROJECT_TEAM_NOT_FOUND');
  });
});
