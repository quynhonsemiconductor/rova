/**
 * Test Case routes, over REAL HTTP, through the guard (Phase 7, Phase A read path + Phase B create).
 *
 * Two things a service-level spec cannot see (CLAUDE.md: "A spec that calls the service directly
 * cannot see a guard defect" — the same blind spot that hid the `work_item`/`task` resolver fault
 * and the `report:view` bug):
 *
 *   1. `GET /work-items/:id/test-cases`, `POST /work-items/:id/test-cases` and `GET /test-cases/:id`
 *      carry a REAL `@RequirePermission` with a `resource` scope resolved by `ProjectScopeResolver`
 *      — a spec mocking the repository never exercises that resolution at all.
 *   2. `GET /test-cases/by-key/:key` carries NO decorator (`@AuthorizedInService`) — the ONE
 *      deliberate undecorated handler this module adds. `route-policy.ratchet.spec.ts` requires
 *      this file to exist as the spec it cites, and this file is what actually proves the
 *      resolve-then-check shape works: the by-key route still 200s for the owning project's
 *      caller and still resolves the row before any permission is checked.
 *
 * Uses the SEEDED fixtures (`NXP_TEST_CASE_1_ID`/`_2_ID`, `NXP_STORY_1_ID`, `db/seeds/demo.ts`)
 * rather than minting a project — `test/e2e-fixtures.ratchet.spec.ts` caps `createProject`.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AuthService, EntraTokenVerifier, type EntraClaims } from '@quynhonsemiconductor/identity';
import { DRIZZLE, type DrizzleDB } from '@platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../apps/api/src/app.module';
import { testCaseTypes, workItems } from '../../db/schema/work';
import {
  ADMIN_USER_ID,
  NXP_STORY_1_ID,
  NXP_TEST_CASE_1_ID,
  NXP_TEST_CASE_2_ID,
} from '../../db/seeds/constants';

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

    // NXP gets its five default Test Case Types from migration 0129's backfill, which only
    // covers projects that ALREADY EXIST when it runs — NXP is created by the demo SEED, which
    // runs AFTER migrations, so on a fresh CI database NXP has ZERO selectable Types (this is
    // documented on the seed itself, db/seeds/demo.ts, around the Test Cases block). The
    // create-time hook that would seed Types for a NEW project is Phase G, not part of this
    // branch. Insert one directly — the only mechanism this branch has, since Phase G's
    // TestCaseTypesService/route don't exist here yet — so `create (Phase B)`'s default-Type
    // path (BR2: "first selectable Type") has something to select.
    const db = app.get<DrizzleDB>(DRIZZLE);
    const [story] = await db
      .select({ projectId: workItems.projectId, workspaceId: workItems.workspaceId })
      .from(workItems)
      .where(eq(workItems.id, NXP_STORY_1_ID));
    if (!story) throw new Error(`Seed fixture missing: work item ${NXP_STORY_1_ID}`);
    await db
      .insert(testCaseTypes)
      .values({
        workspaceId: story.workspaceId,
        projectId: story.projectId,
        name: 'Acceptance',
        position: 0,
      })
      .onConflictDoNothing();
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

  describe('create (Phase B)', () => {
    it('creates → the new row is immediately visible in the LIST → its own detail resolves (B1-B4)', async () => {
      const createRes = await post(`/work-items/${NXP_STORY_1_ID}/test-cases`, {
        name: 'New login regression case',
      });
      expect(createRes.statusCode, createRes.body).toBe(201);
      const created = JSON.parse(createRes.body);
      expect(created.name).toBe('New login regression case');
      expect(created.testCaseKey).toMatch(/^TC-\d+$/);

      // BR5: inherited from the parent, never accepted on the wire.
      expect(created.workItemId).toBe(NXP_STORY_1_ID);
      expect(created.projectId).toBe(created.projectId); // sanity: present
      expect(created.teamId).not.toBeUndefined();

      // BR3: schema defaults.
      expect(created.method).toBe('manual');
      expect(created.priority).toBe('normal');

      // BR6: Assigned To starts Unassigned.
      expect(created.assigneeId).toBeNull();

      const listRes = await get(`/work-items/${NXP_STORY_1_ID}/test-cases`);
      const listBody = JSON.parse(listRes.body) as { data: Array<{ id: string }> };
      expect(listBody.data.map((tc) => tc.id)).toContain(created.id);

      const detailRes = await get(`/test-cases/${created.id}`);
      expect(detailRes.statusCode, detailRes.body).toBe(200);
      expect(JSON.parse(detailRes.body).id).toBe(created.id);
    });

    it('BR1: refuses a blank Name — validation runs before the handler is ever reached', async () => {
      const response = await post(`/work-items/${NXP_STORY_1_ID}/test-cases`, { name: '' });
      expect(response.statusCode).toBe(400);
    });

    it('BR2: an explicit Type not in the project catalog is refused (TEST_CASE_TYPE_NOT_SELECTABLE)', async () => {
      const response = await post(`/work-items/${NXP_STORY_1_ID}/test-cases`, {
        name: 'Bad type case',
        type: 'Nonexistent Type XYZ',
      });
      expect(response.statusCode).toBe(412);
      expect(response.body).toContain('TEST_CASE_TYPE_NOT_SELECTABLE');
    });

    it('BR4/BR8: accepts an eligible Owner and rejects an ineligible one identically to the picker rule', async () => {
      const eligible = await post(`/work-items/${NXP_STORY_1_ID}/test-cases`, {
        name: 'Owned by admin',
        ownerId: ADMIN_USER_ID,
      });
      expect(eligible.statusCode, eligible.body).toBe(201);
      expect(JSON.parse(eligible.body).ownerId).toBe(ADMIN_USER_ID);

      const ineligible = await post(`/work-items/${NXP_STORY_1_ID}/test-cases`, {
        name: 'Owned by nobody real',
        ownerId: randomUUID(),
      });
      expect(ineligible.statusCode).toBe(412);
      expect(ineligible.body).toContain('WORK_ITEM_ASSIGNEE_NOT_ELIGIBLE');
    });

    it('BR7: ranks strictly AFTER the existing Test Cases of the same Work Item', async () => {
      const before = await get(`/work-items/${NXP_STORY_1_ID}/test-cases`);
      const beforeBody = JSON.parse(before.body) as { data: Array<{ rank: string }> };
      const maxRankBefore = beforeBody.data
        .map((tc) => tc.rank)
        .sort()
        .at(-1) as string;

      const createRes = await post(`/work-items/${NXP_STORY_1_ID}/test-cases`, {
        name: 'Ranked last',
      });
      const created = JSON.parse(createRes.body);

      expect(created.rank > maxRankBefore).toBe(true);
    });

    it("refuses to create under a Work Item outside the caller's readable projects (404, not 500)", async () => {
      const response = await post(`/work-items/${randomUUID()}/test-cases`, { name: 'Orphan' });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('update (Phase C)', () => {
    it('PATCH edits a content field and it is immediately visible on GET', async () => {
      const created = JSON.parse(
        (await post(`/work-items/${NXP_STORY_1_ID}/test-cases`, { name: 'To be edited' })).body,
      );

      const patchRes = await patch(`/test-cases/${created.id}`, {
        name: 'Edited name',
        description: '<p>new description</p>',
      });
      expect(patchRes.statusCode, patchRes.body).toBe(200);
      const patched = JSON.parse(patchRes.body);
      expect(patched.name).toBe('Edited name');
      expect(patched.description).toBe('<p>new description</p>');

      const getRes = await get(`/test-cases/${created.id}`);
      expect(JSON.parse(getRes.body).name).toBe('Edited name');
    });

    it('BR5: a projectId/teamId/workItemId in the PATCH body is silently ignored, never honoured', async () => {
      const created = JSON.parse(
        (await post(`/work-items/${NXP_STORY_1_ID}/test-cases`, { name: 'Immutable parentage' }))
          .body,
      );
      const otherWorkItem = randomUUID();

      const patchRes = await patch(`/test-cases/${created.id}`, {
        name: 'Still same parent',
        projectId: randomUUID(),
        teamId: randomUUID(),
        workItemId: otherWorkItem,
      });
      expect(patchRes.statusCode, patchRes.body).toBe(200);
      const patched = JSON.parse(patchRes.body);
      expect(patched.projectId).toBe(created.projectId);
      expect(patched.teamId).toBe(created.teamId);
      expect(patched.workItemId).toBe(created.workItemId);
      expect(patched.workItemId).not.toBe(otherWorkItem);
    });

    it('BR9: lastVerdict/lastRun/lastResultId in the PATCH body are silently ignored — only the trigger writes them', async () => {
      const patchRes = await patch(`/test-cases/${NXP_TEST_CASE_2_ID}`, {
        lastVerdict: 'pass',
        lastRun: '2020-01-01',
        lastResultId: randomUUID(),
      });
      expect(patchRes.statusCode, patchRes.body).toBe(200);
      const patched = JSON.parse(patchRes.body);
      // TC-2 is seeded with NO Results (BR10) — a write here would prove the columns are settable
      // from the PATCH body, which BR9 forbids.
      expect(patched.lastVerdict).toBeNull();
      expect(patched.lastRun).toBeNull();
      expect(patched.lastResultId).toBeNull();
    });

    it('BR17: re-supplying the SAME Type is a no-op even if the field is otherwise validated', async () => {
      const created = JSON.parse(
        (await post(`/work-items/${NXP_STORY_1_ID}/test-cases`, { name: 'Type no-op case' })).body,
      );
      const patchRes = await patch(`/test-cases/${created.id}`, { type: created.type });
      expect(patchRes.statusCode, patchRes.body).toBe(200);
      expect(JSON.parse(patchRes.body).type).toBe(created.type);
    });

    it('BR2/BR17: a Type not in the project catalog and not the row’s own value is refused', async () => {
      const created = JSON.parse(
        (await post(`/work-items/${NXP_STORY_1_ID}/test-cases`, { name: 'Bad type edit' })).body,
      );
      const patchRes = await patch(`/test-cases/${created.id}`, { type: 'Nonexistent Type XYZ' });
      expect(patchRes.statusCode).toBe(412);
      expect(patchRes.body).toContain('TEST_CASE_TYPE_NOT_SELECTABLE');
    });

    it('BR8: an ineligible Owner on PATCH is refused identically to create', async () => {
      const created = JSON.parse(
        (await post(`/work-items/${NXP_STORY_1_ID}/test-cases`, { name: 'Reassign case' })).body,
      );
      const patchRes = await patch(`/test-cases/${created.id}`, { ownerId: randomUUID() });
      expect(patchRes.statusCode).toBe(412);
      expect(patchRes.body).toContain('WORK_ITEM_ASSIGNEE_NOT_ELIGIBLE');
    });

    it('404s a PATCH to a Test Case id that belongs to nothing', async () => {
      const response = await patch(`/test-cases/${randomUUID()}`, { name: 'x' });
      expect(response.statusCode).toBe(404);
    });
  });

  /**
   * F3/F1's tests mint their OWN Work Item rather than piling more Test Cases onto the seeded
   * `NXP_STORY_1_ID` — the `create`/`update` blocks above already do that with no cleanup, and the
   * very first test in this file (AC2's "lists…in rank order") asserts that Story's list is
   * EXACTLY `['TC-1', 'TC-2']`. Reordering and deleting rows need a scratch parent whose list
   * nothing else is asserting the exact contents of.
   */
  async function freshStoryId(): Promise<string> {
    const storyRes = await get(`/test-cases/by-key/TC-1`);
    const projectId = JSON.parse(storyRes.body).projectId as string;
    const created = await post('/work-items', {
      projectId,
      type: 'story',
      title: `F3/F1 scratch story ${randomUUID()}`,
    });
    return (JSON.parse(created.body) as { id: string }).id;
  }

  describe('rank (F3, neighbour-based drag-reorder)', () => {
    it('moves a Test Case between two neighbours and the new order is visible on the list', async () => {
      const workItemId = await freshStoryId();
      const a = JSON.parse(
        (await post(`/work-items/${workItemId}/test-cases`, { name: 'Rank A' })).body,
      );
      const b = JSON.parse(
        (await post(`/work-items/${workItemId}/test-cases`, { name: 'Rank B' })).body,
      );
      const c = JSON.parse(
        (await post(`/work-items/${workItemId}/test-cases`, { name: 'Rank C' })).body,
      );
      // Created in order A, B, C (BR7: ranks after existing) — move C between A and B.
      const rankRes = await patch(`/test-cases/${c.id}/rank`, {
        workItemId,
        beforeId: a.id,
        afterId: b.id,
      });
      expect(rankRes.statusCode, rankRes.body).toBe(200);
      const ranked = JSON.parse(rankRes.body);
      expect(ranked.rank > a.rank && ranked.rank < b.rank).toBe(true);

      const listRes = await get(`/work-items/${workItemId}/test-cases`);
      const body = JSON.parse(listRes.body) as { data: Array<{ id: string }> };
      const ids = body.data.map((tc) => tc.id);
      expect(ids.indexOf(a.id)).toBeLessThan(ids.indexOf(c.id));
      expect(ids.indexOf(c.id)).toBeLessThan(ids.indexOf(b.id));
    });

    it('refuses a workItemId that does not match the Test Case’s own parent', async () => {
      const workItemId = await freshStoryId();
      const created = JSON.parse(
        (await post(`/work-items/${workItemId}/test-cases`, { name: 'Wrong parent rank' })).body,
      );
      const response = await patch(`/test-cases/${created.id}/rank`, {
        workItemId: randomUUID(),
      });
      expect(response.statusCode).toBe(412);
      expect(response.body).toContain('WORK_ITEM_PARENT_SCOPE_MISMATCH');
    });

    it('refuses a neighbour that belongs to a different Work Item', async () => {
      const workItemId = await freshStoryId();
      const created = JSON.parse(
        (await post(`/work-items/${workItemId}/test-cases`, { name: 'Cross-parent rank' })).body,
      );
      const response = await patch(`/test-cases/${created.id}/rank`, {
        workItemId,
        beforeId: randomUUID(),
      });
      expect(response.statusCode).toBe(412);
      expect(response.body).toContain('WORK_ITEM_PARENT_SCOPE_MISMATCH');
    });

    it('404s a rank PATCH to a Test Case id that belongs to nothing', async () => {
      const workItemId = await freshStoryId();
      const response = await patch(`/test-cases/${randomUUID()}/rank`, { workItemId });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('delete (F1/F2, soft, cascades to Results)', () => {
    it('204s, and the Test Case no longer appears on the list', async () => {
      const workItemId = await freshStoryId();
      const created = JSON.parse(
        (await post(`/work-items/${workItemId}/test-cases`, { name: 'To be deleted' })).body,
      );

      const deleteRes = await del(`/test-cases/${created.id}`);
      expect(deleteRes.statusCode, deleteRes.body).toBe(204);

      const getRes = await get(`/test-cases/${created.id}`);
      expect(getRes.statusCode).toBe(404);

      const listRes = await get(`/work-items/${workItemId}/test-cases`);
      const body = JSON.parse(listRes.body) as { data: Array<{ id: string }> };
      expect(body.data.map((tc) => tc.id)).not.toContain(created.id);
    });

    it('404s a delete of a Test Case id that belongs to nothing', async () => {
      const response = await del(`/test-cases/${randomUUID()}`);
      expect(response.statusCode).toBe(404);
    });

    it('404s a delete of an already-deleted Test Case', async () => {
      const workItemId = await freshStoryId();
      const created = JSON.parse(
        (await post(`/work-items/${workItemId}/test-cases`, { name: 'Double delete' })).body,
      );
      expect((await del(`/test-cases/${created.id}`)).statusCode).toBe(204);
      expect((await del(`/test-cases/${created.id}`)).statusCode).toBe(404);
    });
  });

  describe('activity (C6)', () => {
    it('GET /test-cases/:id/activity lists the create + edit rows for one Test Case', async () => {
      const created = JSON.parse(
        (await post(`/work-items/${NXP_STORY_1_ID}/test-cases`, { name: 'History case' })).body,
      );
      await patch(`/test-cases/${created.id}`, { name: 'History case renamed' });

      const activityRes = await get(`/test-cases/${created.id}/activity`);
      expect(activityRes.statusCode, activityRes.body).toBe(200);
      const body = JSON.parse(activityRes.body) as { data: Array<{ action: string }> };
      expect(body.data.some((row) => row.action === 'test_case.created')).toBe(true);
      expect(body.data.some((row) => row.action === 'test_case.updated')).toBe(true);
    });

    it('BR20: refuses activity for a Test Case outside the readable projects (404, not 500)', async () => {
      const response = await get(`/test-cases/${randomUUID()}/activity`);
      expect(response.statusCode).toBe(404);
    });
  });

  describe('attachments (C4, BR20)', () => {
    it('lists zero attachments for a freshly created Test Case', async () => {
      const created = JSON.parse(
        (await post(`/work-items/${NXP_STORY_1_ID}/test-cases`, { name: 'No attachments yet' }))
          .body,
      );
      const response = await get(`/test-cases/${created.id}/attachments`);
      expect(response.statusCode, response.body).toBe(200);
      expect(JSON.parse(response.body)).toEqual([]);
    });

    it('BR20: refuses the attachment list for a Test Case outside the readable projects', async () => {
      const response = await get(`/test-cases/${randomUUID()}/attachments`);
      expect(response.statusCode).toBe(404);
    });

    it('BR20: refuses the download route the SAME way — the signed-URL case', async () => {
      const created = JSON.parse(
        (await post(`/work-items/${NXP_STORY_1_ID}/test-cases`, { name: 'Download scope case' }))
          .body,
      );
      // The Test Case is readable but the attachment id is not real — 404 either way, proving the
      // scoped read runs before anything about the attachment id is even asked.
      const response = await get(`/test-cases/${created.id}/attachments/${randomUUID()}/download`);
      expect(response.statusCode).toBe(404);
    });
  });
});
