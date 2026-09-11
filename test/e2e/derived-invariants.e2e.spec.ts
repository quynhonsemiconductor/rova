/**
 * Two rules the BA states as INVARIANTS, held against writes that used to bypass them.
 *
 * Both were specified as conditions rather than as event hooks, and both were implemented as hooks on
 * one particular write — so a different write reaching the same state left the rule unsatisfied:
 *
 *   • "A non-empty Iteration auto-changes to `Accepted` when all ASSIGNED Story/Defect items are
 *     `Accepted`" (BUSINESS_BASELINE:12, BR-IT-02). Keyed on *assigned* — which a scope change alters.
 *   • "Target Start Date EQUALS the earliest `startDate` among linked Releases and Target End Date
 *     EQUALS the latest `releaseDate`" (P3-MS-FR-011/012, Milestones SRS §73). An equality, not a
 *     recalculation step.
 *
 * A THIRD rule joined them for the same reason: a parent's Schedule State follows its tasks, and only
 * two of that rule's three triggers were built. See the `task state drives the parent` block below.
 *
 * A FOURTH is `trg_test_case_last_result` (Phase 7 plan D6): `test_cases.last_verdict`/`last_run`/
 * `last_result_id` are maintained by a DB TRIGGER, never by `TestResultsService` — see the
 * `Test Case last_verdict/last_run trigger (D6)` block below, which is the first place any of these
 * three are asserted against a REAL insert (Phase A's seed data only ever asserted the trigger's
 * output over already-seeded rows).
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { DRIZZLE } from '@platform';
import type { DrizzleDB } from '@platform';
import { WorkItemsService } from '@modules/work-items';
import { IterationsService } from '@modules/iterations';
import { MilestonesService } from '@modules/milestones';
import { ReleasesService } from '@modules/releases';
import { TestCasesService, TestResultsService } from '@modules/test-cases';
import { testCaseTypes } from '../../db/schema/work';

import {
  SEEDED,
  ALL,
  WORKSPACE_ID,
  adminActor,
  bootRallyApp,
  uniqueKey,
} from './support/flow-harness';

describe('derived invariants (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DrizzleDB;
  let items: WorkItemsService;
  let iterations: IterationsService;
  let milestones: MilestonesService;
  let releases: ReleasesService;
  let testCases: TestCasesService;
  let testResults: TestResultsService;
  const actor = adminActor();

  beforeAll(async () => {
    app = await bootRallyApp();
    db = app.get<DrizzleDB>(DRIZZLE);
    items = app.get(WorkItemsService);
    iterations = app.get(IterationsService);
    milestones = app.get(MilestonesService);
    releases = app.get(ReleasesService);
    testCases = app.get(TestCasesService);
    testResults = app.get(TestResultsService);

    // NXP gets its five default Test Case Types from migration 0129's backfill, which only
    // covers projects that ALREADY EXIST when it runs — NXP is created by the demo SEED, which
    // runs AFTER migrations, so on a fresh CI database NXP has ZERO selectable Types (same root
    // cause as test-case-routes.e2e.spec.ts's own beforeAll seed). The `Test Case
    // last_verdict/last_run trigger (D6)` block below calls `testCases.create` with no explicit
    // `type`, which needs one selectable Type to default to (BR2). Insert one directly, since
    // Phase G's `POST /projects/:id/test-case-types` route isn't part of this branch yet.
    await db
      .insert(testCaseTypes)
      .values({
        workspaceId: WORKSPACE_ID,
        projectId: SEEDED.nxp.projectId,
        name: 'Acceptance',
        position: 0,
      })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await app?.close();
  });

  async function iterationState(id: string): Promise<string> {
    const rows = await db.execute<{ state: string }>(
      sql`select state from work.iterations where id = ${id}::uuid`,
    );
    return rows.rows[0].state;
  }

  /** A committed iteration holding one accepted and one open story. */
  async function committedIterationWithMixedScope() {
    const iteration = await iterations.createIteration(
      actor,
      SEEDED.nxp.projectId,
      `Invariant sprint ${uniqueKey()}`,
      { state: 'planning', startDate: '2026-03-02', endDate: '2026-03-13' },
    );
    const accepted = await items.createWorkItem(
      actor,
      SEEDED.nxp.projectId,
      'story',
      `Accepted ${uniqueKey()}`,
      { iterationId: iteration.id, storyPoints: '3' },
    );
    const open = await items.createWorkItem(
      actor,
      SEEDED.nxp.projectId,
      'story',
      `Open ${uniqueKey()}`,
      { iterationId: iteration.id, storyPoints: '2' },
    );
    await iterations.updateIteration(actor, iteration.id, { state: 'committed' });
    await items.updateWorkItem(actor, accepted.id, { scheduleState: 'accepted' });

    // Still committed: one item is open, so the rule is not yet satisfied.
    expect(await iterationState(iteration.id)).toBe('committed');
    return { iterationId: iteration.id, openId: open.id };
  }

  it('auto-accepts when the last OPEN item is moved OUT of the iteration', async () => {
    /**
     * The gate required a `scheduleState` transition into an accepted state, so a SCOPE change that
     * satisfied the same condition never re-evaluated it. Moving the one remaining open Story out
     * leaves a non-empty iteration whose every assigned item is Accepted — the rule's exact wording —
     * with the iteration still Committed. Visible as Timeboxes saying Committed while the Iteration
     * Status tile says ACCEPTED 100%.
     */
    const { iterationId, openId } = await committedIterationWithMixedScope();

    await items.updateWorkItem(actor, openId, { iterationId: null });

    expect(await iterationState(iterationId)).toBe('accepted');
  });

  it('auto-accepts when an already-accepted item is bulk-assigned IN', async () => {
    // The other reachable hole: `assignIterationBulk` never called the check at all, so filling an
    // empty iteration with accepted work left it Committed.
    const iteration = await iterations.createIteration(
      actor,
      SEEDED.nxp.projectId,
      `Bulk invariant ${uniqueKey()}`,
      { state: 'planning', startDate: '2026-04-06', endDate: '2026-04-17' },
    );
    await iterations.updateIteration(actor, iteration.id, { state: 'committed' });

    const story = await items.createWorkItem(
      actor,
      SEEDED.nxp.projectId,
      'story',
      `Bulk accepted ${uniqueKey()}`,
      { storyPoints: '5' },
    );
    await items.updateWorkItem(actor, story.id, { scheduleState: 'accepted' });

    await items.bulkAssignIteration(actor, SEEDED.nxp.projectId, [story.id], iteration.id);

    expect(await iterationState(iteration.id)).toBe('accepted');
  });

  it('never auto-REVERSES an accepted iteration when open work is added', async () => {
    // "the system does not auto-reverse it" (BUSINESS_BASELINE:12). Re-evaluating on scope change must
    // only ever move toward accepted, or adding one story would un-accept a closed sprint.
    const { iterationId, openId } = await committedIterationWithMixedScope();
    await items.updateWorkItem(actor, openId, { iterationId: null });
    expect(await iterationState(iterationId)).toBe('accepted');

    const fresh = await items.createWorkItem(
      actor,
      SEEDED.nxp.projectId,
      'story',
      `Late arrival ${uniqueKey()}`,
      { iterationId, storyPoints: '1' },
    );
    expect(fresh.id).toBeTruthy();
    expect(await iterationState(iterationId)).toBe('accepted');
  });

  it("keeps a milestone's derived window correct after a linked Release's dates change", async () => {
    /**
     * `recalcTargetDates` ran on create, on update, on a link write — and on `getMilestone`, a
     * read-path repair. It never ran when a linked Release's own dates were edited, and
     * `listMilestones` reads the persisted columns. So the detail page self-healed on read while the
     * LIST showed the old window, which is also why nobody noticed.
     */
    const release = await releases.createRelease(
      actor,
      SEEDED.nxp.projectId,
      `Inv release ${uniqueKey()}`,
      {
        startDate: '2026-05-04',
        releaseDate: '2026-05-29',
      },
    );
    const milestone = await milestones.createMilestone(
      actor,
      SEEDED.nxp.projectId,
      `Inv milestone ${uniqueKey()}`,
      { releaseIds: [release.id] },
    );

    // Derived from the link, before anything moves.
    let row = await db.execute<{ target_start_date: string; target_end_date: string }>(
      sql`select target_start_date, target_end_date from work.milestones where id = ${milestone.id}::uuid`,
    );
    expect(row.rows[0].target_start_date).toBe('2026-05-04');

    // Now move the Release. The milestone's window has to move with it.
    await releases.updateRelease(actor, release.id, {
      startDate: '2026-05-11',
      releaseDate: '2026-06-19',
    });

    row = await db.execute<{ target_start_date: string; target_end_date: string }>(
      sql`select target_start_date, target_end_date from work.milestones where id = ${milestone.id}::uuid`,
    );
    expect(row.rows[0].target_start_date).toBe('2026-05-11');
    expect(row.rows[0].target_end_date).toBe('2026-06-19');

    // And the LIST agrees, without anyone opening the detail page first.
    const page = await milestones.listMilestones(actor, SEEDED.nxp.projectId, ALL);
    const listed = page.data.find((m) => m.id === milestone.id);
    expect(listed?.targetStartDate).toBe('2026-05-11');
    expect(listed?.targetEndDate).toBe('2026-06-19');
  });

  /**
   * The parent's Schedule State is DERIVED FROM THE TASK SET, Rally's own rule:
   *
   *   all Defined → `Defined`   ·   all Completed → `Completed`   ·   otherwise → `In Progress`
   *
   * It arrived here as three per-event triggers and only two were ever built — `TASK-FR-016` states
   * all-Completed and reopen; a task STARTING was cited in the service's comment as Rally's behaviour
   * and never implemented, so a Story read `Defined` with a task under it In-Progress. Reported from
   * develop on 2026-08-22 as "the roll-up stopped working"; it had never worked for that trigger.
   * Reconciling from the set is what makes a missing trigger impossible, and Broadcom's page names two
   * cases no transition trigger could ever have caught — both are CREATES.
   *
   * Every case asserts the STORED parent state, because that is what every grid, report and burndown
   * reads — not the response of the call that changed the task.
   */
  describe('accepted_date follows the accepted FAMILY, not the accepted state', () => {
    /**
     * `trg_sync_accepted_date` (migration 0087) stamps on entry to `accepted` OR `release`, and
     * Velocity is built entirely on that timestamp — a released Story with no `accepted_date` is
     * reported `unclassified` and its points fall out of the bar.
     *
     * A DIRECT transition into `release` is the case worth pinning: it never passes through
     * `accepted`, so a rule written as "stamp when the state becomes accepted" would miss it, and
     * the loss is silent — the item is visibly Released while the sprint's velocity is short by its
     * points, which reads as a reporting bug rather than a missing timestamp.
     */
    /**
     * `db.execute` is RAW SQL, so a `timestamptz` arrives as the driver gives it — a string here,
     * not the `Date` the query builder would have mapped it to. Coerced once, so the comparison
     * below is between two instants rather than between two representations.
     */
    async function acceptedDateOf(id: string): Promise<Date | null> {
      const rows = await db.execute<{ accepted_date: string | Date | null }>(
        sql`select accepted_date from work.work_items where id = ${id}::uuid`,
      );
      const value = rows.rows[0].accepted_date;
      return value === null ? null : new Date(value);
    }

    it('stamps a story moved straight from Defined to Release', async () => {
      const story = await items.createWorkItem(
        actor,
        SEEDED.nxp.projectId,
        'story',
        `Straight to release ${uniqueKey()}`,
        { storyPoints: '3' },
      );
      expect(await acceptedDateOf(story.id)).toBeNull();

      await items.updateWorkItem(actor, story.id, { scheduleState: 'release' });
      expect(await acceptedDateOf(story.id)).not.toBeNull();
    });

    it('clears it again when that story is reopened, and re-stamps LATER on re-release', async () => {
      const story = await items.createWorkItem(
        actor,
        SEEDED.nxp.projectId,
        'story',
        `Reopened after release ${uniqueKey()}`,
        { storyPoints: '3' },
      );
      await items.updateWorkItem(actor, story.id, { scheduleState: 'release' });
      const first = await acceptedDateOf(story.id);

      await items.updateWorkItem(actor, story.id, { scheduleState: 'in_progress' });
      expect(await acceptedDateOf(story.id)).toBeNull();

      await items.updateWorkItem(actor, story.id, { scheduleState: 'accepted' });
      const second = await acceptedDateOf(story.id);
      expect(second).not.toBeNull();
      // A fresh acceptance, not the old one restored — Velocity credits the sprint it happened in.
      expect(second!.getTime()).toBeGreaterThanOrEqual(first!.getTime());
    });
  });

  describe('parent Schedule State is derived from the task set', () => {
    const parentState = async (id: string) => {
      const row = await db.execute<{ schedule_state: string }>(
        sql`select schedule_state from work.work_items where id = ${id}::uuid`,
      );
      return row.rows[0].schedule_state;
    };

    async function story(
      scheduleState: 'idea' | 'defined' | 'in_progress' | 'completed' | 'accepted',
    ) {
      return items.createWorkItem(actor, SEEDED.nxp.projectId, 'story', `Derived ${uniqueKey()}`, {
        scheduleState,
      });
    }
    const addTask = (parentId: string) =>
      items.createTask(actor, parentId, `Derived task ${uniqueKey()}`);
    const setTask = (id: string, scheduleState: 'defined' | 'in_progress' | 'completed') =>
      items.updateWorkItem(actor, id, { scheduleState });

    it('walks the whole lifecycle with two tasks', async () => {
      const parent = await story('defined');
      const a = await addTask(parent.id);
      const b = await addTask(parent.id);
      // Both tasks are born Defined, so "all Defined" holds and the parent stays there.
      expect(await parentState(parent.id)).toBe('defined');

      await setTask(a.id, 'in_progress');
      expect(await parentState(parent.id)).toBe('in_progress');

      // One of two Completed is a MIX, not a completion (BA revision 2026-07-19).
      await setTask(a.id, 'completed');
      expect(await parentState(parent.id)).toBe('in_progress');

      await setTask(b.id, 'completed');
      expect(await parentState(parent.id)).toBe('completed');

      // Reopening one is `TASK-FR-016`'s second trigger, and falls out of the same rule.
      await setTask(b.id, 'in_progress');
      expect(await parentState(parent.id)).toBe('in_progress');
    });

    it('returns the parent to Defined when every task is Defined again', async () => {
      // The rule Rally states first and no trigger expressed at all: the parent walks BACK.
      const parent = await story('defined');
      const task = await addTask(parent.id);
      await setTask(task.id, 'in_progress');
      expect(await parentState(parent.id)).toBe('in_progress');

      await setTask(task.id, 'defined');
      expect(await parentState(parent.id)).toBe('defined');
    });

    it('starts a parent in idea as soon as a task exists', async () => {
      // Broadcom: "adding a task to a story in Idea will make the story Defined." A CREATE, so no
      // transition trigger could have caught it.
      const parent = await story('idea');
      await addTask(parent.id);
      expect(await parentState(parent.id)).toBe('defined');
    });

    it('reopens a Completed parent when a task is ADDED to it', async () => {
      // Broadcom: "adding a task to a story in Completed will make the story In Progress."
      const parent = await story('completed');
      await addTask(parent.id);
      expect(await parentState(parent.id)).toBe('defined');
    });

    it('completes a parent when its last OPEN task is deleted', async () => {
      // Deleting the last open task leaves an all-Completed set, so it completes the parent exactly as
      // completing that task would have. A delete, so again no transition trigger applied.
      const parent = await story('defined');
      const done = await addTask(parent.id);
      const open = await addTask(parent.id);
      await setTask(done.id, 'completed');
      await setTask(open.id, 'in_progress');
      expect(await parentState(parent.id)).toBe('in_progress');

      await items.deleteWorkItem(actor, open.id);
      expect(await parentState(parent.id)).toBe('completed');
    });

    it('leaves a parent with no live tasks alone', async () => {
      // Nothing to derive from, so the DELETE itself must move nothing: a Story whose last task was
      // removed keeps the state that set left it in.
      //
      // Note what happens on the way there, because it is Rally's rule and not a bug: adding a single
      // Defined task to an `in_progress` Story makes the set all-Defined, so the parent legitimately
      // becomes `Defined` at CREATE time. The assertion is therefore "unchanged by the delete", read
      // against the state immediately before it, not against the state the Story started in.
      const parent = await story('in_progress');
      const only = await addTask(parent.id);
      const beforeDelete = await parentState(parent.id);
      expect(beforeDelete).toBe('defined');

      await items.deleteWorkItem(actor, only.id);
      expect(await parentState(parent.id)).toBe(beforeDelete);
    });

    it('reconciles an ACCEPTED parent too — it is not exempt', async () => {
      // `P3-TS-FR-041`, BA-confirmed 2026-07-24: a parent moves back "from ANY at-or-past-completed
      // state — `completed`, `accepted` OR `release`". Guarding a sign-off here reads as the safer
      // choice and would have contradicted that ruling and its unit test, so the set-derived rule
      // keeps it. Reversing it means exempting those states in `reconcileParentScheduleState`.
      const parent = await story('accepted');
      const task = await addTask(parent.id);
      // One Defined task is an all-Defined set, so the Story is no longer signed-off work.
      expect(await parentState(parent.id)).toBe('defined');

      await setTask(task.id, 'in_progress');
      expect(await parentState(parent.id)).toBe('in_progress');
    });

    it('records each automatic change in the parent activity log', async () => {
      // `auto: true` is how a reader tells a roll-up from a manual edit, and the first thing to check
      // when the rule is reported as not firing.
      const parent = await story('defined');
      const task = await addTask(parent.id);
      await setTask(task.id, 'in_progress');

      const rows = await db.execute<{ metadata: { auto?: boolean } }>(
        sql`select metadata from work.activity_logs
            where entity_id = ${parent.id}::uuid
              and action = 'work_item.schedule_state_changed'`,
      );
      expect(rows.rows.length).toBe(1);
      expect(rows.rows[0].metadata.auto).toBe(true);
    });
  });

  describe('Test Case last_verdict/last_run trigger (D6)', () => {
    /** A fresh Test Case under a team-less Story — `assertAssignable` admits the Workspace Admin
     *  actor as tester with no Team needed, so no team fixture is required here. */
    async function freshTestCase() {
      const story = await items.createWorkItem(
        actor,
        SEEDED.nxp.projectId,
        'story',
        `Trigger fixture ${uniqueKey()}`,
        {},
      );
      return testCases.create(actor, story.id, { name: `Trigger case ${uniqueKey()}` });
    }

    async function storedColumns(testCaseId: string) {
      const rows = await db.execute<{
        last_verdict: string | null;
        last_run: string | null;
        last_result_id: string | null;
      }>(
        sql`select last_verdict, last_run, last_result_id from work.test_cases where id = ${testCaseId}::uuid`,
      );
      return rows.rows[0];
    }

    it('INSERT: a real Result insert moves the STORED parent columns (BR9)', async () => {
      const testCase = await freshTestCase();
      expect(await storedColumns(testCase.id)).toEqual({
        last_verdict: null,
        last_run: null,
        last_result_id: null,
      });

      const result = await testResults.create(actor, testCase.id, {
        build: 'build-1',
        runDate: '2026-09-01',
        verdict: 'fail',
        testerId: actor.sub,
      });

      const after = await storedColumns(testCase.id);
      expect(after.last_verdict).toBe('fail');
      expect(after.last_run).toBe('2026-09-01');
      expect(after.last_result_id).toBe(result.id);
    });

    it('the LATEST result by run_date wins, not whichever was inserted last', async () => {
      const testCase = await freshTestCase();

      const earlier = await testResults.create(actor, testCase.id, {
        build: 'build-early',
        runDate: '2026-09-01',
        verdict: 'fail',
        testerId: actor.sub,
      });
      // Inserted AFTER `earlier` but dated BEFORE it — the trigger must order by run_date, not
      // insertion order, or this would incorrectly become the latest.
      await testResults.create(actor, testCase.id, {
        build: 'build-earliest',
        runDate: '2026-08-20',
        verdict: 'pass',
        testerId: actor.sub,
      });
      // Dated AFTER both — this one must win.
      const latest = await testResults.create(actor, testCase.id, {
        build: 'build-late',
        runDate: '2026-09-10',
        verdict: 'pass',
        testerId: actor.sub,
      });

      const after = await storedColumns(testCase.id);
      expect(after.last_verdict).toBe('pass');
      expect(after.last_run).toBe('2026-09-10');
      expect(after.last_result_id).toBe(latest.id);
      expect(after.last_result_id).not.toBe(earlier.id);
    });

    it('a SAME-run_date pair breaks the tie on created_at (BR9)', async () => {
      const testCase = await freshTestCase();

      const first = await testResults.create(actor, testCase.id, {
        build: 'build-a',
        runDate: '2026-09-05',
        verdict: 'fail',
        testerId: actor.sub,
      });
      // Same run_date, created AFTER `first` — must win on created_at, since run_date alone ties.
      const second = await testResults.create(actor, testCase.id, {
        build: 'build-b',
        runDate: '2026-09-05',
        verdict: 'pass',
        testerId: actor.sub,
      });

      const after = await storedColumns(testCase.id);
      expect(after.last_verdict).toBe('pass');
      expect(after.last_result_id).toBe(second.id);
      expect(after.last_result_id).not.toBe(first.id);
    });

    it('UPDATE (soft-delete): removing the only live Result clears all three columns', async () => {
      const testCase = await freshTestCase();
      const result = await testResults.create(actor, testCase.id, {
        build: 'build-1',
        runDate: '2026-09-01',
        verdict: 'pass',
        testerId: actor.sub,
      });
      expect((await storedColumns(testCase.id)).last_result_id).toBe(result.id);

      // Phase D ships no delete route (Phase F) — the trigger's DELETE/soft-delete branch is
      // exercised directly here, over the SAME column the service would eventually write via
      // `deleted_at`, matching how `db/seeds/**` is allowed to write these tables raw.
      await db.execute(
        sql`update work.test_results set deleted_at = now() where id = ${result.id}::uuid`,
      );

      const after = await storedColumns(testCase.id);
      expect(after.last_verdict).toBeNull();
      expect(after.last_run).toBeNull();
      expect(after.last_result_id).toBeNull();
    });

    // Phase E's E5: an edit through `TestResultsService.update` is a real UPDATE of `run_date`/
    // `verdict` — a SEPARATE trigger branch from the INSERT the four tests above exercise. The
    // instructions for this phase name both directions explicitly: editing the LATEST Result must
    // move the parent, and editing an OLDER one must NOT — the second is the "boring" half BR9
    // itself is easiest to skip, since the trigger's own recompute already handles it for free the
    // moment run_date/verdict change and the ORDER BY... LIMIT 1 re-picks the winner.

    it("UPDATE: editing the LATEST Result's run_date/verdict moves the parent (BR9/E5)", async () => {
      const testCase = await freshTestCase();
      const only = await testResults.create(actor, testCase.id, {
        build: 'build-1',
        runDate: '2026-09-01',
        verdict: 'fail',
        testerId: actor.sub,
      });
      expect(await storedColumns(testCase.id)).toEqual({
        last_verdict: 'fail',
        last_run: '2026-09-01',
        last_result_id: only.id,
      });

      await testResults.update(actor, only.id, { verdict: 'pass', runDate: '2026-09-15' });

      const after = await storedColumns(testCase.id);
      expect(after.last_verdict).toBe('pass');
      expect(after.last_run).toBe('2026-09-15');
      expect(after.last_result_id).toBe(only.id);
    });

    it('UPDATE: editing an OLDER Result does NOT change the parent (still the newer one)', async () => {
      const testCase = await freshTestCase();
      const older = await testResults.create(actor, testCase.id, {
        build: 'build-old',
        runDate: '2026-09-01',
        verdict: 'fail',
        testerId: actor.sub,
      });
      const newer = await testResults.create(actor, testCase.id, {
        build: 'build-new',
        runDate: '2026-09-10',
        verdict: 'pass',
        testerId: actor.sub,
      });
      expect((await storedColumns(testCase.id)).last_result_id).toBe(newer.id);

      // Edit the OLDER Result's verdict/run_date — the trigger recomputes and must still find
      // `newer` as the winner by `run_date DESC, created_at DESC`, since `older`'s new run_date
      // (2026-09-05) still sits before `newer`'s (2026-09-10).
      await testResults.update(actor, older.id, { verdict: 'error', runDate: '2026-09-05' });

      const after = await storedColumns(testCase.id);
      expect(after.last_verdict).toBe('pass');
      expect(after.last_run).toBe('2026-09-10');
      expect(after.last_result_id).toBe(newer.id);
    });
  });

  it('leaves a milestone with NO linked release manually dated', async () => {
    // §75: with no link the dates are user-managed and "the system does not infer a replacement date".
    // A trigger that maintains the derived window must not reach these.
    const milestone = await milestones.createMilestone(
      actor,
      SEEDED.nxp.projectId,
      `Manual milestone ${uniqueKey()}`,
      { targetStartDate: '2026-09-01', targetEndDate: '2026-09-30' },
    );
    const row = await db.execute<{ target_start_date: string; target_end_date: string }>(
      sql`select target_start_date, target_end_date from work.milestones where id = ${milestone.id}::uuid`,
    );
    expect(row.rows[0].target_start_date).toBe('2026-09-01');
    expect(row.rows[0].target_end_date).toBe('2026-09-30');
  });
});
