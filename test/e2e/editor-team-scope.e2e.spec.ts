/**
 * An EDITOR reaches only their own Teams' Work Items, and is offered only their own Teams.
 *
 * `GAP-P4-RBAC-003` (BA DEV Handoff retest 2026-08-17, Confirmed Fail, P0). §2.2 requires an Editor
 * to hold at least one active Team and to work only inside their assigned Teams; §3.2 scopes their
 * delivery edits the same way; §7 requires a direct route with no permission to answer Access Denied
 * or Not Found rather than serve restricted metadata. The retest found an Editor with NO assigned
 * Team reading another team's Story in full and being offered `All Teams`, Pegasus and RTCAP.
 *
 * OVER REAL HTTP, BOTH DIRECTIONS, because that is the only shape that can see this: CLAUDE.md
 * records twice that a spec calling a service directly cannot see a guard defect, and a
 * decorator-counting ratchet cannot tell a correct scope from one resolved off the wrong field.
 *
 * WHAT IS HERE AND WHAT IS IN THE UNIT SPEC
 * The zero-team refusal (`EDITOR_NO_TEAM_SCOPE`, AC1) is asserted in
 * `libs/modules/access/src/application/access.service.spec.ts`: expressing it here would mean
 * emptying a seeded principal's team rosters, and CLAUDE.md records that rostering choices in this
 * harness are load-bearing across FILES — the Editor principal's rosters are what
 * `server-role-matrix` and `authz-cluster` measure. This file asserts the per-row half (AC3) and the
 * picker population (AC2), both without mutating a seeded membership.
 *
 * The session cookie from identity's test-login (`support/session.ts`). The test
 * app has no `/v1` prefix and no cookie plugin (`reply.setCookie is not a function`).
 */
import 'reflect-metadata';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../apps/api/src/app.module';
import { SEED_PROJECTS, TEAM_ALPHA_ID, TEAM_BETA_ID } from '../../db/seeds/constants';
import { signIn } from './support/session';

const NXP = SEED_PROJECTS[0].id;

/**
 * `dev@qnsc.dev` is the seeded per-project Editor (`DEVELOPER_ID`), rostered on Team Alpha in NXP and
 * NOT on Team Beta — which is exactly the pair this rule is about.
 */
const EDITOR_EMAIL = 'dev@qnsc.dev';
const ADMIN_EMAIL = 'admin@qnsc.dev';

