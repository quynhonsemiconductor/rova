/**
 * A Task's own id, over REAL HTTP, through the guard.
 *
 * The gap this closes. `ProjectScopeResolver` mapped the `work_item` resource kind to the
 * `work_items` table, but tasks moved out of it at the Phase 3 split (migration 0072: "nothing
 * inserts a task into work_items"). The ROUTES did not split with them — `PATCH /work-items/:id`,
 * `/:id/activity`, `/:id/attachments`, `/:id/watchers` and `PATCH /team-status/tasks/:taskId` all
 * take a task's own id. So `@RequirePermission(..., { resource: 'work_item', from: 'param' })`
 * resolved nothing and the guard threw `WORK_ITEM_NOT_FOUND` before the handler ran — as a Workspace
 * Admin, so permission never entered into it.
 *
 * Measured before the fix: GET, `/activity` and `/attachments` on a task all answered 404 while the
 * parent story answered 200. A Task was therefore uneditable everywhere (Tasks tab, Task Detail,
 * Team Status), its Revision History permanently empty and its attachments unreachable — four Phase 1
 * SRS contracts dead on one line of table mapping.
 *
 * Why no existing test saw it: every task spec calls `WorkItemsService` directly, which skips
 * `PolicyGuard` entirely. This one drives `app.inject()` for the same reason
 * `report-authz.e2e.spec.ts` does — a guard defect is only visible from the outside.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WorkItemsService } from '@modules/work-items';
import { AppModule } from '../../apps/api/src/app.module';
import { adminActor, uniqueKey } from './support/flow-harness';
import { NXP_ITER_CURRENT_ID, SEED_PROJECTS, TEAM_ALPHA_ID } from '../../db/seeds/constants';
import { signIn } from './support/session';

// No `/v1` prefix: `Test.createTestingModule` builds the app without the bootstrap that sets the
// global prefix, so routes are mounted bare here.
describe('task routes resolve a task id (e2e)', () => {
  let app: NestFastifyApplication;
  let items: WorkItemsService;
  let token: string;
  let taskId: string;
  let storyId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    items = app.get(WorkItemsService);
    // The session cookie from test-login; this app has no CSRF hook (that is `bootstrapApp`'s), so no CSRF dance.
    token = await signIn(app, 'admin@qnsc.dev');

    const actor = adminActor();
    const story = await items.createWorkItem(
      actor,
      SEED_PROJECTS[0].id,
      'story',
      `Task route parent ${uniqueKey()}`,
      { iterationId: NXP_ITER_CURRENT_ID, teamId: TEAM_ALPHA_ID },
    );
    storyId = story.id;
    const task = await items.createTask(actor, story.id, `Task route ${uniqueKey()}`, {
      estimateHours: '8',
    });
    taskId = task.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  function get(url: string) {
    return app.inject({ method: 'GET', url, headers: { cookie: token } });
  }

  it('serves a task on every by-id read the routes expose', async () => {
    // Each of these carries the same project-scope decorator, so each failed identically before.
    for (const url of [
      `/work-items/${taskId}`,
      `/work-items/${taskId}/activity?page=1&pageSize=10`,
      `/work-items/${taskId}/attachments`,
      `/work-items/${taskId}/watchers`,
    ]) {
      expect((await get(url)).statusCode, url).toBe(200);
    }
  });

  it('EDITS a task by its own id — the thing that was impossible', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/work-items/${taskId}`,
      headers: { cookie: token },
      payload: { todoHours: '3' },
    });
    expect(response.statusCode, response.body).toBe(200);

    // Persisted, not merely accepted. `Number()` because the DTO serialises hours as a number here
    // while the DB column is numeric(8,2) — the value is the assertion, not its wire shape.
    const after = await get(`/work-items/${taskId}`);
    expect(Number(JSON.parse(after.body).todoHours)).toBe(3);
  });

  it('edits a task through the Team Status route too', async () => {
    // `PATCH /team-status/tasks/:taskId` carries the same decorator against a task id, so it was
    // dead for the same reason — and Team Status is the surface whose whole purpose is editing them.
    //
    // The payload is a STATE change, not `actualHours`: Team Status edits Task Name and Task State
    // only (SRS §9.3/§11 — hours and Owner are read-only there and are edited on the Task
    // Dashboard). This assertion is about the route reaching a task id at all, so any field the
    // surface actually owns proves it.
    const response = await app.inject({
      method: 'PATCH',
      url: `/team-status/tasks/${taskId}`,
      headers: { cookie: token },
      payload: { state: 'In-Progress' },
    });
    expect(response.statusCode, response.body).toBe(200);
  });

  it('REFUSES an hours or Owner patch on the Team Status route (SRS §9.3)', () =>
    Promise.all(
      [{ estimateHours: 3 }, { todoHours: 1 }, { actualHours: 2 }, { assigneeId: null }].map(
        async (payload) => {
          // A silent strip would answer 200 and discard the write, which is worse than a refusal:
          // the grid would show the typed value until its next refetch.
          const response = await app.inject({
            method: 'PATCH',
            url: `/team-status/tasks/${taskId}`,
            headers: { cookie: token },
            payload,
          });
          expect(response.statusCode, response.body).toBe(400);
        },
      ),
    ));

  it('records the edit in the task Revision History', async () => {
    // The history tab was not empty because nothing was logged — it was empty because the read 404'd.
    const response = await get(`/work-items/${taskId}/activity?page=1&pageSize=50`);
    expect(response.statusCode).toBe(200);
    const entries = JSON.parse(response.body).data as Array<{ action: string }>;
    expect(entries.length).toBeGreaterThan(0);
  });

  it("ROUND-TRIPS a task's Notes, which used to vanish while the history claimed a change", async () => {
    /**
     * `work.tasks` had no `notes` column, but `UpdateWorkItemSchema` accepted the field, the detail
     * page rendered the editor for a Task with no `isTask` guard, `activity-diff` kept `notes` in
     * `TASK_FIELDS`, and the repository hard-coded `notes: null` on every task read. So the write
     * returned 200, the Revision History recorded a Notes change, and the text was gone on the next
     * read — the one thing a revision log must never do.
     *
     * Phase 1.6 maps Notes for Story/Defect/Task, so migration 0096 adds the column rather than
     * hiding the field. Only reachable at all once the routes above stopped 404ing, which is why it
     * belongs in the same change.
     */
    const written = await app.inject({
      method: 'PATCH',
      url: `/work-items/${taskId}`,
      headers: { cookie: token },
      payload: { notes: '<p>Blocked on the infra ticket</p>' },
    });
    expect(written.statusCode, written.body).toBe(200);

    const after = await get(`/work-items/${taskId}`);
    expect(JSON.parse(after.body).notes).toContain('Blocked on the infra ticket');
  });

  it('still 404s an id that belongs to nothing', async () => {
    // The fallback must not turn a bad id into a 403 or a 500. A random uuid is in neither table.
    expect((await get(`/work-items/${randomUUID()}`)).statusCode).toBe(404);
  });

  it('leaves the parent story reachable, unchanged', async () => {
    // The fallback is additive: the common case is a story or defect and never reaches the tasks
    // table at all.
    expect((await get(`/work-items/${storyId}`)).statusCode).toBe(200);
  });
});
