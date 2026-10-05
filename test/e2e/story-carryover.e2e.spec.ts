/**
 * Phase 7 Story Target End Date + Carryover over REAL HTTP, asserted against STORED ROWS
 * (plan Tasks 3, 5, 6, 8, 9, 10, 11 — BR-01/04/05/12…33/35…46).
 *
 * FIXTURES (plan D13): strict team equality (R7) leaves the seed with no valid target for a Team
 * Alpha Story — NXP's only future sprint is team-less — so this file builds its OWN Team Alpha
 * Iterations, far in the future (2030) and each in its own timebox group, so no other report spec's
 * fused timebox can pick them up. Stories are created in the seeded NXP project (the
 * `e2e-fixtures` ratchet caps `createProject`). Nothing is hard-deleted afterwards: Carryover events
 * are immutable by design (CO-BR-46) and `global-setup.ts` truncates once per run.
 *
 * NO `/v1` PREFIX — `Test.createTestingModule` mounts routes bare.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AuthService, EntraTokenVerifier, type EntraClaims } from '@quynhonsemiconductor/identity';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DRIZZLE } from '@platform';
import type { DrizzleDB, JwtPayload } from '@platform';
import { WorkItemsService } from '@modules/work-items';
import { ReportingService } from '@modules/reporting';
import {
  REPORTING_REPOSITORY,
  type IReportingRepository,
} from '../../libs/modules/reporting/src/domain/ports/reporting.repository';
import { AppModule } from '../../apps/api/src/app.module';
import {
  activityLogs,
  iterationTransitionTasks,
  iterationTransitions,
  iterations,
  tasks,
  workItems,
} from '../../db/schema/work';
import { SEED_PROJECTS, TEAM_ALPHA_ID, WORKSPACE_ID } from '../../db/seeds/constants';
import { adminActor, grantProjectAccess } from './support/flow-harness';
import { SSO_EMAIL_DOMAIN, SSO_TENANT_ID } from './support/sso-env';

const NXP = SEED_PROJECTS[0].id;

/** A copy of `row` without `keys` — "every other column is unchanged". */
function omit(row: object, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));
}

