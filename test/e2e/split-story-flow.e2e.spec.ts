/**
 * `POST /work-items/:id/split` over REAL HTTP (Phase 7 SU-06) — the transaction, against STORED ROWS.
 *
 * This is the file the plan calls the heart of SU-06, and every assertion here reads the DATABASE
 * rather than the response body. That distinction is the point: a service spec can only prove that
 * the service asked for something, and a response can only prove what the serializer chose to say. A
 * Split is a claim about eleven rows in five tables, three DB triggers and one advisory lock — and the
 * only witness to all of it is the data afterwards.
 *
 * WHAT IS ASSERTED FROM THE STORED ROWS: BR-07 (a fresh key), BR-08 (the original id survives),
 * BR-09 (the placeholder stays in the source, Accepted, with the Split timestamp as its accepted
 * date), BR-10 (Release/Feature/parent cleared), BR-11 (the original moves and keeps what the modal
 * did not send), BR-17 (a moved Task changes `parent_id` and NOTHING else — the iteration follows via
 * the trigger), BR-18 (a Defect's own Iteration is untouched), BR-19/BR-20 (a Test Case's Work Product
 * moves and its Results' snapshot does not), BR-29 (the Event and one row per child), BR-31 (Revision
 * History), and §8 Q9 (the source Iteration is NOT auto-accepted).
 *
 * NO `/v1` PREFIX — `Test.createTestingModule` mounts routes bare (see `split-story-routes.e2e.spec.ts`).
 *
 * FIXTURES: created inside the seeded NXP project rather than by `createProject`, which
 * `e2e-fixtures.ratchet.spec.ts` caps. Each test that mutates makes its OWN Story, because a Split is
 * irreversible and a shared row would make the second test depend on the first — the cross-test
 * pollution SU-01 spent a gate round chasing.
 *
 * EXTENDED BY SU-07 (7.5/7.6) with the READ side: `splitLink` from both record routes and from both
 * sides of one Split, its ABSENCE from the grid feed, and a moved Test Case's Result still naming the
 * pre-Split Story when read through `GET /test-results/:id`. Those are route claims, so they belong
 * beside the write they describe rather than in a file of their own.
 */
import 'reflect-metadata';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AuthService, EntraTokenVerifier, type EntraClaims } from '@quynhonsemiconductor/identity';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DRIZZLE } from '@platform';
import type { DrizzleDB, JwtPayload } from '@platform';
import { WorkItemsService } from '@modules/work-items';
import { AppModule } from '../../apps/api/src/app.module';
import {
  activityLogs,
  iterations,
  storySplitItems,
  storySplits,
  tasks,
  testCases,
  testResults,
  workItems,
} from '../../db/schema/work';
import {
  NXP_ITER_CURRENT_ID,
  NXP_ITER_FUTURE_ID,
  SEED_PROJECTS,
  TEAM_ALPHA_ID,
} from '../../db/seeds/constants';
import { adminActor } from './support/flow-harness';

const NXP = SEED_PROJECTS[0].id;

interface SplitBody {
  split: {
    id: string;
    continuedStoryId: string;
    unfinishedStoryId: string;
    sourceIterationId: string;
    targetIterationId: string;
    splitAt: string;
    sourceMarkerDate: string;
    targetMarkerDate: string;
    originalPlanEstimate: number | null;
    movedTodoHours: number;
    actualHoursAtSplit: number;
  };
  unfinished: { id: string; itemKey: string; scheduleState: string; iterationId: string | null };
  continued: { id: string; itemKey: string; iterationId: string | null };
}