describe('Editor Team scope (GAP-P4-RBAC-003)', () => {
  let app: NestFastifyApplication;
  let editorToken: string;
  let adminToken: string;
  let alphaItemId: string;
  let betaItemId: string;

  const as = (
    token: string,
    method: 'GET' | 'PATCH' | 'POST',
    url: string,
    payload?: Record<string, unknown>,
  ) => app.inject({ method, url, headers: { cookie: token }, payload });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    editorToken = await signIn(app, EDITOR_EMAIL);
    adminToken = await signIn(app, ADMIN_EMAIL);

    // Built by the ADMIN, so the fixture itself never depends on the rule under test.
    const alpha = await as(adminToken, 'POST', '/work-items', {
      projectId: NXP,
      type: 'story',
      title: 'RBAC-003 Alpha story',
      teamId: TEAM_ALPHA_ID,
    });
    expect(alpha.statusCode).toBe(201);
    alphaItemId = alpha.json().id;

    const beta = await as(adminToken, 'POST', '/work-items', {
      projectId: NXP,
      type: 'story',
      title: 'RBAC-003 Beta story',
      teamId: TEAM_BETA_ID,
    });
    expect(beta.statusCode).toBe(201);
    betaItemId = beta.json().id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('lets the Editor read an item in their OWN Team', async () => {
    const res = await as(editorToken, 'GET', `/work-items/${alphaItemId}`);

    expect(res.statusCode).toBe(200);
    expect(res.json().teamId).toBe(TEAM_ALPHA_ID);
  });

  it('REFUSES an item belonging to a Team they are not assigned to (AC3)', async () => {
    const res = await as(editorToken, 'GET', `/work-items/${betaItemId}`);

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('TEAM_NOT_IN_SCOPE');
    // §7: no restricted metadata rides along on the refusal.
    expect(JSON.stringify(res.json())).not.toContain('RBAC-003 Beta story');
  });

  it('refuses the same item through the ITEM KEY route, which is what /item/:key resolves', async () => {
    const key = (await as(adminToken, 'GET', `/work-items/${betaItemId}`)).json().itemKey;

    const res = await as(editorToken, 'GET', `/work-items/by-key?itemKey=${key}`);

    expect([403, 404]).toContain(res.statusCode);
    expect(JSON.stringify(res.json())).not.toContain('RBAC-003 Beta story');
  });

  it('refuses an EDIT of the other Team’s item', async () => {
    const res = await as(editorToken, 'PATCH', `/work-items/${betaItemId}`, {
      title: 'Edited across the Team boundary',
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('TEAM_NOT_IN_SCOPE');
  });

  it('refuses MOVING one of their own items into a Team they are not on', async () => {
    const res = await as(editorToken, 'PATCH', `/work-items/${alphaItemId}`, {
      teamId: TEAM_BETA_ID,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('TEAM_NOT_IN_SCOPE');
  });

  it('offers the Editor only their own Teams, and the Admin every linked Team (AC2)', async () => {
    const forEditor = await as(editorToken, 'GET', `/projects/${NXP}/teams`);
    const forAdmin = await as(adminToken, 'GET', `/projects/${NXP}/teams`);

    expect(forEditor.statusCode).toBe(200);
    const teamIdsOf = (body: unknown) => (body as Array<{ teamId: string }>).map((l) => l.teamId);
    const editorTeams = teamIdsOf(forEditor.json());
    expect(editorTeams).toContain(TEAM_ALPHA_ID);
    expect(editorTeams).not.toContain(TEAM_BETA_ID);

    // The Workspace Admin keeps All Teams (§3.1), so this is a narrowing of one audience and not of
    // the feed — the property that makes it a scope rather than a filter everyone inherited.
    const adminTeams = teamIdsOf(forAdmin.json());
    expect(adminTeams).toContain(TEAM_ALPHA_ID);
    expect(adminTeams).toContain(TEAM_BETA_ID);
  });

  /**
   * INVERTED by the BA's ruling of 2026-08-17. This used to assert a team-less item was REACHABLE,
   * because `work_items.team_id` is nullable and mostly unset. The BA's answer: "Null means Project
   * Backlog, accessible only to Workspace Admin and Project Admin." No migration, a third audience.
   */
  it('REFUSES a team-less item — that is the Project Backlog', async () => {
    const created = await as(adminToken, 'POST', '/work-items', {
      projectId: NXP,
      type: 'story',
      title: 'RBAC-003 Project Backlog story',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().teamId).toBeNull();

    const res = await as(editorToken, 'GET', `/work-items/${created.json().id}`);

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PROJECT_BACKLOG_ADMIN_ONLY');
    expect(JSON.stringify(res.json())).not.toContain('RBAC-003 Project Backlog story');
  });

  it('makes the Editor CHOOSE a Team when creating, and names the choice', async () => {
    const res = await as(editorToken, 'POST', '/work-items', {
      projectId: NXP,
      type: 'story',
      title: 'RBAC-003 editor create with no team',
    });

    // Not `PROJECT_BACKLOG_ADMIN_ONLY`: on a form the reader needs to know WHICH field to fill.
    expect(res.statusCode).toBe(412);
    expect(res.json().error.code).toBe('WORK_ITEM_TEAM_REQUIRED');
  });

  it('lets the Editor create inside their own Team', async () => {
    const res = await as(editorToken, 'POST', '/work-items', {
      projectId: NXP,
      type: 'story',
      title: 'RBAC-003 editor create in Alpha',
      teamId: TEAM_ALPHA_ID,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().teamId).toBe(TEAM_ALPHA_ID);
  });

  /**
   * The READ side of the ruling — "enforce this consistently in API queries, lists, reports, search,
   * pickers and direct URLs". Unit specs pin the predicates by rendering SQL; these prove the routes
   * actually reach them, which is the property CLAUDE.md records no service-level spec can see.
   */
  describe('lists and sub-resources narrow to the Editor’s Teams', () => {
    it('keeps another Team’s Story out of the Backlog list', async () => {
      const res = await as(editorToken, 'GET', `/work-items/backlog?projectId=${NXP}&limit=100`);

      expect(res.statusCode).toBe(200);
      const ids = (res.json().data as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toContain(alphaItemId);
      expect(ids).not.toContain(betaItemId);
    });

    it('keeps a Project Backlog item out of the list as well', async () => {
      const created = await as(adminToken, 'POST', '/work-items', {
        projectId: NXP,
        type: 'story',
        title: 'RBAC-003 backlog row',
      });
      expect(created.json().teamId).toBeNull();

      const res = await as(editorToken, 'GET', `/work-items/backlog?projectId=${NXP}&limit=100`);

      expect((res.json().data as Array<{ id: string }>).map((r) => r.id)).not.toContain(
        created.json().id,
      );
    });

    it('refuses another Team’s Revision History, links, hours, watchers and attachments', async () => {
      // The record was refused all along; its CONTENTS were not, which is the same disclosure.
      for (const path of [
        'activity',
        'labels',
        'relations',
        'milestones',
        'time-logs',
        'watchers',
        'attachments',
      ]) {
        const res = await as(editorToken, 'GET', `/work-items/${betaItemId}/${path}`);
        expect([403, 404], `${path} answered ${res.statusCode}`).toContain(res.statusCode);
      }
    });

    it('refuses a bulk write that includes another Team’s item', async () => {
      const res = await as(editorToken, 'PATCH', '/work-items/bulk-iteration', {
        projectId: NXP,
        itemIds: [alphaItemId, betaItemId],
        iterationId: null,
      });

      // All-or-nothing: their own item must not move either.
      expect(res.statusCode).toBe(403);
    });
  });

  it('refuses an Editor creating into another Team', async () => {
    const res = await as(editorToken, 'POST', '/work-items', {
      projectId: NXP,
      type: 'story',
      title: 'RBAC-003 editor create in Beta',
      teamId: TEAM_BETA_ID,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('TEAM_NOT_IN_SCOPE');
  });
});
