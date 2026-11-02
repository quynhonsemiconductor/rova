/**
 * A Task's Iteration is DERIVED from its parent, and cannot be made to diverge.
 *
 * The BA states it three times — "A Task inherits Project, Team, Iteration and Release/Milestone
 * context THROUGH ITS PARENT Story/Defect" (BUSINESS_BASELINE), "no independent Iteration selector"
 * (P1-TASK-011), "without an independent Task iteration assignment" (P2-IS-024) — and real Rally
 * shows the field read-only. So this is not a cascade that keeps two values in step; the Task owns
 * no value to keep.
 *
 * Both halves are proven here because both were broken: nothing propagated a parent move, and two
 * separate paths let a caller write the column outright. The last case is the one that matters most
 * — `db/seeds/**` writes `work.tasks` in raw SQL, so a rule the service alone enforced would be a
 * rule the fixtures walk around.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { DRIZZLE } from '@platform';
import type { DrizzleDB } from '@platform';
import { WorkItemsService } from '@modules/work-items';
import { ReportingService } from '@modules/reporting';

import { SEEDED, adminActor, bootRovaApp, uniqueKey } from './support/flow-harness';

describe('task iteration is derived from its parent (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DrizzleDB;
  let service: WorkItemsService;
  const actor = adminActor();

  /** A Story in the CURRENT iteration, plus one task under it. */
  async function storyWithTask(): Promise<{ storyId: string; taskId: string }> {
    const story = await service.createWorkItem(
      actor,
      SEEDED.nxp.projectId,
      'story',
      `Derived parent ${uniqueKey()}`,
      { iterationId: SEEDED.nxp.iterationCurrentId, teamId: SEEDED.nxp.teamAlphaId },
    );
    const task = await service.createTask(actor, story.id, `Derived task ${uniqueKey()}`);
    return { storyId: story.id, taskId: task.id };
  }

  async function iterationOf(taskId: string): Promise<string | null> {
    const rows = await db.execute<{ iteration_id: string | null }>(
      sql`select iteration_id from work.tasks where id = ${taskId}::uuid`,
    );
    return rows.rows[0].iteration_id;
  }

  beforeAll(async () => {
    app = await bootRovaApp();
    db = app.get<DrizzleDB>(DRIZZLE);
    service = app.get(WorkItemsService);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('takes the parent iteration on create, with no need to be told', async () => {
    const { taskId } = await storyWithTask();
    expect(await iterationOf(taskId)).toBe(SEEDED.nxp.iterationCurrentId);
  });

  it('follows the parent when the parent MOVES', async () => {
    // The gap this closes: `createTask` inherited once, at birth, and nothing looked at the parent
    // again. Moving the Story left the Task behind in the old sprint, where Iteration Status and
    // Team Status kept counting its hours (P2-IS-024 requires the opposite).
    const { storyId, taskId } = await storyWithTask();

    await service.updateWorkItem(actor, storyId, {
      iterationId: SEEDED.nxp.iterationFutureId,
    });
    expect(await iterationOf(taskId)).toBe(SEEDED.nxp.iterationFutureId);

    // Unassigning is a move too — a Story pulled back to the backlog takes its tasks with it, rather
    // than leaving them credited to a sprint the work is no longer in.
    await service.updateWorkItem(actor, storyId, { iterationId: null });
    expect(await iterationOf(taskId)).toBeNull();
  });

  it('follows a NEW parent when the task is reparented', async () => {
    // TASK-FR-012 allows moving a Task to another Work Product. If the iteration did not follow, the
    // Task would sit under a Story in one sprint while reporting itself in another.
    const first = await storyWithTask();
    const second = await service.createWorkItem(
      actor,
      SEEDED.nxp.projectId,
      'story',
      `Derived new parent ${uniqueKey()}`,
      { iterationId: SEEDED.nxp.iterationPastId, teamId: SEEDED.nxp.teamAlphaId },
    );

    await service.updateWorkItem(actor, first.taskId, { parentId: second.id });
    expect(await iterationOf(first.taskId)).toBe(SEEDED.nxp.iterationPastId);
  });

  it('REFUSES an iteration on update rather than silently discarding it', async () => {
    const { taskId } = await storyWithTask();

    // Refused, not ignored. The trigger would overwrite the value anyway, and an endpoint that
    // accepts a field then drops it teaches the caller the write succeeded — the next read would
    // disagree and the database would look like the culprit.
    await expect(
      service.updateWorkItem(actor, taskId, { iterationId: SEEDED.nxp.iterationFutureId }),
    ).rejects.toMatchObject({ code: 'TASK_ITERATION_DERIVED' });

    expect(await iterationOf(taskId)).toBe(SEEDED.nxp.iterationCurrentId);
  });

  it('REFUSES one on create, through the generic work-item path too', async () => {
    // `POST /work-items` with `type: 'task'` bypasses `createTask` entirely, so a guard only in that
    // wrapper would be a front door with a lock beside a side door without one.
    const story = await service.createWorkItem(
      actor,
      SEEDED.nxp.projectId,
      'story',
      `Derived guard ${uniqueKey()}`,
      { iterationId: SEEDED.nxp.iterationCurrentId, teamId: SEEDED.nxp.teamAlphaId },
    );

    await expect(
      service.createWorkItem(actor, SEEDED.nxp.projectId, 'task', `Guarded ${uniqueKey()}`, {
        parentId: story.id,
        iterationId: SEEDED.nxp.iterationFutureId,
      }),
    ).rejects.toMatchObject({ code: 'TASK_ITERATION_DERIVED' });
  });

  it('overrides a RAW SQL divergence — the shape the seeds can produce', async () => {
    /**
     * The reason this is enforced in the database and not only in the service.
     *
     * `db/seeds/**` inserts into `work.tasks` directly, so a fixture can write any iteration it likes
     * with no code path involved — which is exactly how `US-D2` came to be Team Beta's story inside
     * Team Alpha's Sprint 26.1. `trg_task_iteration_from_parent` re-reads the parent on every write,
     * so the attempt is not rejected so much as irrelevant.
     */
    const { taskId } = await storyWithTask();

    await db.execute(
      sql`update work.tasks set iteration_id = ${SEEDED.nxp.iterationPastId}::uuid where id = ${taskId}::uuid`,
    );
    expect(await iterationOf(taskId)).toBe(SEEDED.nxp.iterationCurrentId);

    // Even a NULL, which is the value a bare insert would leave behind.
    await db.execute(sql`update work.tasks set iteration_id = null where id = ${taskId}::uuid`);
    expect(await iterationOf(taskId)).toBe(SEEDED.nxp.iterationCurrentId);
  });
});