describe('POST /work-items/:id/split (SU-06)', () => {
  let app: NestFastifyApplication;
  let db: DrizzleDB;
  let token: string;
  let actor: JwtPayload;
  let workItemsService: WorkItemsService;

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

    db = app.get<DrizzleDB>(DRIZZLE);
    token = (await app.get(AuthService).devLogin('admin@qnsc.dev', '127.0.0.1')).accessToken;
    actor = adminActor();
    workItemsService = app.get(WorkItemsService);
  });

  afterAll(async () => {
    await app?.close();
  });

  /** A splittable Story of its own, with as many children as the case needs. */
  async function makeStory(
    title: string,
    opts: {
      points?: string;
      tasks?: Array<{
        title: string;
        state?: 'defined' | 'completed';
        todo?: number;
        actual?: number;
      }>;
    } = {},
  ) {
    const story = await workItemsService.createWorkItem(actor, NXP, 'story', title, {
      teamId: TEAM_ALPHA_ID,
      iterationId: NXP_ITER_CURRENT_ID,
      scheduleState: 'in_progress',
      storyPoints: opts.points ?? '5',
    });
    const created: string[] = [];
    for (const t of opts.tasks ?? []) {
      const row = await workItemsService.createTask(actor, story.id, t.title, {
        teamId: TEAM_ALPHA_ID,
        // `createTask`'s own field is `state` (a Task has one state, BR-TASK-01) — not
        // `scheduleState`, which is the work-item dimension a Task does not carry.
        state: t.state ?? 'defined',
        todoHours: t.todo === undefined ? undefined : String(t.todo),
        actualHours: t.actual === undefined ? undefined : String(t.actual),
      });
      created.push(row.id);
    }
    return { story, taskIds: created };
  }

  function splitRequest(id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/work-items/${id}/split`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  function payloadFor(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      expectedSourceIterationId: NXP_ITER_CURRENT_ID,
      targetIterationId: NXP_ITER_FUTURE_ID,
      unfinished: { title: '[Unfinished] Split flow', planEstimate: 2 },
      continued: {
        title: '[Continued] Split flow',
        planEstimate: 3,
        releaseId: null,
        scheduleState: 'in_progress',
      },
      unfinishedTaskIds: [],
      unfinishedDefectIds: [],
      unfinishedTestCaseIds: [],
      ...over,
    };
  }

  async function row(id: string) {
    const rows = await db.select().from(workItems).where(eq(workItems.id, id)).limit(1);
    return rows[0];
  }

  // ── The happy path, read back from the database ─────────────────────────────

  it('creates the placeholder and moves the original, and the STORED rows say so', async () => {
    const { story } = await makeStory('SU-06 happy path', { points: '5' });

    const response = await splitRequest(story.id, payloadFor());
    expect(response.statusCode, response.body).toBe(201);
    const body = JSON.parse(response.body) as SplitBody;

    const unfinished = await row(body.unfinished.id);
    const continued = await row(story.id);

    // BR-07 — a FRESH key, not derived from the original's.
    expect(unfinished.itemKey).toMatch(/^US-\d+$/);
    expect(unfinished.itemKey).not.toBe(story.itemKey);
    // BR-08 — the ORIGINAL row is the one that continued. Same id, so its comments, attachments,
    // watchers and history came with it by construction.
    expect(body.split.continuedStoryId).toBe(story.id);
    expect(continued.id).toBe(story.id);
    expect(continued.itemKey).toBe(story.itemKey);

    // BR-09 — the placeholder STAYS in the source, Accepted, and its accepted date IS the Split.
    expect(unfinished.iterationId).toBe(NXP_ITER_CURRENT_ID);
    expect(unfinished.scheduleState).toBe('accepted');
    expect(unfinished.acceptedDate?.toISOString()).toBe(body.split.splitAt);

    // BR-10 — Release, Feature and parent cleared on the placeholder.
    expect(unfinished.releaseId).toBeNull();
    expect(unfinished.featureId).toBeNull();
    expect(unfinished.parentId).toBeNull();

    // BR-11 — the original moved to the target and took the modal's fields.
    expect(continued.iterationId).toBe(NXP_ITER_FUTURE_ID);
    expect(continued.title).toBe('[Continued] Split flow');
    expect(Number(continued.storyPoints)).toBe(3);
    expect(Number(unfinished.storyPoints)).toBe(2);
    // D6 — the placeholder, and ONLY the placeholder, carries the split marker.
    expect(unfinished.splitId).toBe(body.split.id);
    expect(continued.splitId).toBeNull();
  });

  it('copies content and the two owners onto the placeholder, and no collaboration (D12/Q13)', async () => {
    const story = await workItemsService.createWorkItem(actor, NXP, 'story', 'SU-06 content copy', {
      teamId: TEAM_ALPHA_ID,
      iterationId: NXP_ITER_CURRENT_ID,
      scheduleState: 'in_progress',
      description: 'The description',
      acceptanceCriteria: 'The criteria',
      notes: 'The notes',
      priority: 'high',
      assigneeId: actor.sub,
      devOwnerId: actor.sub,
    });

    const response = await splitRequest(story.id, payloadFor());
    expect(response.statusCode, response.body).toBe(201);
    const body = JSON.parse(response.body) as SplitBody;
    const unfinished = await row(body.unfinished.id);

    expect(unfinished.description).toBe('The description');
    expect(unfinished.acceptanceCriteria).toBe('The criteria');
    expect(unfinished.notes).toBe('The notes');
    expect(unfinished.priority).toBe('high');
    expect(unfinished.assigneeId).toBe(actor.sub);
    expect(unfinished.devOwnerId).toBe(actor.sub);
    expect(unfinished.teamId).toBe(TEAM_ALPHA_ID);
  });

  it('moves a Task by `parent_id` only, and the TRIGGER moves its iteration (BR-17/D4)', async () => {
    const { story, taskIds } = await makeStory('SU-06 task move', {
      tasks: [
        { title: 'Moves left', state: 'completed', todo: 0, actual: 4 },
        { title: 'Stays right', state: 'defined', todo: 3, actual: 1 },
      ],
    });
    const [movedId, stayedId] = taskIds;
    const before = (await db.select().from(tasks).where(eq(tasks.id, movedId)).limit(1))[0];

    const response = await splitRequest(story.id, payloadFor({ unfinishedTaskIds: [movedId] }));
    expect(response.statusCode, response.body).toBe(201);
    const body = JSON.parse(response.body) as SplitBody;

    const moved = (await db.select().from(tasks).where(eq(tasks.id, movedId)).limit(1))[0];
    const stayed = (await db.select().from(tasks).where(eq(tasks.id, stayedId)).limit(1))[0];

    // EVERY column except `parent_id` — and `iteration_id`/`updated_at`, which the trigger and the
    // write touch — is byte-identical. This is the assertion BR-17 actually makes.
    expect(moved.parentId).toBe(body.unfinished.id);
    expect(moved.id).toBe(before.id);
    expect(moved.itemKey).toBe(before.itemKey);
    expect(moved.title).toBe(before.title);
    expect(moved.state).toBe(before.state);
    expect(moved.estimateHours).toBe(before.estimateHours);
    expect(moved.todoHours).toBe(before.todoHours);
    expect(moved.actualHours).toBe(before.actualHours);
    expect(moved.assigneeId).toBe(before.assigneeId);
    expect(moved.createdBy).toBe(before.createdBy);
    // D4 — the placeholder stayed in the source, so the Task it followed did too…
    expect(moved.iterationId).toBe(NXP_ITER_CURRENT_ID);
    // …and the one left on `[Continued]` was carried FORWARD by the cascade trigger, without this
    // write ever naming an iteration for it.
    expect(stayed.parentId).toBe(story.id);
    expect(stayed.iterationId).toBe(NXP_ITER_FUTURE_ID);
  });

  it('keeps a Test Case’s Results pointing at the pre-Split Story (BR-19/BR-20, D10)', async () => {
    const { story } = await makeStory('SU-06 test case move');
    // A Test Case with a Result, created through the seeded NXP project so no fixture is invented.
    const [testCase] = await db
      .insert(testCases)
      .values({
        workspaceId: actor.workspaceId,
        projectId: NXP,
        teamId: TEAM_ALPHA_ID,
        workItemId: story.id,
        testCaseKey: 'TC-SU06X',
        name: 'Survives a split',
        type: 'Functional',
        method: 'manual',
        priority: 'normal',
        rank: 'n',
        createdBy: actor.sub,
      })
      .returning();
    await db.insert(testResults).values({
      workspaceId: actor.workspaceId,
      projectId: NXP,
      testCaseId: testCase.id,
      // The SNAPSHOT: the Work Product at result-entry time.
      workItemId: story.id,
      testResultKey: 'TR-SU06X',
      build: 'local',
      runDate: '2026-06-20',
      verdict: 'pass',
      testerId: actor.sub,
      createdBy: actor.sub,
    });

    const response = await splitRequest(
      story.id,
      payloadFor({ unfinishedTestCaseIds: [testCase.id] }),
    );
    expect(response.statusCode, response.body).toBe(201);
    const body = JSON.parse(response.body) as SplitBody;

    const movedCase = (
      await db.select().from(testCases).where(eq(testCases.id, testCase.id)).limit(1)
    )[0];
    const results = await db
      .select()
      .from(testResults)
      .where(eq(testResults.testCaseId, testCase.id));

    // The Work Product moved…
    expect(movedCase.workItemId).toBe(body.unfinished.id);
    // …and the historical evidence did NOT: this is the whole of BR-20, and the reason `test_results`
    // has its own `work_item_id` column.
    expect(results).toHaveLength(1);
    expect(results[0].workItemId).toBe(story.id);
    // `trg_test_case_last_result` does not fire on `work_item_id`, so the verdict still comes from the
    // newest Result.
    expect(movedCase.lastVerdict).toBe('pass');
  });

  it('writes ONE Split Event with a row per child, carrying the effort snapshot (BR-29)', async () => {
    const { story, taskIds } = await makeStory('SU-06 split event', {
      tasks: [
        { title: 'Left', state: 'completed', todo: 0, actual: 4 },
        { title: 'Right', state: 'defined', todo: 6, actual: 1.5 },
      ],
    });

    const response = await splitRequest(story.id, payloadFor({ unfinishedTaskIds: [taskIds[0]] }));
    expect(response.statusCode, response.body).toBe(201);
    const body = JSON.parse(response.body) as SplitBody;

    const events = await db.select().from(storySplits).where(eq(storySplits.id, body.split.id));
    expect(events).toHaveLength(1);
    expect(events[0].sourceIterationId).toBe(NXP_ITER_CURRENT_ID);
    expect(events[0].targetIterationId).toBe(NXP_ITER_FUTURE_ID);
    expect(Number(events[0].originalPlanEstimate)).toBe(5);
    // Σ To Do of the Tasks that went to `[Continued]` — the complement, which is the one the target
    // burndown gains.
    expect(Number(events[0].movedTodoHours)).toBe(6);
    expect(Number(events[0].actualHoursAtSplit)).toBe(5.5);
    // Both marker dates land inside their own iteration's window.
    expect(events[0].sourceMarkerDate <= '2026-06-27').toBe(true);
    expect(events[0].targetMarkerDate >= '2026-06-29').toBe(true);

    const items = await db
      .select()
      .from(storySplitItems)
      .where(eq(storySplitItems.splitId, body.split.id));
    expect(items).toHaveLength(2);
    const left = items.find((i) => i.taskId === taskIds[0]);
    expect(left?.splitSide).toBe('unfinished');
    expect(Number(left?.actualHoursAtSplit)).toBe(4);
    expect(items.find((i) => i.taskId === taskIds[1])?.splitSide).toBe('continued');
  });

  it('records both sides in Revision History (BR-31)', async () => {
    const { story } = await makeStory('SU-06 history');
    const response = await splitRequest(story.id, payloadFor());
    expect(response.statusCode, response.body).toBe(201);
    const body = JSON.parse(response.body) as SplitBody;

    const entries = await db
      .select({ action: activityLogs.action, entityId: activityLogs.entityId })
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.workspaceId, actor.workspaceId),
          sql`${activityLogs.action} in ('work_item.split_out', 'work_item.split_in')`,
        ),
      );
    expect(entries).toEqual(
      expect.arrayContaining([
        { action: 'work_item.split_out', entityId: body.unfinished.id },
        { action: 'work_item.split_in', entityId: story.id },
      ]),
    );
  });

  it('does NOT auto-accept the source Iteration (§8 Q9)', async () => {
    // The original leaves and an `accepted` placeholder lands in its place, which is exactly the shape
    // that would make `autoAcceptIterationIfComplete` close the sprint. It must not run.
    const before = (
      await db.select().from(iterations).where(eq(iterations.id, NXP_ITER_CURRENT_ID)).limit(1)
    )[0];
    const { story } = await makeStory('SU-06 no auto accept');

    const response = await splitRequest(story.id, payloadFor());
    expect(response.statusCode, response.body).toBe(201);

    const after = (
      await db.select().from(iterations).where(eq(iterations.id, NXP_ITER_CURRENT_ID)).limit(1)
    )[0];
    expect(after.state).toBe(before.state);
  });

  // ── Refusals, and that they leave NOTHING behind ────────────────────────────

  it('refuses a stale source Iteration and writes nothing (D9, BR-32)', async () => {
    const { story } = await makeStory('SU-06 stale source');
    const splitsBefore = await db.select().from(storySplits);

    const response = await splitRequest(
      story.id,
      payloadFor({ expectedSourceIterationId: NXP_ITER_FUTURE_ID }),
    );
    expect(response.statusCode).toBe(412);
    expect(JSON.parse(response.body).error.code).toBe('SPLIT_SOURCE_ITERATION_CHANGED');

    // Nothing minted, nothing moved.
    expect((await db.select().from(storySplits)).length).toBe(splitsBefore.length);
    expect((await row(story.id)).iterationId).toBe(NXP_ITER_CURRENT_ID);
  });

  it('refuses a target the picker would not offer, and writes nothing (BR-05)', async () => {
    const { story } = await makeStory('SU-06 bad target');
    const response = await splitRequest(
      story.id,
      // The SOURCE is not later than itself.
      payloadFor({ targetIterationId: NXP_ITER_CURRENT_ID }),
    );
    expect(response.statusCode).toBe(412);
    expect(JSON.parse(response.body).error.code).toBe('SPLIT_TARGET_INVALID');
    expect((await row(story.id)).iterationId).toBe(NXP_ITER_CURRENT_ID);
  });

  it('refuses a child that is not in the Story, and writes nothing (BR-32)', async () => {
    const { story } = await makeStory('SU-06 stranger child');
    const other = await makeStory('SU-06 stranger owner', {
      tasks: [{ title: 'Not yours', state: 'defined' }],
    });

    const response = await splitRequest(
      story.id,
      payloadFor({ unfinishedTaskIds: [other.taskIds[0]] }),
    );
    expect(response.statusCode).toBe(412);
    expect(JSON.parse(response.body).error.code).toBe('SPLIT_ITEM_NOT_IN_STORY');
    // The other Story's Task is untouched — a refusal must not half-apply.
    const stranger = (
      await db.select().from(tasks).where(eq(tasks.id, other.taskIds[0])).limit(1)
    )[0];
    expect(stranger.parentId).toBe(other.story.id);
  });

  it('refuses an already-accepted Story (BR-02)', async () => {
    const story = await workItemsService.createWorkItem(actor, NXP, 'story', 'SU-06 accepted', {
      teamId: TEAM_ALPHA_ID,
      iterationId: NXP_ITER_CURRENT_ID,
      scheduleState: 'accepted',
    });
    const response = await splitRequest(story.id, payloadFor());
    expect(response.statusCode).toBe(412);
    expect(JSON.parse(response.body).error.code).toBe('SPLIT_NOT_ELIGIBLE');
  });

  it('refuses a malformed body BEFORE authorization even looks at it', async () => {
    // The ValidationPipe runs before the guard, so a bad body is a 400 that never reaches the policy —
    // worth pinning, because it is the reason a "403 test" with a typo'd payload passes for the wrong
    // reason.
    const { story } = await makeStory('SU-06 malformed');
    const response = await splitRequest(story.id, { targetIterationId: 'not-a-uuid' });
    expect(response.statusCode).toBe(400);
  });

  // ── Concurrency: two confirms of the same modal ─────────────────────────────

  it('lets exactly ONE of two concurrent confirms win, and mints one placeholder (D9)', async () => {
    const { story } = await makeStory('SU-06 concurrent');

    const [first, second] = await Promise.all([
      splitRequest(story.id, payloadFor()),
      splitRequest(story.id, payloadFor()),
    ]);

    const codes = [first.statusCode, second.statusCode].sort();
    expect(codes).toEqual([201, 412]);
    // ONE Event for this Story, so one placeholder: the loser was refused by the
    // `expectedSourceIterationId` echo, because the winner had already moved the Story forward.
    const events = await db
      .select()
      .from(storySplits)
      .where(eq(storySplits.continuedStoryId, story.id));
    expect(events).toHaveLength(1);
  });

  // ── SU-07: the trace, over the READ routes ──────────────────────────────────

  /**
   * The banner's data, from BOTH record reads and from BOTH sides.
   *
   * The point of asserting over HTTP rather than through the repository is the ROUTE coverage: §8 Q15
   * names `GET /:id`, but the detail page resolves by KEY, so a `splitLink` on one and not the other
   * is a contract that looks complete and renders nothing. And the LIST read is asserted NOT to carry
   * it — a field added to the record shape must not silently join a grid feed.
   */
  function getById(id: string) {
    return app.inject({
      method: 'GET',
      url: `/work-items/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  interface DetailBody {
    id: string;
    itemKey: string;
    splitLink: {
      splitId: string;
      role: 'unfinished' | 'continued';
      sourceIterationId: string;
      sourceIterationName: string | null;
      targetIterationId: string;
      targetIterationName: string | null;
      unfinished: { id: string; itemKey: string; title: string };
      continued: { id: string; itemKey: string; title: string };
    } | null;
  }

  it('returns the counterpart from BOTH sides of a completed Split (SU-07 7.1/7.5)', async () => {
    const { story } = await makeStory('SU-07 trace');
    const response = await splitRequest(story.id, payloadFor());
    expect(response.statusCode, response.body).toBe(201);
    const body = JSON.parse(response.body) as SplitBody;

    const fromContinued = await getById(story.id);
    const fromUnfinished = await getById(body.unfinished.id);
    expect(fromContinued.statusCode).toBe(200);
    expect(fromUnfinished.statusCode).toBe(200);
    const continued = JSON.parse(fromContinued.body) as DetailBody;
    const unfinished = JSON.parse(fromUnfinished.body) as DetailBody;

    // Same Split, same pair, opposite roles — which is the whole of SU-BR-30.
    expect(continued.splitLink?.splitId).toBe(body.split.id);
    expect(unfinished.splitLink?.splitId).toBe(body.split.id);
    expect(continued.splitLink?.role).toBe('continued');
    expect(unfinished.splitLink?.role).toBe('unfinished');
    expect(continued.splitLink?.unfinished.id).toBe(body.unfinished.id);
    expect(continued.splitLink?.continued.id).toBe(story.id);
    expect(unfinished.splitLink?.unfinished.itemKey).toBe(body.unfinished.itemKey);
    expect(unfinished.splitLink?.continued.itemKey).toBe(story.itemKey);

    // The iteration NAMES the bar renders, resolved server-side rather than by a second request.
    expect(continued.splitLink?.sourceIterationId).toBe(NXP_ITER_CURRENT_ID);
    expect(continued.splitLink?.targetIterationId).toBe(NXP_ITER_FUTURE_ID);
    expect(continued.splitLink?.sourceIterationName).not.toBeNull();
    expect(continued.splitLink?.targetIterationName).not.toBeNull();
  });

  it('returns it from `by-key` too — the route the detail page actually calls (§8 Q15 amended)', async () => {
    const { story } = await makeStory('SU-07 by key');
    const response = await splitRequest(story.id, payloadFor());
    expect(response.statusCode, response.body).toBe(201);
    const body = JSON.parse(response.body) as SplitBody;

    const byKey = await app.inject({
      method: 'GET',
      url: `/work-items/by-key?itemKey=${encodeURIComponent(story.itemKey)}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(byKey.statusCode, byKey.body).toBe(200);
    const detail = JSON.parse(byKey.body) as DetailBody;

    // `/item/$itemKey` carries no id, so this is the read the banner is rendered from. Q15's wording
    // named `:id` alone; its reasoning is what makes this route the one that had to carry the field.
    expect(detail.id).toBe(story.id);
    expect(detail.splitLink?.unfinished.id).toBe(body.unfinished.id);
  });

  it('is null on a Story that was never split, and ABSENT from the list feed', async () => {
    const { story } = await makeStory('SU-07 never split');

    const record = await getById(story.id);
    expect(record.statusCode).toBe(200);
    // Present and null — not omitted. A response shape that depends on which branch answered is a
    // shape a client has to guess at.
    expect(JSON.parse(record.body)).toHaveProperty('splitLink', null);

    const list = await app.inject({
      method: 'GET',
      url: `/work-items?projectId=${NXP}&itemKey=${encodeURIComponent(story.itemKey)}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode, list.body).toBe(200);
    const rows = (JSON.parse(list.body) as { data: Array<Record<string, unknown>> }).data;
    expect(rows.length).toBeGreaterThan(0);
    // The GRID feed keeps the narrower schema: a row must not advertise a link its endpoint never
    // resolves. This is the `StoryOptionSchema` boundary, from the other side.
    for (const row of rows) expect(row).not.toHaveProperty('splitLink');
  });

  it('keeps a moved Test Case’s Result naming the pre-Split Story when READ back (SU-07 7.6/AC5)', async () => {
    // SU-06 proved this against the stored column. AC5 is about what a REVIEWER sees, so this asserts
    // the same fact through `GET /test-results/:id` — the surface the claim is actually made on.
    const { story } = await makeStory('SU-07 result evidence');
    const [testCase] = await db
      .insert(testCases)
      .values({
        workspaceId: actor.workspaceId,
        projectId: NXP,
        teamId: TEAM_ALPHA_ID,
        workItemId: story.id,
        // No trailing digits: `nextKeyNumber` parses them as an `int` and a large number overflows,
        // which poisoned two unrelated specs in SU-06.
        testCaseKey: 'TC-SU07X',
        name: 'Evidence survives a split',
        type: 'Functional',
        method: 'manual',
        priority: 'normal',
        rank: 'n',
        createdBy: actor.sub,
      })
      .returning();
    const [result] = await db
      .insert(testResults)
      .values({
        workspaceId: actor.workspaceId,
        projectId: NXP,
        testCaseId: testCase.id,
        workItemId: story.id,
        testResultKey: 'TR-SU07X',
        build: 'local',
        runDate: '2026-06-20',
        verdict: 'pass',
        testerId: actor.sub,
        createdBy: actor.sub,
      })
      .returning();

    const response = await splitRequest(
      story.id,
      payloadFor({ unfinishedTestCaseIds: [testCase.id] }),
    );
    expect(response.statusCode, response.body).toBe(201);
    const body = JSON.parse(response.body) as SplitBody;

    const read = await app.inject({
      method: 'GET',
      url: `/test-results/${result.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(read.statusCode, read.body).toBe(200);
    const dto = JSON.parse(read.body) as { workItemId: string | null };
    // The Work Product captured at result-entry time — the PRE-split Story, not the placeholder the
    // Test Case now hangs off.
    expect(dto.workItemId).toBe(story.id);
    expect(dto.workItemId).not.toBe(body.unfinished.id);
  });
});
