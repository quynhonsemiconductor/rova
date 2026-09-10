/**
 * PAY — the SECOND seeded project: one row of every entity type.
 *
 * Why it exists: a great many rules are only expressible with two projects — isolation, permission
 * scoping, "that release belongs to another project", the cutline over a foreign Feature, All Teams
 * fusion across projects. Every BE e2e file that needed one built its own, which is most of the 84
 * `createProject` calls a full run used to make and never clean up. A fixture that already exists
 * cannot leak, and a dev database that does not grow cannot push `portfolio_items.rank` into its
 * `varchar(255)` ceiling — which is exactly what stopped the suite twice.
 *
 * Deliberately ONE of each rather than a second deep fixture: NXP carries the volume (several
 * iterations, two releases, an Epic with seven Features, two capacity plans, frozen report history).
 * PAY carries the SHAPE. A test that needs depth uses NXP; a test that needs "somewhere else" uses
 * PAY, and neither has to build anything.
 *
 * Idempotent throughout (`onConflictDoNothing` on fixed UUIDs), like every other seed here, so
 * `pnpm db:seed:test` can run against a dirty database.
 */
import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import * as schema from '../schema';
import {
  capacityPlanAllocations,
  capacityPlanTeams,
  capacityPlans,
  comments,
  iterationDailySnapshots,
  iterations,
  labels,
  memberCapacity,
  milestoneProjects,
  milestoneReleases,
  milestoneTeams,
  milestones,
  portfolioItems,
  projectTeams,
  releaseDailySnapshots,
  releaseTeamTargets,
  releases,
  tasks,
  teamMembers,
  teams,
  testCases,
  testResults,
  timeLogs,
  workItemLabels,
  workItemWatchers,
  workItems,
} from '../schema/work';
import {
  ADMIN_USER_ID,
  DEVELOPER_ID,
  PAY_CAPACITY_PLAN_ID,
  PAY_DEFECT_ID,
  PAY_EPIC_ID,
  PAY_FEATURE_ID,
  PAY_ITER_ID,
  PAY_MILESTONE_ID,
  PAY_PROJECT_ID,
  PAY_RELEASE_ID,
  PAY_STORY_ID,
  PAY_TASK_ID,
  PAY_TEST_CASE_ID,
  PAY_TEST_RESULT_ID,
  TEAM_GAMMA_ID,
  WORKSPACE_ID,
} from './constants';

type Db = NodePgDatabase<typeof schema>;

/** Deterministic LexoRank-ish keys, so a re-seed cannot reorder the grid. */
const RANK = { epic: 'hzzzzz:', feature: 'i00000:', story: 'i00001:', defect: 'i00002:' };