/**
 * An archived Team keeps its hours in Team Capacity, and the row says it is archived.
 *
 * The BA rule is explicit: "Archive Team không xóa lịch sử Work Item/Sprint đã liên kết" — archiving
 * a Team does not delete its linked Work Item/Sprint history (DB design §488). So the numbers stay.
 * What was missing is the label: `getCapacityRecords` inner-joins `teams` with no status predicate,
 * so a disbanded team appeared as an ordinary peer row, while the global Team picker
 * (`app-shell.tsx` filters `status === 'active'`) had already stopped offering it. A reader was
 * comparing a team that no longer exists to live ones with nothing on screen to say so.
 */
describe('archived teams in Team Capacity (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DrizzleDB;
  let reporting: ReportingService;
  const actor = adminActor();

  beforeAll(async () => {
    app = await bootRovaApp();
    db = app.get<DrizzleDB>(DRIZZLE);
    reporting = app.get(ReportingService);
  });

  afterAll(async () => {
    // Restored, because Team Alpha is the fixture every other file leans on.
    await db.execute(
      sql`update work.teams set status = 'active' where id = ${SEEDED.nxp.teamAlphaId}::uuid`,
    );
    await app?.close();
  });

  it('reports the hours and flags the row', async () => {
    const before = await reporting.getTeamCapacity(actor, {
      projectId: SEEDED.nxp.projectId,
      iterationId: SEEDED.nxp.iterationCurrentId,
    });
    const liveAlpha = before.teams.find((team) => team.id === SEEDED.nxp.teamAlphaId);
    expect(liveAlpha, 'Team Alpha must be in the seeded capacity report').toBeDefined();
    expect(liveAlpha!.archived).toBe(false);

    await db.execute(
      sql`update work.teams set status = 'archived' where id = ${SEEDED.nxp.teamAlphaId}::uuid`,
    );

    const after = await reporting.getTeamCapacity(actor, {
      projectId: SEEDED.nxp.projectId,
      iterationId: SEEDED.nxp.iterationCurrentId,
    });
    const archivedAlpha = after.teams.find((team) => team.id === SEEDED.nxp.teamAlphaId);

    // Still there, and the numbers are unchanged — this is the half that must NOT regress.
    expect(archivedAlpha, 'an archived team keeps its history').toBeDefined();
    expect(archivedAlpha!.totals).toEqual(liveAlpha!.totals);
    expect(after.totals).toEqual(before.totals);

    // And now it is labelled.
    expect(archivedAlpha!.archived).toBe(true);
  });
});
