/**
 * `Dev Owner` must SURVIVE a reload, and the surface that edits it must be the surface that reads it.
 *
 * `GAP-P2-IS-004` (BA DEV Handoff retest 2026-08-17, Confirmed Fail): on `Track > Iteration Status`
 * the inline `Dev Owner` dropdown offered a valid user, the write reported success and the name
 * appeared on the row — and after a reload the cell read `No Entry` again.
 *
 * `P2-IS-FR-032C` is the rule: "an Owner/Dev Owner that updated successfully must remain after a
 * refresh or reload". AC3 adds that every surface sharing the Work Item must read the SAME value
 * rather than keeping local state at Iteration Status.
 *
 * Why over real HTTP and why BOTH endpoints in one file: `work_items.dev_owner_id` is written by
 * `PATCH /work-items/:id` and read back by `GET /iteration-status`, which is a DIFFERENT repository
 * with its own projection. Nothing in the suite covered `devOwnerId` at all before this — a
 * service-level spec would have proven the column is writable without proving the screen's own feed
 * returns it, and this defect is exactly the gap between those two claims.
 *
 * The session cookie from identity's test-login (`support/session.ts`). The test app is built without `bootstrapApp`, so it has
 * no `/v1` prefix, no cookie plugin and no CSRF hook; a spec that needs those boots `createBootstrappedApp()`.
 */
import 'reflect-metadata';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../apps/api/src/app.module';
import {
  DEVELOPER_ID,
  NXP_ITER_CURRENT_ID,
  NXP_STORY_1_ID,
  SEED_PROJECTS,
} from '../../db/seeds/constants';
import { signIn } from './support/session';

const NXP_PROJECT_ID = SEED_PROJECTS[0].id;

describe('Dev Owner persistence (GAP-P2-IS-004)', () => {
  let app: NestFastifyApplication;
  let token: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const session = { accessToken: await signIn(app, 'dev@qnsc.dev') };
    token = session.accessToken;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  const authed = (
    method: 'GET' | 'PATCH' | 'POST',
    url: string,
    payload?: Record<string, unknown>,
  ) => app.inject({ method, url, headers: { cookie: token }, payload });

  it('writes Dev Owner, returns it, and still returns it on a fresh read', async () => {
    const patch = await authed('PATCH', `/work-items/${NXP_STORY_1_ID}`, {
      devOwnerId: DEVELOPER_ID,
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().devOwnerId).toBe(DEVELOPER_ID);

    // The reload: a NEW request against the record endpoint, not the mutation's own response body.
    const reread = await authed('GET', `/work-items/${NXP_STORY_1_ID}`);
    expect(reread.statusCode).toBe(200);
    expect(reread.json().devOwnerId).toBe(DEVELOPER_ID);
  });

  it('returns Dev Owner on the ITERATION STATUS feed — the screen that edits it (AC2/AC3)', async () => {
    await authed('PATCH', `/work-items/${NXP_STORY_1_ID}`, { devOwnerId: DEVELOPER_ID });

    const status = await authed('GET', `/iterations/${NXP_ITER_CURRENT_ID}/status?limit=50`);
    expect(status.statusCode).toBe(200);
    const row = (status.json().items as Array<{ id: string; devOwnerId: string | null }>).find(
      (r) => r.id === NXP_STORY_1_ID,
    );
    expect(row).toBeDefined();
    expect(row?.devOwnerId).toBe(DEVELOPER_ID);
  });

  it('clears Dev Owner on an explicit null and keeps it cleared', async () => {
    await authed('PATCH', `/work-items/${NXP_STORY_1_ID}`, { devOwnerId: DEVELOPER_ID });

    const cleared = await authed('PATCH', `/work-items/${NXP_STORY_1_ID}`, { devOwnerId: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().devOwnerId).toBeNull();
    expect((await authed('GET', `/work-items/${NXP_STORY_1_ID}`)).json().devOwnerId).toBeNull();
  });

  /**
   * AC4 — "a notification is created only for a successful assignment; fixing persistence must not
   * produce duplicate notifications." Re-sending the SAME Dev Owner is not a new assignment event.
   */
  it('does not treat an unchanged Dev Owner as a new assignment', async () => {
    await authed('PATCH', `/work-items/${NXP_STORY_1_ID}`, { devOwnerId: DEVELOPER_ID });
    const again = await authed('PATCH', `/work-items/${NXP_STORY_1_ID}`, {
      devOwnerId: DEVELOPER_ID,
    });

    expect(again.statusCode).toBe(200);
    expect(again.json().devOwnerId).toBe(DEVELOPER_ID);
  });
  /**
   * DEV OWNER ON A TASK — migration 0127, and the half that could not exist before it.
   *
   * `work.tasks` had no `dev_owner_id`, so `listTasksByParent` projected `null` for the id: the API
   * accepted a `devOwnerId` on a task and dropped it silently, which is the worst of the three
   * possible behaviours (accepted, lost, no error). `P4-NOTIF-DC-012` names Tasks explicitly, so the
   * field has to be real there before a notification can be about it.
   */
  it('persists Dev Owner on a TASK and returns it on the Tasks feed', async () => {
    const created = await authed('POST', `/work-items/${NXP_STORY_1_ID}/tasks`, {
      title: `Dev owner task ${Date.now()}`,
      devOwnerId: DEVELOPER_ID,
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().devOwnerId).toBe(DEVELOPER_ID);

    // The reload, through the feed the Tasks tab actually reads.
    const tasks = await authed('GET', `/work-items/${NXP_STORY_1_ID}/tasks`);
    expect(tasks.statusCode).toBe(200);
    // A typed LOCAL, not an inline `as` on the call: the pre-commit `eslint --fix` strips a redundant
    // assertion and leaves `.find` walking `any`, which CI's stricter test typecheck then rejects
    // (CLAUDE.md records this exact trap).
    const taskRows: Array<{ id: string; devOwnerId: string | null; devOwnerName: string | null }> =
      tasks.json();
    const row = taskRows.find((t) => t.id === created.json().id);
    expect(row?.devOwnerId).toBe(DEVELOPER_ID);
    // And NAMED, so the grid does not depend on a picker feed carrying the person.
    expect(row?.devOwnerName).toBeTruthy();
  });

  it('filters the Backlog by Dev Owner, including the unassigned sentinel', async () => {
    await authed('PATCH', `/work-items/${NXP_STORY_1_ID}`, { devOwnerId: DEVELOPER_ID });

    const mine = await authed(
      'GET',
      `/work-items?projectId=${NXP_PROJECT_ID}&devOwnerId=${DEVELOPER_ID}&limit=100`,
    );
    expect(mine.statusCode, mine.body).toBe(200);
    const ids = (mine.json().data as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(NXP_STORY_1_ID);

    // `unassigned` is a SENTINEL, not a user id: SQL equality never matches NULL, so a filter built
    // as `dev_owner_id = 'unassigned'` would return nothing at all.
    const unassigned = await authed(
      'GET',
      `/work-items?projectId=${NXP_PROJECT_ID}&devOwnerId=unassigned&limit=100`,
    );
    expect(unassigned.statusCode).toBe(200);
    expect((unassigned.json().data as Array<{ id: string }>).map((r) => r.id)).not.toContain(
      NXP_STORY_1_ID,
    );
  });
});
