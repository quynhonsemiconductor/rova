/**
 * Test Case read routes, over REAL HTTP, through the guard (Phase 7, Phase A).
 *
 * Two things a service-level spec cannot see (CLAUDE.md: "A spec that calls the service directly
 * cannot see a guard defect" — the same blind spot that hid the `work_item`/`task` resolver fault
 * and the `report:view` bug):
 *
 *   1. `GET /work-items/:id/test-cases` and `GET /test-cases/:id` carry a REAL `@RequirePermission`
 *      with a `resource` scope resolved by `ProjectScopeResolver` — a spec mocking the repository
 *      never exercises that resolution at all.
 *   2. `GET /test-cases/by-key/:key` carries NO decorator (`@AuthorizedInService`) — the ONE
 *      deliberate undecorated handler this module adds. `route-policy.ratchet.spec.ts` requires
 *      this file to exist as the spec it cites, and this file is what actually proves the
 *      resolve-then-check shape works: the by-key route still 200s for the owning project's
 *      caller and still resolves the row before any permission is checked.
 *
 * Uses the SEEDED fixtures (`NXP_TEST_CASE_1_ID`/`_2_ID`, `db/seeds/demo.ts`) rather than minting
 * its own — Phase A ships no create route, so there is no other way to get a row.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AuthService, EntraTokenVerifier, type EntraClaims } from '@quynhonsemiconductor/identity';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../apps/api/src/app.module';
import { NXP_STORY_1_ID, NXP_TEST_CASE_1_ID, NXP_TEST_CASE_2_ID } from '../../db/seeds/constants';

// No `/v1` prefix: `Test.createTestingModule` builds the app without the bootstrap that sets the
// global prefix, so routes are mounted bare here.
describe('test case routes (e2e)', () => {
  let app: NestFastifyApplication;
  let token: string;

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

    // Bearer, not the BFF cookie: `requiresCsrfProtection` exempts Bearer callers, so no CSRF dance.
    token = (await app.get(AuthService).devLogin('admin@qnsc.dev', '127.0.0.1')).accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  function get(url: string) {
    return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
  }

  it("lists the parent Work Item's Test Cases, in rank order (AC2)", async () => {
    const response = await get(`/work-items/${NXP_STORY_1_ID}/test-cases`);
    expect(response.statusCode, response.body).toBe(200);

    const body = JSON.parse(response.body) as { data: Array<{ testCaseKey: string }> };
    const keys = body.data.map((tc) => tc.testCaseKey);
    expect(keys).toEqual(['TC-1', 'TC-2']);
  });

  it('serves the populated Test Case with its trigger-maintained Last Verdict / Last Run (BR9)', async () => {
    const response = await get(`/test-cases/${NXP_TEST_CASE_1_ID}`);
    expect(response.statusCode, response.body).toBe(200);

    const body = JSON.parse(response.body);
    expect(body.testCaseKey).toBe('TC-1');
    // The LATER of its two seeded Results (2026-06-21, a pass), not the earlier fail — the
    // trigger's own tie-break (run_date desc, then created_at desc), asserted against the STORED
    // column here rather than re-deriving it from the Results list.
    expect(body.lastVerdict).toBe('pass');
    expect(body.lastRun).toBe('2026-06-21');
  });

  it('serves the UN-populated Test Case with null Last Verdict / Last Run (BR10)', async () => {
    const response = await get(`/test-cases/${NXP_TEST_CASE_2_ID}`);
    expect(response.statusCode, response.body).toBe(200);

    const body = JSON.parse(response.body);
    expect(body.testCaseKey).toBe('TC-2');
    expect(body.lastVerdict).toBeNull();
    expect(body.lastRun).toBeNull();
  });

  it('resolves by-key with NO @RequirePermission — resolve-then-check in the service', async () => {
    const response = await get('/test-cases/by-key/TC-1');
    expect(response.statusCode, response.body).toBe(200);
    expect(JSON.parse(response.body).id).toBe(NXP_TEST_CASE_1_ID);
  });

  it('names the key back on a miss (TEST_CASE_NOT_FOUND), not a 500', async () => {
    const response = await get('/test-cases/by-key/TC-404');
    expect(response.statusCode).toBe(404);
    expect(response.body).toContain('TC-404');
  });

  it('still 404s a Test Case id that belongs to nothing', async () => {
    expect((await get(`/test-cases/${randomUUID()}`)).statusCode).toBe(404);
  });

  it('joins Owner / Assignee names onto the row (a name is a property of the ROW)', async () => {
    const response = await get(`/test-cases/${NXP_TEST_CASE_1_ID}`);
    const body = JSON.parse(response.body);
    // TC-1 is seeded with an owner and assignee (admin / developer) — both must resolve to a name,
    // not just an id, matching every other work-row read model.
    expect(body.ownerName).not.toBeNull();
    expect(body.assigneeName).not.toBeNull();
  });
});
