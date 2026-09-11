/**
 * The Test Case Type catalog, over REAL HTTP (SRS §3, Phase G).
 *
 * Four things a service-level spec cannot see:
 *   1. `POST`/`DELETE /projects/:id/test-case-types` carry `workspace:edit` — workspace-tier, so
 *      the GUARD resolves no project scope at all. A Project Admin (who holds `project:edit`, not
 *      `workspace:edit`) must still be refused — the exact shape `project-authz.e2e.spec.ts`
 *      already proves for the sibling structural routes (`PATCH /projects/:id`).
 *   2. BR16's case-insensitive uniqueness: the SERVICE pre-check and the DB's
 *      `uq_test_case_types_name` index (on `lower(name)`) must agree, so a duplicate name is a
 *      clean 409, never a raw constraint violation surfacing as a 500.
 *   3. BR17/AC17: a Test Case created against a Type, after that Type is archived, still renders
 *      its OWN (now-removed) Type value when read back — sourced from the real
 *      `GET /projects/:id/test-case-types` feed, not a stub.
 *   4. BR18/G3: a NEW project (created over HTTP, not seeded) starts with the five default Types —
 *      the create-time hook, not migration 0129's one-time backfill.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AuthService, EntraTokenVerifier, type EntraClaims } from '@quynhonsemiconductor/identity';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../apps/api/src/app.module';
import { SSO_EMAIL_DOMAIN, SSO_TENANT_ID } from './support/sso-env';
import { SEED_PROJECTS } from '../../db/seeds/constants';
import { grantProjectAccess } from './support/flow-harness';

const NXP = SEED_PROJECTS[0].id;

describe('test case type catalog (e2e)', () => {
  let app: NestFastifyApplication;
  let auth: AuthService;
  let adminToken: string;

  function get(url: string, token: string) {
    return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
  }

  function post(url: string, token: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  function del(url: string, token: string) {
    return app.inject({ method: 'DELETE', url, headers: { authorization: `Bearer ${token}` } });
  }

  /** A fresh Project Admin on NXP — holds `project:edit`, never `workspace:edit`. */
  async function projectAdminToken(): Promise<string> {
    const claims: EntraClaims = {
      oid: `tct-admin-${randomUUID()}`,
      email: `tct-admin-${randomUUID().slice(0, 8)}@${SSO_EMAIL_DOMAIN}`,
      displayName: 'E2E Project Admin',
      externalTenantId: SSO_TENANT_ID,
      roles: [],
    };
    const { accessToken } = await auth.ssoLogin(JSON.stringify(claims), '127.0.0.1');
    const userId = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString())[
      'sub'
    ] as string;
    await grantProjectAccess(app, userId, NXP, 'admin');
    return accessToken;
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
    adminToken = (await auth.devLogin('admin@qnsc.dev', '127.0.0.1')).accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET lists the live catalog, ordered by position', async () => {
    const response = await get(`/projects/${NXP}/test-case-types`, adminToken);
    expect(response.statusCode, response.body).toBe(200);

    const body = JSON.parse(response.body) as Array<{ name: string; position: number }>;
    expect(body.length).toBeGreaterThan(0);
    const positions = body.map((t) => t.position);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  // ── G2: workspace:edit, not project:edit ────────────────────────────────────

  it('refuses POST to a per-Project ADMIN (workspace:edit is Workspace-Admin-only)', async () => {
    const admin = await projectAdminToken();
    const response = await post(`/projects/${NXP}/test-case-types`, admin, {
      name: `Refused-${randomUUID().slice(0, 8)}`,
    });
    expect(response.statusCode, response.body).toBe(403);
  });

  it('refuses DELETE to a per-Project ADMIN too', async () => {
    const admin = await projectAdminToken();
    const list = JSON.parse(
      (await get(`/projects/${NXP}/test-case-types`, adminToken)).body,
    ) as Array<{ id: string }>;
    const response = await del(`/projects/${NXP}/test-case-types/${list[0].id}`, admin);
    expect(response.statusCode, response.body).toBe(403);
  });

  it('allows a Workspace Admin to create and then archive a Type', async () => {
    const name = `WA-${randomUUID().slice(0, 8)}`;
    const created = await post(`/projects/${NXP}/test-case-types`, adminToken, { name });
    expect(created.statusCode, created.body).toBe(201);
    const type = JSON.parse(created.body) as { id: string; name: string };
    expect(type.name).toBe(name);

    const archived = await del(`/projects/${NXP}/test-case-types/${type.id}`, adminToken);
    expect(archived.statusCode, archived.body).toBe(204);

    // Archived Types drop out of the live (selectable) list.
    const after = JSON.parse(
      (await get(`/projects/${NXP}/test-case-types`, adminToken)).body,
    ) as Array<{ name: string }>;
    expect(after.some((t) => t.name === name)).toBe(false);
  });

  // ── BR16: case-insensitive uniqueness ────────────────────────────────────────

  it('BR16: refuses a case-insensitively duplicate name with a clean 409, never a raw constraint error', async () => {
    const name = `Acceptance-${randomUUID().slice(0, 6)}`;
    const first = await post(`/projects/${NXP}/test-case-types`, adminToken, { name });
    expect(first.statusCode, first.body).toBe(201);

    const dup = await post(`/projects/${NXP}/test-case-types`, adminToken, {
      name: name.toUpperCase(),
    });
    expect(dup.statusCode, dup.body).toBe(409);
    expect(JSON.parse(dup.body)?.error?.code).toBe('TEST_CASE_TYPE_NAME_TAKEN');

    // Cleanup: archive so this run's row does not accumulate across repeats.
    const created = JSON.parse(first.body) as { id: string };
    await del(`/projects/${NXP}/test-case-types/${created.id}`, adminToken);
  });

  it('BR16: an archived name is still refused as a duplicate (the unique index has no WHERE clause)', async () => {
    const name = `Archived-${randomUUID().slice(0, 6)}`;
    const created = JSON.parse(
      (await post(`/projects/${NXP}/test-case-types`, adminToken, { name })).body,
    ) as { id: string };
    await del(`/projects/${NXP}/test-case-types/${created.id}`, adminToken);

    const dup = await post(`/projects/${NXP}/test-case-types`, adminToken, { name });
    expect(dup.statusCode, dup.body).toBe(409);
  });

  // ── BR18/G3: default Types on a NEW project, via the create-time hook ───────

  it('BR18/G3: a newly created project starts with the five default Test Case Types', async () => {
    const projectKey = `TCT${randomUUID().slice(0, 4).toUpperCase()}`;
    const createProject = await post('/projects', adminToken, {
      key: projectKey,
      name: `Phase G create-hook test ${projectKey}`,
    });
    expect(createProject.statusCode, createProject.body).toBe(201);
    const project = JSON.parse(createProject.body) as { id: string };

    const types = JSON.parse(
      (await get(`/projects/${project.id}/test-case-types`, adminToken)).body,
    ) as Array<{ name: string }>;
    expect(types.map((t) => t.name)).toEqual([
      'Acceptance',
      'Functional',
      'Regression',
      'Performance',
      'Usability',
    ]);
  });

  // ── BR17/AC17: a removed Type still renders on its historical Test Case ─────

  it('BR17/AC17: a Test Case keeps its Type value after that Type is archived, sourced from the real feed', async () => {
    // Create a scratch Type, a scratch Work Item under NXP, a Test Case using that Type, then
    // archive the Type — the Test Case's own `type` column is a text SNAPSHOT (D8), so it must
    // still read back unchanged.
    const typeName = `Historical-${randomUUID().slice(0, 6)}`;
    const type = JSON.parse(
      (await post(`/projects/${NXP}/test-case-types`, adminToken, { name: typeName })).body,
    ) as { id: string; name: string };

    const workItem = JSON.parse(
      (
        await post('/work-items', adminToken, {
          projectId: NXP,
          type: 'story',
          title: `Phase G BR17 scratch story ${randomUUID().slice(0, 6)}`,
        })
      ).body,
    ) as { id: string };

    const testCase = JSON.parse(
      (
        await post(`/work-items/${workItem.id}/test-cases`, adminToken, {
          name: 'BR17 scratch test case',
          type: typeName,
        })
      ).body,
    ) as { id: string; type: string };
    expect(testCase.type).toBe(typeName);

    // Archive the Type — it is no longer selectable...
    await del(`/projects/${NXP}/test-case-types/${type.id}`, adminToken);
    const liveTypes = JSON.parse(
      (await get(`/projects/${NXP}/test-case-types`, adminToken)).body,
    ) as Array<{ name: string }>;
    expect(liveTypes.some((t) => t.name === typeName)).toBe(false);

    // ...but the Test Case created against it still reports the SAME value, read fresh.
    const reread = JSON.parse((await get(`/test-cases/${testCase.id}`, adminToken)).body) as {
      type: string;
    };
    expect(reread.type).toBe(typeName);
  });
});