describe('Story Target End Date + Carryover (Phase 7 CO)', () => {
  let app: NestFastifyApplication;
  let db: DrizzleDB;
  let token: string;
  let actor: JwtPayload;
  let service: WorkItemsService;
  let reporting: ReportingService;

  // Team Alpha sprints: A (current), B and O (overlapping), C later; plus SHARED (team-less).
  const it_ = {
    A: randomUUID(),
    B: randomUUID(),
    O: randomUUID(),
    C: randomUUID(),
    SHARED: randomUUID(),
    ACCEPTED: randomUUID(),
  };

  async function addIteration(
    id: string,
    name: string,
    startDate: string,
    endDate: string,
    state: 'planning' | 'committed' | 'accepted',
    teamId: string | null = TEAM_ALPHA_ID,
  ) {
    await db.insert(iterations).values({
      id,
      workspaceId: WORKSPACE_ID,
      projectId: NXP,
      teamId,
      name,
      state,
      startDate,
      endDate,
      timeboxGroupId: randomUUID(),
    });
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

    db = app.get<DrizzleDB>(DRIZZLE);
    token = (await app.get(AuthService).devLogin('admin@qnsc.dev', '127.0.0.1')).accessToken;
    actor = adminActor();
    service = app.get(WorkItemsService);
    reporting = app.get(ReportingService);

    await addIteration(it_.A, 'CO Sprint A', '2030-01-07', '2030-01-18', 'committed');
    await addIteration(it_.B, 'CO Sprint B', '2030-01-21', '2030-02-01', 'planning');
    await addIteration(it_.O, 'CO Sprint O', '2030-01-28', '2030-02-08', 'planning');
    await addIteration(it_.C, 'CO Sprint C', '2030-02-11', '2030-02-22', 'planning');
    await addIteration(it_.SHARED, 'CO Shared', '2030-03-04', '2030-03-15', 'planning', null);
    await addIteration(it_.ACCEPTED, 'CO Accepted', '2030-03-18', '2030-03-29', 'accepted');
  });

  afterAll(async () => {
    /**
     * Neutralise this file's Iterations for every LATER spec: `split-story-routes` asserts nothing in
     * NXP is later than Sprint 26.2, and an open 2030 sprint is a valid Split target. Not deleted —
     * this file's Split case references them from `story_splits`, which takes no ON DELETE action —
     * but `accepted`, which is never a Split or Carryover target.
     */
    if (db) {
      await db.execute(
        sql`update work.iterations set state = 'accepted' where id in (${sql.join(
          Object.values(it_).map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`,
      );
    }
    await app?.close();
  });

  async function makeStory(title: string, taskActuals: number[] = [], iterationId = it_.A) {
    const story = await service.createWorkItem(actor, NXP, 'story', title, {
      teamId: TEAM_ALPHA_ID,
      iterationId,
      scheduleState: 'defined',
    });
    const taskIds: string[] = [];
    for (const [i, actual] of taskActuals.entries()) {
      const task = await service.createTask(actor, story.id, `${title} T${i + 1}`, {
        teamId: TEAM_ALPHA_ID,
        state: 'in_progress',
        estimateHours: '8',
        todoHours: '5',
        actualHours: String(actual),
      });
      taskIds.push(task.id);
    }
    return { story, taskIds };
  }

  const auth = (t = token) => ({ authorization: `Bearer ${t}` });
  const patch = (id: string, payload: Record<string, unknown>, t = token) =>
    app.inject({ method: 'PATCH', url: `/work-items/${id}`, headers: auth(t), payload });
  const carry = (id: string, payload: Record<string, unknown>, t = token) =>
    app.inject({ method: 'POST', url: `/work-items/${id}/carryover`, headers: auth(t), payload });
  const transitionsOf = (storyId: string) =>
    db
      .select()
      .from(iterationTransitions)
      .where(eq(iterationTransitions.storyId, storyId))
      .orderBy(asc(iterationTransitions.occurredAt), asc(iterationTransitions.id));
  const storyRow = async (id: string) =>
    (await db.select().from(workItems).where(eq(workItems.id, id)).limit(1))[0];

  // ── Task 3 — picker + PATCH validation ──────────────────────────────────────

  it('serves the eligible window: current + later same-team open sprints only (R7/R9)', async () => {
    const { story } = await makeStory('CO options', [0, 0]);
    const res = await app.inject({
      method: 'GET',
      url: `/work-items/${story.id}/carryover-options`,
      headers: auth(),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.eligibleIterations.map((i: { id: string }) => i.id)).toEqual([
      it_.A,
      it_.B,
      it_.O,
      it_.C,
    ]);
    expect(body).toMatchObject({
      editable: true,
      minDate: '2030-01-07',
      taskCount: 2,
      unfinishedTaskCount: 2,
    });
  });

  it('saves a date inside the current sprint without moving or recording anything (BR-17)', async () => {
    const { story } = await makeStory('CO inside');
    const res = await patch(story.id, { targetEndDate: '2030-01-15' });
    expect(res.statusCode, res.body).toBe(200);
    const row = await storyRow(story.id);
    expect(row.targetEndDate).toBe('2030-01-15');
    expect(row.iterationId).toBe(it_.A);
    expect(await transitionsOf(story.id)).toHaveLength(0);
    const logged = await db
      .select({ action: activityLogs.action })
      .from(activityLogs)
      .where(eq(activityLogs.entityId, story.id));
    expect(logged.map((l) => l.action)).toContain('work_item.target_end_date_changed');
  });

  it.each([
    ['after the current sprint', '2030-01-25', 'TARGET_END_REQUIRES_CARRYOVER'],
    ['outside every eligible sprint', '2030-03-10', 'TARGET_END_DATE_INVALID'],
    ['before the window', '2029-12-01', 'TARGET_END_DATE_INVALID'],
  ])('refuses a date %s with 412 %s', async (_label, date, code) => {
    const { story } = await makeStory(`CO refuse ${code}`);
    const res = await patch(story.id, { targetEndDate: date });
    expect(res.statusCode).toBe(412);
    expect(JSON.parse(res.body).code ?? res.body).toContain(code);
    expect((await storyRow(story.id)).targetEndDate).toBeNull();
  });

  it('refuses a Target End Date on a Defect (BR-01)', async () => {
    const defect = await service.createWorkItem(actor, NXP, 'defect', 'CO defect', {
      teamId: TEAM_ALPHA_ID,
      iterationId: it_.A,
    });
    const res = await patch(defect.id, { targetEndDate: '2030-01-15' });
    expect(res.statusCode).toBe(412);
    expect(res.body).toContain('TARGET_END_NOT_SUPPORTED');
  });

  // ── Task 5 — the atomic same-ID Carryover ───────────────────────────────────

  it('carries the SAME Story forward, Tasks follow, exactly one event + one snapshot per Task', async () => {
    const { story, taskIds } = await makeStory('CO commit', [3, 1]);
    const beforeStory = await storyRow(story.id);
    const beforeTasks = await db.select().from(tasks).where(eq(tasks.parentId, story.id));
    const sourceBefore = (await db.select().from(iterations).where(eq(iterations.id, it_.A)))[0];

    const res = await carry(story.id, {
      expectedSourceIterationId: it_.A,
      targetIterationId: it_.B,
      targetEndDate: '2030-01-25',
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.workItem.id).toBe(story.id);

    // BR-22/24 — same row; only iteration, Target End and the audit columns changed.
    const after = await storyRow(story.id);
    expect(after.iterationId).toBe(it_.B);
    expect(after.targetEndDate).toBe('2030-01-25');
    const strip = (r: object) =>
      omit(r, ['iterationId', 'targetEndDate', 'updatedAt', 'updatedBy']);
    expect(strip(after)).toEqual(strip(beforeStory));

    // BR-23/29 — every Task follows; nothing else on it changes.
    const afterTasks = await db.select().from(tasks).where(eq(tasks.parentId, story.id));
    for (const task of afterTasks) {
      const prior = beforeTasks.find((t) => t.id === task.id)!;
      expect(task.iterationId).toBe(it_.B);
      expect(omit(task, ['iterationId', 'updatedAt'])).toEqual(
        omit(prior, ['iterationId', 'updatedAt']),
      );
    }

    // BR-30/43 — one event, one snapshot per Task.
    const events = await transitionsOf(story.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'carryover',
      sourceIterationId: it_.A,
      targetIterationId: it_.B,
      targetEndDate: '2030-01-25',
    });
    const snaps = await db
      .select()
      .from(iterationTransitionTasks)
      .where(eq(iterationTransitionTasks.transitionId, events[0].id));
    expect(snaps.map((s) => s.taskId).sort()).toEqual([...taskIds].sort());
    expect(snaps.map((s) => Number(s.actualHoursAtMove)).sort()).toEqual([1, 3]);

    // Split Q9 precedent — the source is NOT auto-accepted / changed.
    const sourceAfter = (await db.select().from(iterations).where(eq(iterations.id, it_.A)))[0];
    expect(sourceAfter.state).toBe(sourceBefore.state);

    // BR-44 — one Revision History entry naming both ends and the date.
    const history = await db
      .select()
      .from(activityLogs)
      .where(
        and(eq(activityLogs.entityId, story.id), eq(activityLogs.action, 'work_item.carried_over')),
      );
    expect(history).toHaveLength(1);
    expect(history[0].metadata).toMatchObject({
      sourceIterationName: 'CO Sprint A',
      targetIterationName: 'CO Sprint B',
      targetEndDate: '2030-01-25',
    });
    expect(history[0].actorId).toBe(actor.sub);
  });

  it('requires a target when the date resolves to several overlapping sprints (BR-20)', async () => {
    const { story } = await makeStory('CO overlap');
    // 2030-01-30 is in both B and O — either is valid, C is not.
    const bad = await carry(story.id, {
      expectedSourceIterationId: it_.A,
      targetIterationId: it_.C,
      targetEndDate: '2030-01-30',
    });
    expect(bad.statusCode).toBe(412);
    expect(bad.body).toContain('CARRYOVER_TARGET_INVALID');
    const ok = await carry(story.id, {
      expectedSourceIterationId: it_.A,
      targetIterationId: it_.O,
      targetEndDate: '2030-01-30',
    });
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it('turns two concurrent confirms into one 201, one 412 and ONE event (BR-43)', async () => {
    const { story } = await makeStory('CO concurrent', [2]);
    const payload = {
      expectedSourceIterationId: it_.A,
      targetIterationId: it_.B,
      targetEndDate: '2030-01-25',
    };
    const results = await Promise.all([carry(story.id, payload), carry(story.id, payload)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 412]);
    // A retry of the same confirm is refused the same way.
    expect((await carry(story.id, payload)).statusCode).toBe(412);
    expect(await transitionsOf(story.id)).toHaveLength(1);
  });

  it('records repeated Carryovers as ordered events and leaves the first unchanged', async () => {
    const { story } = await makeStory('CO repeat', [1]);
    await carry(story.id, {
      expectedSourceIterationId: it_.A,
      targetIterationId: it_.B,
      targetEndDate: '2030-01-25',
    });
    const first = (await transitionsOf(story.id))[0];
    const second = await carry(story.id, {
      expectedSourceIterationId: it_.B,
      targetIterationId: it_.C,
      targetEndDate: '2030-02-15',
    });
    expect(second.statusCode, second.body).toBe(201);
    const events = await transitionsOf(story.id);
    expect(events.map((e) => [e.sourceIterationId, e.targetIterationId])).toEqual([
      [it_.A, it_.B],
      [it_.B, it_.C],
    ]);
    expect(events[0]).toEqual(first);
  });

  it('refuses UPDATE and DELETE on event rows (BR-46)', async () => {
    const { story } = await makeStory('CO immutable', [1]);
    await carry(story.id, {
      expectedSourceIterationId: it_.A,
      targetIterationId: it_.B,
      targetEndDate: '2030-01-25',
    });
    const [event] = await transitionsOf(story.id);
    // Drizzle wraps the driver error; the trigger's message is on `.cause`.
    const refusal = async (statement: ReturnType<typeof sql>) => {
      const err = await db.execute(statement).then(
        () => null,
        (e: unknown) => e as { cause?: { message?: string } },
      );
      return err?.cause?.message ?? '';
    };
    expect(
      await refusal(
        sql`update work.iteration_transitions set target_end_date = '2030-01-26' where id = ${event.id}`,
      ),
    ).toMatch(/immutable/);
    expect(
      await refusal(sql`delete from work.iteration_transitions where id = ${event.id}`),
    ).toMatch(/immutable/);
    expect(
      await refusal(
        sql`update work.iteration_transition_tasks set actual_hours_at_move = 99 where transition_id = ${event.id}`,
      ),
    ).toMatch(/immutable/);
  });

  it('refuses a Defect, an accepted target and an Editor with no Team in the project', async () => {
    const defect = await service.createWorkItem(actor, NXP, 'defect', 'CO defect carry', {
      teamId: TEAM_ALPHA_ID,
      iterationId: it_.A,
    });
    const d = await carry(defect.id, {
      expectedSourceIterationId: it_.A,
      targetIterationId: it_.B,
      targetEndDate: '2030-01-25',
    });
    expect(d.body).toContain('CARRYOVER_NOT_ELIGIBLE');

    const { story } = await makeStory('CO authz');
    const accepted = await carry(story.id, {
      expectedSourceIterationId: it_.A,
      targetIterationId: it_.ACCEPTED,
      targetEndDate: '2030-03-20',
    });
    expect(accepted.body).toContain('CARRYOVER_TARGET_INVALID');

    const editor = await ssoUser('co-editor');
    await grantProjectAccess(app, editor.userId, NXP, 'editor');
    const refused = await carry(
      story.id,
      { expectedSourceIterationId: it_.A, targetIterationId: it_.B, targetEndDate: '2030-01-25' },
      editor.token,
    );
    expect(refused.statusCode).toBe(403);
    expect(await transitionsOf(story.id)).toHaveLength(0);
  });

  // ── Task 6 — Manual Move + independent clearing ─────────────────────────────

  it('records a Manual Move back, keeps the Carryover event, and clearing changes nothing else', async () => {
    const { story } = await makeStory('CO manual', [2]);
    await carry(story.id, {
      expectedSourceIterationId: it_.A,
      targetIterationId: it_.B,
      targetEndDate: '2030-01-25',
    });
    const back = await patch(story.id, { iterationId: it_.A });
    expect(back.statusCode, back.body).toBe(200);

    const events = await transitionsOf(story.id);
    expect(events.map((e) => e.type)).toEqual(['carryover', 'manual_move']);
    const manualSnaps = await db
      .select()
      .from(iterationTransitionTasks)
      .where(eq(iterationTransitionTasks.transitionId, events[1].id));
    expect(manualSnaps).toHaveLength(0);
    const taskRows = await db.select().from(tasks).where(eq(tasks.parentId, story.id));
    expect(taskRows.every((t) => t.iterationId === it_.A)).toBe(true);

    const cleared = await patch(story.id, { targetEndDate: null });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect((await storyRow(story.id)).iterationId).toBe(it_.A);
    expect(await transitionsOf(story.id)).toEqual(events);
  });

  it('records a Manual Move per Story on bulk assign, none for a Defect, and to/from Unscheduled', async () => {
    const { story } = await makeStory('CO bulk');
    const defect = await service.createWorkItem(actor, NXP, 'defect', 'CO bulk defect', {
      teamId: TEAM_ALPHA_ID,
      iterationId: it_.A,
    });
    const res = await app.inject({
      method: 'PATCH',
      url: '/work-items/bulk-iteration',
      headers: auth(),
      payload: { projectId: NXP, itemIds: [story.id, defect.id], iterationId: null },
    });
    expect(res.statusCode, res.body).toBe(200);
    const events = await transitionsOf(story.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'manual_move',
      sourceIterationId: it_.A,
      targetIterationId: null,
    });
    expect(await transitionsOf(defect.id)).toHaveLength(0);
  });

  it('writes no Manual Move for Split’s [Continued] move', async () => {
    const { story } = await makeStory('CO split', [1]);
    const res = await app.inject({
      method: 'POST',
      url: `/work-items/${story.id}/split`,
      headers: auth(),
      payload: {
        expectedSourceIterationId: it_.A,
        targetIterationId: it_.C,
        unfinished: { title: '[Unfinished] CO split', planEstimate: null },
        continued: {
          title: '[Continued] CO split',
          planEstimate: null,
          releaseId: null,
          scheduleState: 'defined',
        },
        unfinishedTaskIds: [],
        unfinishedDefectIds: [],
        unfinishedTestCaseIds: [],
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(await transitionsOf(story.id)).toHaveLength(0);
  });

  // ── Tasks 8–10 — reports ───────────────────────────────────────────────────

  it('attributes a Task’s Actual 3 / 4 / 3 across A → B → C in Team Capacity (BR-31…33)', async () => {
    const { story, taskIds } = await makeStory('CO capacity', [3]);
    await carry(story.id, {
      expectedSourceIterationId: it_.A,
      targetIterationId: it_.B,
      targetEndDate: '2030-01-25',
    });
    await service.updateWorkItem(actor, taskIds[0], { actualHours: '7.00' });
    await carry(story.id, {
      expectedSourceIterationId: it_.B,
      targetIterationId: it_.C,
      targetEndDate: '2030-02-15',
    });
    await service.updateWorkItem(actor, taskIds[0], { actualHours: '10.00' });

    // Other tests in this file also put Tasks in A/B/C, so the attribution of THIS Task is read from
    // the repository rows the roll-up consumes, filtered by task id.
    const repo = app.get<IReportingRepository>(REPORTING_REPOSITORY);
    const hoursOf = async (iterationId: string) =>
      (
        await repo.getScopedTaskHours(WORKSPACE_ID, NXP, [iterationId], {
          kind: 'team',
          teamId: TEAM_ALPHA_ID,
        })
      ).filter((r) => r.taskId === taskIds[0]);
    const [a, b, c] = await Promise.all([hoursOf(it_.A), hoursOf(it_.B), hoursOf(it_.C)]);
    expect(a.map((r) => r.actualHours)).toEqual([3]);
    expect(b.map((r) => r.actualHours)).toEqual([4]);
    expect(c.map((r) => r.actualHours)).toEqual([3]);
    // Estimate / To Do only where the Task lives now.
    expect(a[0].estimateHours + b[0].estimateHours).toBe(0);
    expect(c[0].estimateHours).toBe(8);
    // Task Detail keeps the full cumulative Actual.
    const totals = await service.getTaskTotals(actor, story.id);
    expect(totals.actualHours).toBe(10);
  });

  it('badges Burndown/Capacity and serves the dedicated report with Direction filtering', async () => {
    const { story } = await makeStory('CO report', [2]);
    await carry(story.id, {
      expectedSourceIterationId: it_.A,
      targetIterationId: it_.B,
      targetEndDate: '2030-01-25',
    });

    const sourceBurndown = await reporting.getIterationBurndown(actor, {
      projectId: NXP,
      iterationId: it_.A,
    });
    expect(sourceBurndown.carryover?.carryOut).toBeGreaterThanOrEqual(1);
    const targetCapacity = await reporting.getTeamCapacity(actor, {
      projectId: NXP,
      iterationId: it_.B,
    });
    expect(targetCapacity.carryover?.carryIn).toBeGreaterThanOrEqual(1);

    const all = await reporting.getCarryover(actor, { projectId: NXP, iterationId: it_.B });
    const out = await reporting.getCarryover(actor, {
      projectId: NXP,
      iterationId: it_.B,
      direction: 'out',
    });
    // Direction narrows rows only — KPIs are identical.
    expect(out.kpis).toEqual(all.kpis);
    expect(all.rows.some((r) => r.storyId === story.id && r.direction === 'in')).toBe(true);
    expect(out.rows.every((r) => r.direction === 'out')).toBe(true);
    // Only Carryover events: the Manual Move and the Split from earlier tests are not rows.
    expect(all.rows.every((r) => r.transitionId.length > 0)).toBe(true);
    const manualIds = (
      await db
        .select({ id: iterationTransitions.id })
        .from(iterationTransitions)
        .where(eq(iterationTransitions.type, 'manual_move'))
    ).map((r) => r.id);
    expect(all.rows.some((r) => manualIds.includes(r.transitionId))).toBe(false);
    expect(all.trend.map((t) => t.iterationId)).toContain(it_.B);
  });

  // ── Task 11 — export authz + parity ─────────────────────────────────────────

  async function ssoUser(prefix: string): Promise<{ userId: string; token: string }> {
    const claims: EntraClaims = {
      oid: `${prefix}-${randomUUID()}`,
      email: `${prefix}-${randomUUID().slice(0, 8)}@${SSO_EMAIL_DOMAIN}`,
      displayName: `E2E ${prefix}`,
      externalTenantId: SSO_TENANT_ID,
      roles: [],
    };
    const session = await app.get(AuthService).ssoLogin(JSON.stringify(claims), '127.0.0.1');
    const userId = JSON.parse(
      Buffer.from(session.accessToken.split('.')[1], 'base64url').toString(),
    )['sub'] as string;
    return { userId, token: session.accessToken };
  }

  it('exports CSV to Workspace Admin and Project Admin only, matching the JSON report', async () => {
    const exports = [
      `/reports/iteration-burndown/export?projectId=${NXP}&iterationId=${it_.A}`,
      `/reports/velocity/export?projectId=${NXP}&window=5`,
      `/reports/team-capacity/export?projectId=${NXP}&iterationId=${it_.B}`,
      `/reports/carryover/export?projectId=${NXP}&iterationId=${it_.B}&direction=in`,
    ];
    const projectAdmin = await ssoUser('co-padmin');
    await grantProjectAccess(app, projectAdmin.userId, NXP, 'admin');
    const editor = await ssoUser('co-exp-editor');
    await grantProjectAccess(app, editor.userId, NXP, 'editor');

    for (const url of exports) {
      const asAdmin = await app.inject({ method: 'GET', url, headers: auth() });
      expect(asAdmin.statusCode, `${url} admin`).toBe(200);
      expect(asAdmin.headers['content-type']).toContain('text/csv');
      expect(String(asAdmin.headers['content-disposition'])).toMatch(
        /^attachment; filename=".+\.csv"$/,
      );
      const asProjectAdmin = await app.inject({
        method: 'GET',
        url,
        headers: auth(projectAdmin.token),
      });
      expect(asProjectAdmin.statusCode, `${url} project admin`).toBe(200);
      const asEditor = await app.inject({ method: 'GET', url, headers: auth(editor.token) });
      expect(asEditor.statusCode, `${url} editor`).toBe(403);
    }

    // Parity: the Carryover CSV has exactly the JSON rows under the same filter.
    const json = await reporting.getCarryover(actor, {
      projectId: NXP,
      iterationId: it_.B,
      direction: 'in',
    });
    const csv = (
      await app.inject({ method: 'GET', url: exports[3], headers: auth() })
    ).body.replace(/^\uFEFF/, '');
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe(
      'Direction,Work Item,Name,From,To,Moved On,Start Date,Target End,Estimate (h),To Do (h),Actual Before (h),Actual After (h)',
    );
    expect(lines.length - 1).toBe(json.rows.length);
    expect(lines.slice(1).every((l) => l.startsWith('Carry In,'))).toBe(true);
  });
});
