/**
 * Team Status and the Phase 6 Team Capacity report must report the SAME hours — for work no Split
 * has moved.
 *
 * Both surfaces answer one question — "what is this team committed to in this iteration" — from the
 * same `work.tasks` rows, and the Team Capacity SRS says so twice: the scoped Task set comes from
 * "the Task's PARENT Story/Defect Project, Team and Iteration assignment", and Capacity "must use the
 * same source/table/API domain as `Track > Team Status`". They did not agree, in three independent
 * ways, each of which is exercised below against real rows.
 *
 * Latent rather than visible on the seeded fixture — every seeded task is uniformly team-tagged and no
 * parent is deleted — so the divergences are built here on purpose. That is the point: a test that
 * only reads the happy fixture is what let three of these ship.
 *
 * ⚠ AMENDED BY PHASE 7 SU-10, IN TWO WAYS. READ BOTH BEFORE TIGHTENING ANYTHING BACK.
 * ─────────────────────────────────────────────────────────────────────────────────
 * 1. **The two surfaces now DIVERGE, by design, on an Iteration a Split moved work out of.** SU-10
 *    (SRS §10.5, plan §8 Q1) makes Team Capacity report Actual hours ATTRIBUTED PER ITERATION: the
 *    source keeps the hours it had earned by the Split, the target counts only what was logged after
 *    it. Team Status has no such rule and is not asked to — it reads CURRENT assignment, so the moment
 *    a Task is re-parented forward its hours leave that screen entirely. The SRS sentence quoted above
 *    is about the SOURCE (same table, same scoped-task rule), and both surfaces still honour it; what
 *    SU-10 adds is a historical dimension that only the report has. {@link splitDivergence} pins the
 *    difference explicitly so it cannot regress into a silent one.
 * 2. **The hour comparisons run against an iteration THIS SPEC OWNS, not the seeded current one.**
 *    They were whole-iteration equalities over `SEEDED.nxp.iterationCurrentId`, so any other spec that
 *    split a story out of Sprint 26.1 changed the number under them — `split-story-flow.e2e.spec.ts`
 *    does exactly that, and the failure surfaced as "Capacity is 2.5h higher", which reads like a
 *    double-count in the attribution rather than like shared mutable fixture state. Owning the scope
 *    keeps every original claim and removes the dependency, which is the same treatment SU-01's gate
 *    record applied to the split preview specs for the same reason.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { DRIZZLE } from '@platform';
import type { DrizzleDB } from '@platform';
import { IterationsService } from '@modules/iterations';
import { WorkItemsService } from '@modules/work-items';
import { TeamStatusService } from '@modules/team-status';
import { ReportingService } from '@modules/reporting';

import { SEEDED, adminActor, bootRallyApp, uniqueKey } from './support/flow-harness';

describe('Team Status agrees with Team Capacity (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DrizzleDB;
  let items: WorkItemsService;
  let iterationsSvc: IterationsService;
  let teamStatus: TeamStatusService;
  let reporting: ReportingService;
  const actor = adminActor();
  /**
   * This spec's OWN iteration — see amendment 2 above. Created inside the seeded NXP project, so
   * `test/e2e-fixtures.ratchet.spec.ts` (81 `createProject` calls) does not move.
   *
   * Its window is unique in this project, which is load-bearing rather than cosmetic:
   * `timeboxGroupId` is derived from `(project, startDate, endDate)`, and Team Capacity FUSES a
   * timebox group while Team Status does not — so two iterations sharing a window would make the two
   * surfaces disagree for a reason that has nothing to do with what is under test.
   */
  let iterationId: string;
  const teamId = SEEDED.nxp.teamAlphaId;

  /** Sum of a scope's task hours as TEAM STATUS reports them. */
  async function teamStatusHours(scopeTeamId: string | null) {
    // Signature is (actor, projectId, teamId, iterationId) — team before iteration.
    const view = await teamStatus.getTeamStatus(
      actor,
      SEEDED.nxp.projectId,
      scopeTeamId,
      iterationId,
    );
    // The response's own totals row — the number the screen prints, not one this test re-derives.
    return {
      estimate: view.totals.estimateHours,
      todo: view.totals.todoHours,
      actual: view.totals.actualHours,
    };
  }

  /** The same scope as the TEAM CAPACITY report reports it. */
  async function capacityHours(scopeTeamId: string | undefined) {
    const report = await reporting.getTeamCapacity(actor, {
      projectId: SEEDED.nxp.projectId,
      iterationId,
      teamId: scopeTeamId,
    });
    return {
      estimate: report.totals.estimateHours,
      todo: report.totals.todoHours,
      actual: report.totals.actualHours,
    };
  }

  beforeAll(async () => {
    app = await bootRallyApp();
    db = app.get<DrizzleDB>(DRIZZLE);
    items = app.get(WorkItemsService);
    iterationsSvc = app.get(IterationsService);
    teamStatus = app.get(TeamStatusService);
    reporting = app.get(ReportingService);

    const iteration = await iterationsSvc.createIteration(
      actor,
      SEEDED.nxp.projectId,
      `Agreement sprint ${uniqueKey()}`,
      { state: 'committed', startDate: '2026-03-02', endDate: '2026-03-13' },
    );
    iterationId = iteration.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('counts a task whose team is INHERITED from its parent, not carried on the row', async () => {
    /**
     * The team half of the scope used to be a strict `tasks.team_id = ?`.
     *
     * A task's team only DEFAULTS to its parent's (SRS P1-04), so a Story that carries the team while
     * its task does not is an ordinary shape — and SQL equality never matches NULL. Team Status
     * dropped those tasks; Team Capacity kept them via the parent/iteration tiers. Same iteration,
     * same team, two different totals.
     */
    const story = await items.createWorkItem(
      actor,
      SEEDED.nxp.projectId,
      'story',
      `Inherited team ${uniqueKey()}`,
      { iterationId, teamId },
    );
    const task = await items.createTask(actor, story.id, `Inherited team task ${uniqueKey()}`, {
      estimateHours: '6',
      todoHours: '4',
      actualHours: '2',
    });
    // The shape the service cannot produce but a Story-first workflow arrives at: the parent owns the
    // team, the task does not.
    await db.execute(sql`update work.tasks set team_id = null where id = ${task.id}::uuid`);

    const status = await teamStatusHours(teamId);
    const capacity = await capacityHours(teamId);
    expect(status).toEqual(capacity);
    // And it is actually counted, rather than both being wrong in the same direction.
    expect(status.estimate).toBeGreaterThanOrEqual(6);
  });

  it('excludes tasks whose parent was soft-deleted, on BOTH surfaces', async () => {
    /**
     * A soft delete stamps `deleted_at` on the one row and never cascades to `work.tasks`. Team Status
     * LEFT-joined the parent, so those orphans still matched on `tasks.iteration_id` and were counted
     * with a blank Work Product column, while Iteration Status and the Phase 6 projection inner-join
     * and exclude them. Deleting a Story moved the two screens apart.
     */
    const story = await items.createWorkItem(
      actor,
      SEEDED.nxp.projectId,
      'story',
      `Orphan parent ${uniqueKey()}`,
      { iterationId, teamId },
    );
    await items.createTask(actor, story.id, `Orphan task ${uniqueKey()}`, {
      estimateHours: '11',
      todoHours: '11',
      actualHours: '0',
    });

    const before = await teamStatusHours(teamId);
    await items.deleteWorkItem(actor, story.id);
    const after = await teamStatusHours(teamId);

    // The 11 hours leave Team Status when their parent does.
    expect(after.estimate).toBe(before.estimate - 11);
    expect(after).toEqual(await capacityHours(teamId));
  });

  it('agrees under All Teams too', async () => {
    expect(await teamStatusHours(null)).toEqual(await capacityHours(undefined));
  });

  /**
   * The ONE place the two surfaces are SUPPOSED to disagree, asserted rather than left to be
   * rediscovered as a failure in an unrelated spec (Phase 7 SU-10, SRS §10.5, plan §8 Q1).
   *
   * A Split moves the Task forward, so Team Status — which reads CURRENT assignment — stops counting
   * it in this Iteration at all. Team Capacity keeps the hours the Iteration had already earned,
   * because they were spent here and no later event can move them. The gap is therefore exactly the
   * Task's Actual as at the Split, and asserting the DIFFERENCE rather than two absolute totals is
   * what keeps this true whatever else the iteration holds.
   *
   * Estimate and To Do are asserted to STILL agree, which is the other half of the rule: only the
   * Actual is historical. The Estimate and the To Do follow the Task (BR-27, satisfied by D3/D4), and
   * that is the same fact SU-08's e2e reads from the other side as the source burndown's remaining To
   * Do dropping to zero on the Split date.
   */
  it('DIVERGES on Actual once a Split has moved work out — by design (SU-10)', async () => {
    const target = await iterationsSvc.createIteration(
      actor,
      SEEDED.nxp.projectId,
      `Agreement target ${uniqueKey()}`,
      { state: 'committed', startDate: '2026-03-16', endDate: '2026-03-27' },
    );
    const story = await items.createWorkItem(
      actor,
      SEEDED.nxp.projectId,
      'story',
      `Split divergence ${uniqueKey()}`,
      { iterationId, teamId, storyPoints: '5' },
    );
    await items.createTask(actor, story.id, `Split divergence task ${uniqueKey()}`, {
      estimateHours: '8',
      todoHours: '8',
      actualHours: '3',
    });

    const before = { status: await teamStatusHours(teamId), capacity: await capacityHours(teamId) };
    // The premise: before the Split the two surfaces agree on this work, so the gap below is created
    // by the Split and by nothing else.
    expect(before.status).toEqual(before.capacity);

    await items.splitWorkItem(actor, story.id, {
      expectedSourceIterationId: iterationId,
      targetIterationId: target.id,
      unfinished: { title: '[Unfinished] agreement', planEstimate: 2 },
      continued: {
        title: '[Continued] agreement',
        planEstimate: 3,
        releaseId: null,
        scheduleState: 'in_progress',
      },
      // The Task is not named, so it stays on `[Continued]` and follows it into the target.
      unfinishedTaskIds: [],
      unfinishedDefectIds: [],
      unfinishedTestCaseIds: [],
    });

    const status = await teamStatusHours(teamId);
    const capacity = await capacityHours(teamId);

    // The Task left Team Status entirely — its Estimate, To Do and Actual all go with it.
    expect(status.estimate).toBe(before.status.estimate - 8);
    expect(status.actual).toBe(before.status.actual - 3);

    // Team Capacity lets the Estimate and the To Do go too…
    expect(capacity.estimate).toBe(status.estimate);
    expect(capacity.todo).toBe(status.todo);
    // …and KEEPS the three hours this Iteration earned. That is AC4, and it is the whole difference.
    expect(capacity.actual).toBe(status.actual + 3);
    expect(capacity.actual).toBe(before.capacity.actual);
  });

  it('does NOT overwrite To Do when only the Estimate is edited', async () => {
    /**
     * The Team Status edit path used to set `todoHours` to the new estimate whenever the caller had not
     * sent one. That defined the field before `WorkItemsService` saw it, bypassing the once-only gate
     * (`item.todoHours === null`) — so the copy happened on EVERY estimate edit, re-inflating a
     * completed task's auto-zeroed To Do and moving the Iteration Status total with it.
     *
     * Driven through `WorkItemsService` now, because Team Status no longer edits hours at all: the SRS
     * makes Estimate/ToDo/Actuals reads on that screen (§9.3 patches `title`/`state`; §11's editable
     * columns are Capacity, Task Name, Task State), and the Task Dashboard — Work Item Detail › Tasks
     * tab, FR-038 — is the surface that writes them, through this path. The RULE is unchanged and this
     * is where it lives, which is the whole reason removing the Team Status branch is safe.
     */
    const story = await items.createWorkItem(
      actor,
      SEEDED.nxp.projectId,
      'story',
      `Estimate edit ${uniqueKey()}`,
      { iterationId, teamId },
    );
    const task = await items.createTask(actor, story.id, `Estimate edit task ${uniqueKey()}`, {
      estimateHours: '5',
      todoHours: '2',
    });

    await items.updateWorkItem(actor, task.id, { estimateHours: '9' });

    const rows = await db.execute<{ estimate_hours: string; todo_hours: string }>(
      sql`select estimate_hours, todo_hours from work.tasks where id = ${task.id}::uuid`,
    );
    expect(Number(rows.rows[0].estimate_hours)).toBe(9);
    // Untouched — 2, not 9.
    expect(Number(rows.rows[0].todo_hours)).toBe(2);
  });

  it('still copies the FIRST estimate to To Do, once', async () => {
    // Removing the auto-sync must not remove the real rule: the first Estimate copies to To Do while
    // To Do is still null (RECONCILED_SOURCE_OF_TRUTH), and that rule lives in `WorkItemsService` —
    // the path the Task Dashboard writes through, and the one every hours edit now takes.
    const story = await items.createWorkItem(
      actor,
      SEEDED.nxp.projectId,
      'story',
      `First estimate ${uniqueKey()}`,
      { iterationId, teamId },
    );
    const task = await items.createTask(actor, story.id, `First estimate task ${uniqueKey()}`);
    await db.execute(
      sql`update work.tasks set estimate_hours = null, todo_hours = null where id = ${task.id}::uuid`,
    );

    await items.updateWorkItem(actor, task.id, { estimateHours: '7' });

    const rows = await db.execute<{ todo_hours: string }>(
      sql`select todo_hours from work.tasks where id = ${task.id}::uuid`,
    );
    expect(Number(rows.rows[0].todo_hours)).toBe(7);
  });
});