export async function seedSecondProject(db: Db): Promise<void> {
  // The project row, its counters, members and workflow statuses are created by `seedProject()`
  // from `SEED_PROJECTS` — PAY is listed there, so this module only adds the delivery data.
  const statusRows = await db
    .select({ id: schema.workflowStatuses.id, category: schema.workflowStatuses.category })
    .from(schema.workflowStatuses)
    .where(eq(schema.workflowStatuses.projectId, PAY_PROJECT_ID));
  const todo = statusRows.find((s) => s.category === 'to_do')?.id;
  const inProgress = statusRows.find((s) => s.category === 'in_progress')?.id;
  const done = statusRows.find((s) => s.category === 'done')?.id;
  // Without statuses there is nothing to attach a work item to; `seedProject` runs first, so this
  // only trips if that order changes.
  if (!todo || !inProgress || !done) return;

  // ── Team Gamma, linked to the project ─────────────────────────────────────
  await db
    .insert(teams)
    .values({
      id: TEAM_GAMMA_ID,
      workspaceId: WORKSPACE_ID,
      name: 'Team Gamma',
      key: 'GAMMA',
      description: 'The second project’s delivery team.',
      status: 'active',
    })
    .onConflictDoNothing();

  await db
    .insert(teamMembers)
    .values({
      id: uuidv7(),
      workspaceId: WORKSPACE_ID,
      teamId: TEAM_GAMMA_ID,
      userId: DEVELOPER_ID,
      status: 'active',
    })
    .onConflictDoNothing();

  // A team is only assignable inside a project it is LINKED to (`PROJECT_TEAM_LINK_NOT_FOUND`),
  // and `assertTeamInProject` now requires the link to be ACTIVE.
  await db
    .insert(projectTeams)
    .values({
      id: uuidv7(),
      workspaceId: WORKSPACE_ID,
      projectId: PAY_PROJECT_ID,
      teamId: TEAM_GAMMA_ID,
      status: 'active',
    })
    .onConflictDoNothing();

  // ── Release + iteration + milestone ───────────────────────────────────────
  await db
    .insert(releases)
    .values({
      id: PAY_RELEASE_ID,
      workspaceId: WORKSPACE_ID,
      projectId: PAY_PROJECT_ID,
      releaseKey: 'RE-1',
      name: 'v1.0 — Wallet',
      description: 'First payments release.',
      status: 'planning',
      startDate: '2026-08-01',
      releaseDate: '2026-08-31',
    })
    .onConflictDoNothing();

  await db
    .insert(iterations)
    .values({
      id: PAY_ITER_ID,
      workspaceId: WORKSPACE_ID,
      projectId: PAY_PROJECT_ID,
      // Team-scoped on purpose: NXP's shared sprint covers the team-LESS case, so between them the
      // two projects carry both shapes the reports have to handle.
      teamId: TEAM_GAMMA_ID,
      iterationKey: 'IT-1',
      name: 'Wallet Sprint 1',
      goal: 'Ship the wallet top-up flow.',
      state: 'committed',
      plannedVelocity: 13,
      startDate: '2026-08-03',
      endDate: '2026-08-14',
    })
    .onConflictDoNothing();

  await db
    .insert(milestones)
    .values({
      id: PAY_MILESTONE_ID,
      workspaceId: WORKSPACE_ID,
      projectId: PAY_PROJECT_ID,
      milestoneKey: 'MS-1',
      name: 'Wallet GA',
      description: 'Wallet generally available.',
      status: 'planned',
      ownerId: ADMIN_USER_ID,
      // Equal to the linked release's own window, which is the invariant the milestone read model
      // derives (MIN start / MAX end over linked releases — one release, so both equal its dates).
      targetStartDate: '2026-08-01',
      targetEndDate: '2026-08-31',
    })
    .onConflictDoNothing();

  // The three link tables, so the milestone's own tabs have rows to render.
  await db
    .insert(milestoneProjects)
    .values({ milestoneId: PAY_MILESTONE_ID, projectId: PAY_PROJECT_ID })
    .onConflictDoNothing();
  await db
    .insert(milestoneReleases)
    .values({ milestoneId: PAY_MILESTONE_ID, releaseId: PAY_RELEASE_ID })
    .onConflictDoNothing();
  await db
    .insert(milestoneTeams)
    .values({ milestoneId: PAY_MILESTONE_ID, teamId: TEAM_GAMMA_ID })
    .onConflictDoNothing();

  // ── Portfolio: an Epic with one Feature ───────────────────────────────────
  const payPortfolio: (typeof portfolioItems.$inferInsert)[] = [
    {
      id: PAY_EPIC_ID,
      workspaceId: WORKSPACE_ID,
      projectId: PAY_PROJECT_ID,
      // Keys are unique per WORKSPACE (`uq_portfolio_item_key`), not per project, so PAY continues
      // NXP's sequence rather than restarting it. Reusing `EP-1` made the whole insert vanish
      // silently under `onConflictDoNothing`, which is how this was found.
      itemKey: 'EP-2',
      type: 'epic',
      name: 'Wallet platform',
      description: 'Everything wallet.',
      state: 'developing',
      preliminaryEstimate: 'l',
      ownerId: ADMIN_USER_ID,
      rank: RANK.epic,
    },
    {
      id: PAY_FEATURE_ID,
      workspaceId: WORKSPACE_ID,
      projectId: PAY_PROJECT_ID,
      itemKey: 'FE-8',
      type: 'feature',
      name: 'Wallet top-up',
      description: 'Top up a wallet from a card.',
      state: 'developing',
      preliminaryEstimate: 'm',
      // A Feature carries the team and release an Epic cannot (`ck_portfolio_epic_shape`).
      parentId: PAY_EPIC_ID,
      teamId: TEAM_GAMMA_ID,
      releaseId: PAY_RELEASE_ID,
      ownerId: ADMIN_USER_ID,
      refinedEstimate: '8',
      rank: RANK.feature,
    },
  ];
  await db.insert(portfolioItems).values(payPortfolio).onConflictDoNothing();

  // ── Story + Defect + Task, fully referenced ───────────────────────────────
  const payWorkItems: (typeof workItems.$inferInsert)[] = [
    {
      id: PAY_STORY_ID,
      workspaceId: WORKSPACE_ID,
      projectId: PAY_PROJECT_ID,
      teamId: TEAM_GAMMA_ID,
      iterationId: PAY_ITER_ID,
      releaseId: PAY_RELEASE_ID,
      featureId: PAY_FEATURE_ID,
      itemKey: 'US-2',
      type: 'story',
      title: 'Top up with a saved card',
      description: 'As a user I can top up my wallet from a saved card.',
      statusId: inProgress,
      scheduleState: 'in_progress',
      flowState: 'in_progress',
      priority: 'high',
      storyPoints: '5',
      assigneeId: DEVELOPER_ID,
      reporterId: ADMIN_USER_ID,
      createdBy: ADMIN_USER_ID,
      rank: RANK.story,
    },
    {
      id: PAY_DEFECT_ID,
      workspaceId: WORKSPACE_ID,
      projectId: PAY_PROJECT_ID,
      teamId: TEAM_GAMMA_ID,
      iterationId: PAY_ITER_ID,
      releaseId: PAY_RELEASE_ID,
      featureId: PAY_FEATURE_ID,
      itemKey: 'DE-2',
      type: 'defect',
      title: 'Top-up fails on an expired card',
      description: 'No error surfaces; the spinner runs forever.',
      statusId: todo,
      scheduleState: 'defined',
      flowState: 'defined',
      priority: 'urgent',
      storyPoints: '3',
      assigneeId: DEVELOPER_ID,
      reporterId: ADMIN_USER_ID,
      createdBy: ADMIN_USER_ID,
      // `foundInRelease` is a defect-only reference and belongs to the same project.
      foundInReleaseId: PAY_RELEASE_ID,
      rank: RANK.defect,
    },
  ];
  await db.insert(workItems).values(payWorkItems).onConflictDoNothing();

  // A task inherits team + iteration from its parent, which is the rule the service enforces.
  await db
    .insert(tasks)
    .values({
      id: PAY_TASK_ID,
      workspaceId: WORKSPACE_ID,
      projectId: PAY_PROJECT_ID,
      parentId: PAY_STORY_ID,
      teamId: TEAM_GAMMA_ID,
      iterationId: PAY_ITER_ID,
      // `itemKey` and a `state`, not `taskKey`/`statusId`: a task carries its own key sequence and
      // its own lifecycle enum rather than a project workflow status.
      itemKey: 'TA-3',
      title: 'Card tokenisation call',
      state: 'in_progress' as const,
      estimateHours: '8',
      todoHours: '5',
      actualHours: '3',
      assigneeId: DEVELOPER_ID,
      createdBy: ADMIN_USER_ID,
    })
    .onConflictDoNothing();

  // ── Capacity: a DRAFT plan with a team and one allocation ─────────────────
  // NXP holds the published plan, so between them both statuses are seeded — a published fixture is
  // read-only, and a draft is the only one a test can mutate without unpublishing first.
  await db
    .insert(capacityPlans)
    .values({
      id: PAY_CAPACITY_PLAN_ID,
      workspaceId: WORKSPACE_ID,
      projectId: PAY_PROJECT_ID,
      releaseId: PAY_RELEASE_ID,
      planKey: 'CP-1',
      name: 'Wallet capacity',
      unit: 'points',
      plannedStartDate: '2026-08-01',
      plannedEndDate: '2026-08-31',
    })
    .onConflictDoNothing();

  await db
    .insert(capacityPlanTeams)
    .values({ planId: PAY_CAPACITY_PLAN_ID, teamId: TEAM_GAMMA_ID, capacity: '13' })
    .onConflictDoNothing();

  await db
    .insert(capacityPlanAllocations)
    .values({
      planId: PAY_CAPACITY_PLAN_ID,
      portfolioItemId: PAY_FEATURE_ID,
      teamId: TEAM_GAMMA_ID,
      value: '8',
      source: 'manual' as const,
      isPrimary: true,
    })
    .onConflictDoNothing();

  await db
    .insert(memberCapacity)
    .values({
      id: uuidv7(),
      workspaceId: WORKSPACE_ID,
      projectId: PAY_PROJECT_ID,
      teamId: TEAM_GAMMA_ID,
      iterationId: PAY_ITER_ID,
      userId: DEVELOPER_ID,
      capacityHours: '32',
    })
    .onConflictDoNothing();

  // ── Frozen report history: three days, one of them a GAP ──────────────────
  // Same rule as NXP's: the cron only ever writes TODAY, so a past window can only have history if
  // a seed writes it, and a deliberate gap is what proves the report renders gaps as gaps.
  const burndown = [
    { date: '2026-08-03', todo: '13', accepted: '0' },
    { date: '2026-08-04', todo: '9', accepted: '0' },
    // 2026-08-05 missing on purpose.
    { date: '2026-08-06', todo: '5', accepted: '5' },
  ];
  await db
    .insert(iterationDailySnapshots)
    .values(
      burndown.flatMap((row) =>
        [null, TEAM_GAMMA_ID].map((teamId) => ({
          id: uuidv7(),
          workspaceId: WORKSPACE_ID,
          iterationId: PAY_ITER_ID,
          teamId,
          snapshotDate: row.date,
          remainingTodo: row.todo,
          acceptedPoints: row.accepted,
          capturedAt: new Date(`${row.date}T17:00:00Z`),
          finalized: true,
        })),
      ),
    )
    .onConflictDoNothing();

  // One row per scope, as the burndown above: All Teams (measured) and Gamma's own, whose numbers
  // coincide because every PAY item is Gamma's. Without the Gamma row a team-scoped burnup had an
  // Ideal target and no series to draw beneath it.
  await db
    .insert(releaseDailySnapshots)
    .values(
      [null, TEAM_GAMMA_ID].map((teamId) => ({
        id: uuidv7(),
        workspaceId: WORKSPACE_ID,
        releaseId: PAY_RELEASE_ID,
        teamId,
        snapshotDate: '2026-08-06',
        acceptedPoints: '5',
        acceptedCount: 1,
        plannedPoints: '8',
        plannedCount: 2,
        preliminaryPoints: '13',
        preliminaryCount: 2,
        capturedAt: new Date('2026-08-06T17:00:00Z'),
        finalized: true,
      })),
    )
    .onConflictDoNothing();

  // The Ideal target the burnup climbs to, in `release_team_targets` — captured once per scope, as the
  // job would. One row per scope the snapshots carry: the `team_id IS NULL` row is the MEASURED All
  // Teams target and is never summed. Every PAY item is Gamma's, so both read 8 points / 2 items.
  await db
    .insert(releaseTeamTargets)
    .values(
      [null, TEAM_GAMMA_ID].map((teamId) => ({
        id: uuidv7(),
        workspaceId: WORKSPACE_ID,
        releaseId: PAY_RELEASE_ID,
        teamId,
        idealTargetPoints: '8',
        idealTargetCount: 2,
        capturedAt: new Date('2026-08-06T17:00:00Z'),
      })),
    )
    .onConflictDoNothing();

  /**
   * Advance the workspace key counters past what PAY just took.
   *
   * `story`/`defect`/`task` keys are minted from this table, so a seeded `US-2` that the counter
   * does not know about would be handed out again on the next create and collide on
   * `uq_work_item_key`. `GREATEST` keeps it monotonic, matching how the NXP seed does it.
   */
  for (const [itemType, taken] of [
    ['story', 2],
    ['defect', 2],
    ['task', 3],
  ] as const) {
    await db
      .update(schema.workspaceItemCounters)
      .set({
        lastItemNumber: sql`GREATEST(${schema.workspaceItemCounters.lastItemNumber}, ${taken})`,
      })
      .where(
        and(
          eq(schema.workspaceItemCounters.workspaceId, WORKSPACE_ID),
          eq(schema.workspaceItemCounters.itemType, itemType),
        ),
      );
  }

  // ── Test Case + Result: ONE of each (mirrors every other PAY entity type) ─
  await db
    .insert(testCases)
    .values({
      id: PAY_TEST_CASE_ID,
      workspaceId: WORKSPACE_ID,
      projectId: PAY_PROJECT_ID,
      teamId: TEAM_GAMMA_ID,
      workItemId: PAY_STORY_ID,
      testCaseKey: 'TC-3',
      name: 'Top-up succeeds with a saved card',
      objective: 'Verify a saved card can top up the wallet end to end.',
      type: 'Functional',
      method: 'manual',
      priority: 'high',
      ownerId: ADMIN_USER_ID,
      assigneeId: DEVELOPER_ID,
      rank: 'a0003',
      createdBy: ADMIN_USER_ID,
    })
    .onConflictDoNothing();

  await db
    .insert(testResults)
    .values({
      id: PAY_TEST_RESULT_ID,
      workspaceId: WORKSPACE_ID,
      projectId: PAY_PROJECT_ID,
      testCaseId: PAY_TEST_CASE_ID,
      workItemId: PAY_STORY_ID,
      testResultKey: 'TR-3',
      build: '2026.08.04-rc1',
      runDate: '2026-08-04',
      verdict: 'pass',
      durationMinutes: 5,
      testerId: DEVELOPER_ID,
      createdBy: DEVELOPER_ID,
    })
    .onConflictDoNothing();

  // ── Collaboration: label, comment, time log, watcher ──────────────────────
  const labelId = '00000000-0000-7000-8000-0000000000f0';
  await db
    .insert(labels)
    .values({
      id: labelId,
      workspaceId: WORKSPACE_ID,
      projectId: PAY_PROJECT_ID,
      name: 'payments',
      color: '#0B7285',
    })
    .onConflictDoNothing();
  await db
    .insert(workItemLabels)
    .values({ workItemId: PAY_STORY_ID, labelId })
    .onConflictDoNothing();

  await db
    .insert(comments)
    .values({
      id: uuidv7(),
      workspaceId: WORKSPACE_ID,
      entityType: 'work_item',
      entityId: PAY_STORY_ID,
      authorId: ADMIN_USER_ID,
      body: '<p>Tokenisation vendor confirmed for the top-up path.</p>',
    })
    .onConflictDoNothing();

  await db
    .insert(timeLogs)
    .values({
      id: uuidv7(),
      workspaceId: WORKSPACE_ID,
      workItemId: PAY_STORY_ID,
      userId: DEVELOPER_ID,
      loggedDate: '2026-08-04',
      hours: '3',
      description: 'Card tokenisation spike',
    })
    .onConflictDoNothing();

  await db
    .insert(workItemWatchers)
    .values({ workItemId: PAY_STORY_ID, userId: ADMIN_USER_ID, workspaceId: WORKSPACE_ID })
    .onConflictDoNothing();
}
