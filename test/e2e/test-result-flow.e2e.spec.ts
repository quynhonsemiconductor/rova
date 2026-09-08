/**
 * Test Result routes, over REAL HTTP, through the guard (Phase 7, Phase D — SRS §7, §8).
 *
 * `derived-invariants.e2e.spec.ts` proves `trg_test_case_last_result` fires correctly at the
 * service/DB level (INSERT, tie-break, soft-delete) using a fresh Test Case per test. This file is
 * the HTTP-layer companion CLAUDE.md names as the shape that can see a guard defect ("A spec that
 * calls the service directly cannot see a guard defect") — `GET`/`POST /test-cases/:id/test-results`
 * and `GET /test-results/:id` all carry a REAL `@RequirePermission` with a `resource` scope resolved
 * by `ProjectScopeResolver`, which a mocked-repository spec never exercises.
 *
 * Uses `NXP_TEST_CASE_2_ID` (seeded with ZERO Results, per Phase A's A16) so this file's own writes
 * are the only Results ever attached to it — no collision with the trigger tie-break fixed by
 * `NXP_TEST_CASE_1_ID`'s seeded pair.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AuthService, EntraTokenVerifier, type EntraClaims } from '@quynhonsemiconductor/identity';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../apps/api/src/app.module';
import { ADMIN_USER_ID, NXP_STORY_1_ID, NXP_TEST_CASE_2_ID } from '../../db/seeds/constants';

describe('test result routes (e2e)', () => {
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

    token = (await app.get(AuthService).devLogin('admin@qnsc.dev', '127.0.0.1')).accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  function get(url: string) {
    return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
  }

  function post(url: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  function patch(url: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'PATCH',
      url,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  function del(url: string) {
    return app.inject({ method: 'DELETE', url, headers: { authorization: `Bearer ${token}` } });
  }

  it('BR11: refuses a Result missing Build/run_date/tester (validation before the handler)', async () => {
    const response = await post(`/test-cases/${NXP_TEST_CASE_2_ID}/test-results`, {
      runDate: '2026-09-01',
      verdict: 'pass',
      testerId: ADMIN_USER_ID,
    });
    expect(response.statusCode).toBe(400);
  });

  it("D6: `not_run` is refused as a Result's own verdict (the trigger's exclusive value)", async () => {
    const response = await post(`/test-cases/${NXP_TEST_CASE_2_ID}/test-results`, {
      build: 'build-1',
      runDate: '2026-09-01',
      verdict: 'not_run',
      testerId: ADMIN_USER_ID,
    });
    expect(response.statusCode).toBe(400);
  });

  it('BR11: duration_minutes must be >= 0', async () => {
    const response = await post(`/test-cases/${NXP_TEST_CASE_2_ID}/test-results`, {
      build: 'build-1',
      runDate: '2026-09-01',
      verdict: 'pass',
      durationMinutes: -1,
      testerId: ADMIN_USER_ID,
    });
    expect(response.statusCode).toBe(400);
  });

  it('BR8: an ineligible tester is refused identically to Owner/Assigned To', async () => {
    const response = await post(`/test-cases/${NXP_TEST_CASE_2_ID}/test-results`, {
      build: 'build-1',
      runDate: '2026-09-01',
      verdict: 'pass',
      testerId: randomUUID(),
    });
    expect(response.statusCode).toBe(412);
    expect(response.body).toContain('WORK_ITEM_ASSIGNEE_NOT_ELIGIBLE');
  });

  it("refuses to create against a Test Case outside the caller's readable projects (404, not 500)", async () => {
    const response = await post(`/test-cases/${randomUUID()}/test-results`, {
      build: 'build-1',
      runDate: '2026-09-01',
      verdict: 'pass',
      testerId: ADMIN_USER_ID,
    });
    expect(response.statusCode).toBe(404);
  });

  describe('BR9/BR12/BR14: two Results, latest-by-run_date wins, then a same-date tie on created_at', () => {
    it('walks the whole flow over HTTP against a fresh Test Case', async () => {
      // A fresh Test Case, not the seeded NXP_TEST_CASE_2_ID, so this scenario's own two/three
      // inserts are the ONLY Results ever attached to it (parallel test files may also post to the
      // shared seeded fixture above).
      const testCase = JSON.parse(
        (await post(`/work-items/${NXP_STORY_1_ID}/test-cases`, { name: 'Flow scenario case' }))
          .body,
      );

      // BR12: adding a Result never replaces an earlier one — both must remain listed.
      const first = JSON.parse(
        (
          await post(`/test-cases/${testCase.id}/test-results`, {
            build: 'build-early',
            runDate: '2026-06-01',
            verdict: 'fail',
            testerId: ADMIN_USER_ID,
          })
        ).body,
      );
      expect(first.testResultKey).toMatch(/^TR-\d+$/);
      // BR13: Work Product is the SNAPSHOT from the Test Case at create time.
      expect(first.workItemId).toBe(NXP_STORY_1_ID);

      const latest = JSON.parse(
        (
          await post(`/test-cases/${testCase.id}/test-results`, {
            build: 'build-late',
            runDate: '2026-06-15',
            verdict: 'pass',
            testerId: ADMIN_USER_ID,
          })
        ).body,
      );

      // BR14: the list is `run_date desc, created_at desc` — latest first, both rows present.
      const listRes = await get(`/test-cases/${testCase.id}/test-results`);
      expect(listRes.statusCode, listRes.body).toBe(200);
      const list = JSON.parse(listRes.body) as Array<{ id: string; runDate: string }>;
      expect(list.map((r) => r.id)).toEqual([latest.id, first.id]);

      // BR9: the parent Test Case's stored Last Verdict/Last Run reflect the LATEST by run_date.
      const parentAfterTwo = JSON.parse((await get(`/test-cases/${testCase.id}`)).body);
      expect(parentAfterTwo.lastVerdict).toBe('pass');
      expect(parentAfterTwo.lastRun).toBe('2026-06-15');
      expect(parentAfterTwo.lastResultId).toBe(latest.id);

      // Same-date pair: the SECOND of the two (later created_at) must win the tie.
      const sameDateFirst = JSON.parse(
        (
          await post(`/test-cases/${testCase.id}/test-results`, {
            build: 'build-tie-a',
            runDate: '2026-06-20',
            verdict: 'fail',
            testerId: ADMIN_USER_ID,
          })
        ).body,
      );
      const sameDateSecond = JSON.parse(
        (
          await post(`/test-cases/${testCase.id}/test-results`, {
            build: 'build-tie-b',
            runDate: '2026-06-20',
            verdict: 'pass',
            testerId: ADMIN_USER_ID,
          })
        ).body,
      );

      const parentAfterTie = JSON.parse((await get(`/test-cases/${testCase.id}`)).body);
      expect(parentAfterTie.lastVerdict).toBe('pass');
      expect(parentAfterTie.lastResultId).toBe(sameDateSecond.id);
      expect(parentAfterTie.lastResultId).not.toBe(sameDateFirst.id);

      // GET /test-results/:id resolves the record route directly.
      const recordRes = await get(`/test-results/${sameDateSecond.id}`);
      expect(recordRes.statusCode, recordRes.body).toBe(200);
      expect(JSON.parse(recordRes.body).testResultKey).toBe(sameDateSecond.testResultKey);
    });
  });

  it('404s a Test Result id that belongs to nothing', async () => {
    expect((await get(`/test-results/${randomUUID()}`)).statusCode).toBe(404);
  });

  it("refuses GET /test-results/:id for a Result outside the caller's readable projects (404, not 500)", async () => {
    // Same shape as the Test Case equivalent: a Result's scope is its Test Case's, resolved by
    // ProjectScopeResolver's `test_result` kind (registered in Phase A's A5, unused until now).
    const response = await get(`/test-results/${randomUUID()}`);
    expect(response.statusCode).toBe(404);
  });

  it('joins the tester name onto the row (a name is a property of the ROW)', async () => {
    const testCase = JSON.parse(
      (await post(`/work-items/${NXP_STORY_1_ID}/test-cases`, { name: 'Tester name case' })).body,
    );
    const result = JSON.parse(
      (
        await post(`/test-cases/${testCase.id}/test-results`, {
          build: 'build-1',
          runDate: '2026-09-01',
          verdict: 'pass',
          testerId: ADMIN_USER_ID,
        })
      ).body,
    );
    expect(result.testerName).not.toBeNull();
  });

  describe('PATCH/DELETE /test-results/:id (Phase E)', () => {
    async function freshResult() {
      const testCase = JSON.parse(
        (
          await post(`/work-items/${NXP_STORY_1_ID}/test-cases`, {
            name: `Edit case ${randomUUID()}`,
          })
        ).body,
      );
      const result = JSON.parse(
        (
          await post(`/test-cases/${testCase.id}/test-results`, {
            build: 'build-1',
            runDate: '2026-09-01',
            verdict: 'fail',
            testerId: ADMIN_USER_ID,
          })
        ).body,
      );
      return { testCase, result };
    }

    it('PATCH round trip: edits Build/Duration/Notes and returns the updated row', async () => {
      const { result } = await freshResult();

      const response = await patch(`/test-results/${result.id}`, {
        build: 'build-2',
        durationMinutes: 45,
        notes: 'retested after fix',
      });
      expect(response.statusCode, response.body).toBe(200);
      const updated = JSON.parse(response.body);
      expect(updated.build).toBe('build-2');
      expect(updated.durationMinutes).toBe(45);
      expect(updated.notes).toBe('retested after fix');
      // Untouched fields survive the PATCH.
      expect(updated.verdict).toBe('fail');
      expect(updated.testResultKey).toBe(result.testResultKey);
    });

    it('BR13: testCaseId/workItemId are silently ignored on PATCH (asserted against the STORED response)', async () => {
      const { testCase, result } = await freshResult();
      const otherCase = JSON.parse(
        (
          await post(`/work-items/${NXP_STORY_1_ID}/test-cases`, {
            name: `Other case ${randomUUID()}`,
          })
        ).body,
      );

      const response = await patch(`/test-results/${result.id}`, {
        testCaseId: otherCase.id,
        workItemId: randomUUID(),
        build: 'build-unchanged-links',
      });
      expect(response.statusCode, response.body).toBe(200);
      const updated = JSON.parse(response.body);
      expect(updated.testCaseId).toBe(testCase.id);
      expect(updated.workItemId).toBe(NXP_STORY_1_ID);
    });

    it('BR11: duration_minutes must be >= 0 on the UPDATE path too, not just create', async () => {
      const { result } = await freshResult();

      const response = await patch(`/test-results/${result.id}`, { durationMinutes: -1 });
      expect(response.statusCode).toBe(400);
    });

    it("D6: `not_run` is refused as a Result's own verdict on PATCH too", async () => {
      const { result } = await freshResult();

      const response = await patch(`/test-results/${result.id}`, { verdict: 'not_run' });
      expect(response.statusCode).toBe(400);
    });

    it('BR8: an ineligible new tester is refused on PATCH identically to create', async () => {
      const { result } = await freshResult();

      const response = await patch(`/test-results/${result.id}`, { testerId: randomUUID() });
      expect(response.statusCode).toBe(412);
      expect(response.body).toContain('WORK_ITEM_ASSIGNEE_NOT_ELIGIBLE');
    });

    it('PATCH 404s a Test Result id that belongs to nothing', async () => {
      const response = await patch(`/test-results/${randomUUID()}`, { build: 'x' });
      expect(response.statusCode).toBe(404);
    });

    it('the activity route lists the created + updated rows', async () => {
      const { result } = await freshResult();
      await patch(`/test-results/${result.id}`, { build: 'build-edited' });

      const activityRes = await get(`/test-results/${result.id}/activity`);
      expect(activityRes.statusCode, activityRes.body).toBe(200);
      const activity = JSON.parse(activityRes.body).data as Array<{ action: string }>;
      expect(activity.some((a) => a.action === 'test_result.updated')).toBe(true);
    });

    it('404s the activity route for an unreadable Test Result id', async () => {
      const response = await get(`/test-results/${randomUUID()}/activity`);
      expect(response.statusCode).toBe(404);
    });

    it('DELETE soft-deletes: 204, then the record 404s', async () => {
      const { result } = await freshResult();

      const deleteRes = await del(`/test-results/${result.id}`);
      expect(deleteRes.statusCode, deleteRes.body).toBe(204);

      const getRes = await get(`/test-results/${result.id}`);
      expect(getRes.statusCode).toBe(404);
    });

    it('DELETE 404s a Test Result id that belongs to nothing', async () => {
      const response = await del(`/test-results/${randomUUID()}`);
      expect(response.statusCode).toBe(404);
    });

    it('attachments: empty list, 404 on an unreadable Test Result, 404 on the download route', async () => {
      const { result } = await freshResult();

      const listRes = await get(`/test-results/${result.id}/attachments`);
      expect(listRes.statusCode, listRes.body).toBe(200);
      expect(JSON.parse(listRes.body)).toEqual([]);

      const unreadableList = await get(`/test-results/${randomUUID()}/attachments`);
      expect(unreadableList.statusCode).toBe(404);

      const unreadableDownload = await get(
        `/test-results/${randomUUID()}/attachments/${randomUUID()}/download`,
      );
      expect(unreadableDownload.statusCode).toBe(404);
    });
  });
});
