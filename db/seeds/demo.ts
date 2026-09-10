// Load .env for local dev; in CI the env vars are injected directly.
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env file — CI mode */
}

/**
 * Demo/fixture tier — ONE sample project (NXP) with a full end-to-end flow, for
 * E2E + staging + opt-in dev fixtures (`pnpm db:seed:test`): 3 users + Team
 * (with members) → Story + Defect (team-linked) → 3 Tasks under the Story
 * (team/iteration inherited) → Iteration (contains the Story + Defect) →
 * Release + Milestone (linked to each other and to the Story). See seedFlow()
 * for the full relation graph. Every FK resolves to a real, matching row.
 *
 * These are FIXTURES only — never real production. `seed()` first runs the two
 * prod-safe tiers (seedTenantBootstrapInto + seedSystemRolesInto) so role
 * assignments resolve, then layers the demo data on top. Each helper also
 * creates/updates the reference + related rows its fixtures depend on
 * (counters, workflow statuses, project members, project-team links).
 *
 * Entrypoint  : db/seeds/seed.ts (barrel) — pnpm db:seed
 * Called by   : db/migrate.ts when SEED_ON_DEPLOY=true (develop env only)
 * Idempotent — safe to run multiple times (fixed UUIDs + onConflictDoNothing).
 * Refuses to run in production unless SEED_ON_DEPLOY=true (develop runs with
 * NODE_ENV=production but opts in).
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { pgOptions } from '../pg-ssl';
import { uuidv7 } from 'uuidv7';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import * as schema from '../schema';
// Direct imports to avoid barrel tsx/CJS resolution edge cases at runtime.
import {
  workspaceItemCounters,
  projectMembers,
  projectTeams,
  workItems,
  iterationDailySnapshots,
  iterationTeamBaselines,
  iterations,
  releaseDailySnapshots,
  releaseTeamTargets,
  releases,
  teams,
  teamMembers,
  tasks,
  workItemRelations,
  milestones,
  milestoneReleases,
  milestoneProjects,
  milestoneTeams,
  milestoneArtifacts,
  memberCapacity,
  comments,
  labels,
  workItemLabels,
  timeLogs,
  workItemWatchers,
  portfolioItems,
  capacityPlans,
  capacityPlanAllocations,
  capacityPlanTeams,
  testCases,
  testResults,
} from '../schema/work';
import { userRoleAssignments } from '../schema/access';
import { seedSystemRolesInto } from './reference';
import { seedTenantBootstrapInto } from './bootstrap';
import { seedSecondProject } from './second-project';
import { seedReferenceExtras } from './reference-extras';
import {
  type Db,
  DEFAULT_WORKFLOW_STATUSES,
  getDeterministicRank,
  ADMIN_USER_ID,
  WORKSPACE_ID,
  DEVELOPER_ID,
  VIEWER_ID,
  NXP_STORY_1_ID,
  NXP_STORY_2_ID,
  NXP_STORY_3_ID,
  NXP_DEFECT_1_ID,
  NXP_TASK_1_ID,
  NXP_TASK_2_ID,
  NXP_TASK_3_ID,
  TEAM_ALPHA_ID,
  NXP_RELEASE_1_ID,
  NXP_ITER_CURRENT_ID,
  NXP_MILESTONE_1_ID,
  NXP_EPIC_1_ID,
  NXP_FEATURE_1_ID,
  NXP_FEATURE_2_ID,
  NXP_FEATURE_3_ID,
  NXP_FEATURE_4_ID,
  NXP_FEATURE_5_ID,
  NXP_FEATURE_6_ID,
  NXP_FEATURE_7_ID,
  NXP_RELEASE_2_ID,
  TEAM_BETA_ID,
  NXP_CAPACITY_PLAN_2_ID,
  NXP_CAPACITY_PLAN_ID,
  SEED_PROJECTS,
  NXP_TEST_CASE_1_ID,
  NXP_TEST_CASE_2_ID,
  NXP_TEST_RESULT_1_ID,
  NXP_TEST_RESULT_2_ID,
} from './constants';

// Assigned inside seed() before any helper function runs.
let db: Db;

async function seedProject(project: {
  id: string;
  key: string;
  name: string;
  description: string;
}) {
  // 1. Insert project row with fixed UUID (idempotent by primary key).
  //    If a project with the same key already exists (dev DB), fall back to
  //    the existing row so subsequent steps use the correct project_id.
  const inserted = await db
    .insert(schema.projects)
    .values({
      id: project.id,
      workspaceId: WORKSPACE_ID,
      key: project.key,
      name: project.name,
      description: project.description,
      leadId: ADMIN_USER_ID,
      status: 'active',
    })
    .onConflictDoNothing()
    .returning({ id: schema.projects.id });

  // Resolve the actual project ID (fresh DB → inserted ID; existing DB → look up by key)
  let actualId = inserted[0]?.id;
  if (!actualId) {
    const existing = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(eq(schema.projects.workspaceId, WORKSPACE_ID), eq(schema.projects.key, project.key)),
      )
      .limit(1);
    actualId = existing[0]?.id;
  }
  if (!actualId) return; // should never happen

  // 2. Initialise the WORKSPACE-wide item-key counter per type (Rally FormattedID;
  //    mirrors ProjectsService.createProject). Runs per project but the workspace
  //    counter rows are shared — onConflictDoNothing makes later projects no-op.
  const counterTypes = ['story', 'task', 'defect'] as const;
  for (const itemType of counterTypes) {
    await db
      .insert(schema.workspaceItemCounters)
      .values({ workspaceId: WORKSPACE_ID, itemType, lastItemNumber: 0 })
      .onConflictDoNothing();
  }

  // 3. NO project_members row for the lead.
  //
  // The lead of both seeded projects is the Workspace Admin, and §2.1/AC-8 say a Workspace Admin is
  // not added as a Project user — its authority is the workspace-wide grant, not a `project_members`
  // row. This block used to write exactly the row migration 0118 deletes, and `pnpm db:migrate` runs
  // this seed, so the fixture undid the migration on every local and CI database. A fixture that
  // reverses a migration is worse than either alone: the roster filter, `memberCount` and the POST
  // refusal all hide the row, so nothing on screen would have shown it coming back.
  //
  // It is not merely cosmetic. `AccessService.effectiveAssignments` synthesizes a project grant FROM
  // this table, so the row is dormant only while the user is a Workspace Admin — demote them and it
  // becomes a live Project Admin grant that no roster displays.
  //
  // NXP still has a real member (DEVELOPER_ID, `editor`, added below for the seeded assigneeId);
  // PAY deliberately has none, which is the honest picture of a project whose only principal is a WA.

  // 4. Seed default workflow statuses only if none exist yet for this project
  //    (avoids duplicating the 4 default statuses on re-seed)
  const existingStatuses = await db
    .select({ id: schema.workflowStatuses.id })
    .from(schema.workflowStatuses)
    .where(eq(schema.workflowStatuses.projectId, actualId))
    .limit(1);

  if (existingStatuses.length === 0) {
    for (const s of DEFAULT_WORKFLOW_STATUSES) {
      await db
        .insert(schema.workflowStatuses)
        .values({
          id: uuidv7(),
          workspaceId: WORKSPACE_ID,
          projectId: actualId,
          name: s.name,
          category: s.category,
          color: s.color,
          position: s.position,
          isDefault: s.isDefault,
        })
        .onConflictDoNothing();
    }
  }
}

// ── The one end-to-end demo flow (NXP only) ───────────────────────────────────
// Team Alpha (with members) → Story + Defect (team-linked) → 3 Tasks under the
// Story (team + iteration inherited from the parent, mirroring
// WorkItemsService.createTask's `teamId: opts.teamId ?? parent.teamId` and
// `iterationId: opts.iterationId ?? parent.iterationId` rules) → Iteration
// (contains the Story + Defect) → Release + Milestone (linked to each other
// and to the Story). Every FK below resolves to a real, matching row — no
// orphaned workspace_ids, no team-less tasks, no milestone dates that don't
// match their linked release's actual dates.
//
// Idempotent: fixed UUIDs + onConflictDoNothing throughout.
async function seedFlow() {
  const nxpId = SEED_PROJECTS[0].id;

  // ── 1. Team Alpha (with members) ────────────────────────────────────────
  await db
    .insert(teams)
    .values([
      {
        id: TEAM_ALPHA_ID,
        workspaceId: WORKSPACE_ID,
        name: 'Team Alpha',
        key: 'ALPHA',
        description: 'Core platform team — owns NX Platform.',
        leadId: ADMIN_USER_ID,
        status: 'active',
      },
      {
        // A SECOND team, because most of the capacity flow needs two: a Feature cannot be split
        // across one, `← from` / `→ to` provenance has nothing to name, and sorting the team grid
        // by a column cannot change anything.
        id: TEAM_BETA_ID,
        workspaceId: WORKSPACE_ID,
        name: 'Team Beta',
        key: 'BETA',
        description: 'Payments team — shares NX Platform delivery with Alpha.',
        leadId: ADMIN_USER_ID,
        status: 'active',
      },
    ])
    .onConflictDoNothing();

  // Members: the 3 core users (admin/dev/viewer) so the Team Status roster has
  // real coverage (including zero-task members, whose load bar renders empty).
  await db
    .insert(teamMembers)
    .values([
      {
        id: '00000000-0000-7000-8000-000000000080',
        workspaceId: WORKSPACE_ID,
        teamId: TEAM_ALPHA_ID,
        userId: ADMIN_USER_ID,
        status: 'active',
      },
      {
        id: '00000000-0000-7000-8000-000000000081',
        workspaceId: WORKSPACE_ID,
        teamId: TEAM_ALPHA_ID,
        userId: DEVELOPER_ID,
        status: 'active',
      },
      {
        id: '00000000-0000-7000-8000-000000000084',
        workspaceId: WORKSPACE_ID,
        teamId: TEAM_ALPHA_ID,
        userId: VIEWER_ID,
        status: 'active',
      },
    ])
    .onConflictDoNothing();

  // Link BOTH teams to NXP (project_teams) — creating a work item into an
  // iteration validates the team is linked to the project (assertTeamLinked);
  // without this link, "Add Item" fails with "Team is not linked to this
  // project".
  //
  // Beta was missing its link, and that mattered beyond seeding: a plan's team must belong to the
  // plan's project (the BA's "Project Breakdown"), the Add/Remove Teams picker lists exactly those
  // links, and Beta therefore rendered NO row while still carrying demand on two seeded plans — so it
  // could not be removed through the UI at all. An audit found 11 such rows in the dev database; this
  // seed was manufacturing two of them on every run.
  await db
    .insert(projectTeams)
    .values([
      {
        id: '00000000-0000-7000-8000-000000000090',
        workspaceId: WORKSPACE_ID,
        projectId: nxpId,
        teamId: TEAM_ALPHA_ID,
        status: 'active',
      },
      {
        id: '00000000-0000-7000-8000-000000000091',
        workspaceId: WORKSPACE_ID,
        projectId: nxpId,
        teamId: TEAM_BETA_ID,
        status: 'active',
      },
    ])
    .onConflictDoNothing();

  // ── 2. Release (real startDate + releaseDate — the milestone's derived ──
  //    dates below are set to literally match these, by construction; see
  //    MilestonesService.recalcTargetDates: MIN(release.startDate) /
  //    MAX(release.releaseDate) over the release(s) linked to a milestone).
  await db
    .insert(releases)
    .values({
      id: NXP_RELEASE_1_ID,
      workspaceId: WORKSPACE_ID,
      projectId: nxpId,
      releaseKey: 'RE-1',
      name: 'v2.0 — NX Platform Upgrade',
      description: 'Major upgrade to NX v21 + ESLint flat-config rollout.',
      status: 'planning',
      startDate: '2026-07-01',
      releaseDate: '2026-07-31',
    })
    .onConflictDoNothing();

  /**
   * A SECOND release, so the flow has somewhere to put its other two fixtures.
   *
   * A plan is one per (project, release), so the published-plan fixture below needs its own release,
   * and FE-7 needs a release that is not this plan's to be the "belongs to another release" refusal.
   */
  await db
    .insert(releases)
    .values({
      id: NXP_RELEASE_2_ID,
      workspaceId: WORKSPACE_ID,
      projectId: nxpId,
      releaseKey: 'RE-2',
      name: 'v2.1 — Payments hardening',
      description: 'Follow-on release: subscription billing and wallet cleanup.',
      status: 'planning',
      startDate: '2026-08-01',
      releaseDate: '2026-08-31',
    })
    .onConflictDoNothing();

  // ── 3. Iteration (committed — the active sprint), team-linked ──────────
  await db
    .insert(iterations)
    .values({
      id: NXP_ITER_CURRENT_ID,
      workspaceId: WORKSPACE_ID,
      projectId: nxpId,
      teamId: TEAM_ALPHA_ID,
      iterationKey: 'IT-1',
      name: 'Sprint 26.1',
      goal: 'Ship NX v21 upgrade and ESLint flat-config across all apps.',
      theme: 'NX Platform Modernisation',
      state: 'committed',
      plannedVelocity: 21,
      startDate: '2026-06-16',
      endDate: '2026-06-27',
    })
    .onConflictDoNothing();

  // ── 4. Milestone, linked to the release + project. Target dates equal ──
  //    MIN/MAX over the single linked release above — MUST stay in sync with
  //    the release's startDate/releaseDate by construction (single release,
  //    so MIN == MAX == that release's own dates).
  await db
    .insert(milestones)
    .values({
      id: NXP_MILESTONE_1_ID,
      workspaceId: WORKSPACE_ID,
      projectId: nxpId,
      milestoneKey: 'MS-1',
      name: 'GA — NX Platform v2',
      description: 'General availability of the v2 platform.',
      status: 'planned',
      ownerId: ADMIN_USER_ID,
      targetStartDate: '2026-07-01', // = NXP_RELEASE_1 startDate
      targetEndDate: '2026-07-31', // = NXP_RELEASE_1 releaseDate
    })
    .onConflictDoNothing();
  await db
    .insert(milestoneReleases)
    .values({ milestoneId: NXP_MILESTONE_1_ID, releaseId: NXP_RELEASE_1_ID })
    .onConflictDoNothing();
  await db
    .insert(milestoneProjects)
    .values({ milestoneId: NXP_MILESTONE_1_ID, projectId: nxpId })
    .onConflictDoNothing();
  // Milestone spans the delivering Team (Team Alpha) — completes the
  // "fully-linked flow": Team links are an optional m2m set explicitly here.
  await db
    .insert(milestoneTeams)
    .values({ milestoneId: NXP_MILESTONE_1_ID, teamId: TEAM_ALPHA_ID })
    .onConflictDoNothing();

  // ── 5. Story + Defect (both team-linked, in the iteration + release) ───
  const statusRows = await db
    .select({
      id: schema.workflowStatuses.id,
      category: schema.workflowStatuses.category,
    })
    .from(schema.workflowStatuses)
    .where(eq(schema.workflowStatuses.projectId, nxpId));
  const todoStatus = statusRows.find((s) => s.category === 'to_do')?.id;
  const inProgressStatus = statusRows.find((s) => s.category === 'in_progress')?.id;
  // `done` is the ACCEPTED end of the workflow — the capacity grid's `Complete` counts it, so the
  // split-Feature fixture needs one child sitting there.
  const acceptedStatus = statusRows.find((s) => s.category === 'done')?.id;
  if (!todoStatus || !inProgressStatus || !acceptedStatus) {
    throw new Error('seedFlow: NXP workflow statuses missing — seedProject must run first');
  }

  await db
    .insert(workItems)
    .values([
      {
        id: NXP_STORY_1_ID,
        workspaceId: WORKSPACE_ID,
        projectId: nxpId,
        teamId: TEAM_ALPHA_ID,
        iterationId: NXP_ITER_CURRENT_ID,
        releaseId: NXP_RELEASE_1_ID,
        itemKey: 'US-1',
        type: 'story' as const,
        title: 'Upgrade NX workspace to v21',
        statusId: inProgressStatus,
        // BR-WI-01: Flow State and Schedule State MIRROR — keep them equal.
        scheduleState: 'in_progress' as const,
        flowState: 'in_progress' as const,
        priority: 'high' as const,
        storyPoints: '5',
        assigneeId: ADMIN_USER_ID,
        createdBy: ADMIN_USER_ID,
        rank: getDeterministicRank('US-1'),
      },
      {
        id: NXP_DEFECT_1_ID,
        workspaceId: WORKSPACE_ID,
        projectId: nxpId,
        teamId: TEAM_ALPHA_ID,
        iterationId: NXP_ITER_CURRENT_ID,
        itemKey: 'DE-1',
        type: 'defect' as const,
        // Work-item hierarchy (DB design §Work item hierarchy / §19.3): a Defect
        // is a child of a Story via parent_id — this is the Defect's "User Story"
        // shown in the Quality grid. (The relates_to link below is a *secondary*
        // relation for the Linked Items block, not the hierarchy.)
        parentId: NXP_STORY_1_ID,
        title: 'CI pipeline fails intermittently on Windows build agents',
        statusId: inProgressStatus,
        // BR-WI-01: Flow State and Schedule State MIRROR — keep them equal.
        scheduleState: 'in_progress' as const,
        flowState: 'in_progress' as const,
        priority: 'urgent' as const,
        assigneeId: DEVELOPER_ID,
        createdBy: ADMIN_USER_ID,
        rank: getDeterministicRank('DE-1'),
        // Defect-specific fields (P3.4) — Quality board coverage.
        severity: 'major' as const,
        foundInEnvironment: 'staging' as const,
        rootCause: 'code' as const,
        defectState: 'open' as const,
      },
    ])
    .onConflictDoNothing();

  // Portfolio fixture (P5): one Epic over two Features.
  //
  // Seeded rather than created by E2E because the Portfolio screen is read-only
  // until the write slice lands, so a test has no way to make its own. FE-1 gets
  // the Story + Defect linked below so its rollup is non-empty; FE-2 stays childless
  // so the "no denominator" rendering has a case.
  //
  // Epics carry no parent/team/release by CHECK constraint (`ck_portfolio_epic_shape`).
  await db
    .insert(portfolioItems)
    .values([
      {
        id: NXP_EPIC_1_ID,
        workspaceId: WORKSPACE_ID,
        projectId: nxpId,
        itemKey: 'EP-1',
        type: 'epic' as const,
        name: 'Unified checkout platform',
        state: 'developing' as const,
        preliminaryEstimate: 'l' as const,
        ownerId: ADMIN_USER_ID,
        rank: getDeterministicRank('EP-1'),
      },
      {
        id: NXP_FEATURE_1_ID,
        workspaceId: WORKSPACE_ID,
        projectId: nxpId,
        parentId: NXP_EPIC_1_ID,
        teamId: TEAM_ALPHA_ID,
        releaseId: NXP_RELEASE_1_ID,
        itemKey: 'FE-1',
        type: 'feature' as const,
        name: 'Guest checkout flow',
        state: 'developing' as const,
        preliminaryEstimate: 'm' as const,
        ownerId: ADMIN_USER_ID,
        // Mirrors the linked release's window (RE-1: 2026-07-01 → 07-31). Without a
        // planned window `computeHealth` has no required acceptance rate, so both
        // Percent Done bars render grey and the whole green/yellow/red/blue scheme is
        // invisible in the demo. FE-2 deliberately keeps NO dates, so the "no verdict,
        // and here is why" rendering has a case too.
        plannedStartDate: '2026-07-01',
        plannedEndDate: '2026-07-31',
        rank: getDeterministicRank('FE-1'),
      },
      {
        id: NXP_FEATURE_2_ID,
        workspaceId: WORKSPACE_ID,
        projectId: nxpId,
        parentId: NXP_EPIC_1_ID,
        itemKey: 'FE-2',
        type: 'feature' as const,
        name: 'Saved payment methods',
        state: 'intake' as const,
        preliminaryEstimate: 's' as const,
        rank: getDeterministicRank('FE-2'),
      },
      /**
       * FE-3 … FE-7 exist for the CAPACITY flow, not for the Portfolio page.
       *
       * The plan fixture used to be one team and no Features, so most of the BA's flow (§4.4–§4.7)
       * had nothing to render: no split Feature, no unassigned demand, and none of the three
       * eligibility refusals. Each of these makes exactly one of those states real.
       */
      {
        id: NXP_FEATURE_3_ID,
        workspaceId: WORKSPACE_ID,
        projectId: nxpId,
        parentId: NXP_EPIC_1_ID,
        // A REFINED estimate, so the estimate tier ladder has a middle rung: FE-1 resolves from its
        // preliminary size, this one from a top-down number, and an allocated row beats both.
        refinedEstimate: '21',
        itemKey: 'FE-3',
        type: 'feature' as const,
        name: 'One-click reorder',
        state: 'developing' as const,
        preliminaryEstimate: 'm' as const,
        rank: getDeterministicRank('FE-3'),
      },
      {
        id: NXP_FEATURE_4_ID,
        workspaceId: WORKSPACE_ID,
        projectId: nxpId,
        parentId: NXP_EPIC_1_ID,
        itemKey: 'FE-4',
        type: 'feature' as const,
        name: 'Address book cleanup',
        state: 'feature_prioritization' as const,
        preliminaryEstimate: 's' as const,
        rank: getDeterministicRank('FE-4'),
      },
      {
        id: NXP_FEATURE_5_ID,
        workspaceId: WORKSPACE_ID,
        projectId: nxpId,
        itemKey: 'FE-5',
        type: 'feature' as const,
        name: 'Legacy wallet import (archived)',
        state: 'developing' as const,
        preliminaryEstimate: 'm' as const,
        // Archived: the picker must omit it and the API must refuse it.
        archivedAt: new Date(),
        rank: getDeterministicRank('FE-5'),
      },
      {
        id: NXP_FEATURE_6_ID,
        workspaceId: WORKSPACE_ID,
        projectId: nxpId,
        itemKey: 'FE-6',
        type: 'feature' as const,
        name: 'Crypto checkout (cancelled)',
        state: 'cancelled' as const,
        preliminaryEstimate: 'l' as const,
        rank: getDeterministicRank('FE-6'),
      },
      {
        id: NXP_FEATURE_7_ID,
        workspaceId: WORKSPACE_ID,
        projectId: nxpId,
        itemKey: 'FE-7',
        type: 'feature' as const,
        name: 'Subscription billing (next release)',
        state: 'developing' as const,
        preliminaryEstimate: 'm' as const,
        // Committed to the OTHER release: eligible for that plan, refused by this one.
        releaseId: NXP_RELEASE_2_ID,
        rank: getDeterministicRank('FE-7'),
      },
    ])
    .onConflictDoNothing();

  // Link the Story + Defect to FE-1 so the Feature (and, through it, the Epic)
  // has a real rollup. `feature_id` is the ONLY link between a work item and the
  // portfolio — a Story is never a child of an Epic directly.
  await db
    .update(workItems)
    .set({ featureId: NXP_FEATURE_1_ID })
    .where(inArray(workItems.id, [NXP_STORY_1_ID, NXP_DEFECT_1_ID]));

  /**
   * Two more Stories, under FE-3, so the SPLIT Feature has child work on BOTH teams.
   *
   * This is what makes Rollup and Complete mean anything on the capacity grid: those figures count
   * child Stories whose PROJECT and RELEASE match the plan, attributed by the child's own team. With
   * children on one team only, a shared Feature reported all its delivery against one side of the
   * split and the per-team columns could not be told apart from the Feature's total.
   *
   * US-3 is ACCEPTED, so `Complete` is non-zero for Beta while Alpha's stays behind — the D1
   * distinction (Complete counts completed/accepted/release; Percent Done counts accepted only) has
   * a case in the seed rather than only in a test.
   */
  /**
   * Keys carry a `D` for demo, because `uq_wi_item_key` is per WORKSPACE while the app mints keys
   * per project.
   *
   * A fixture claiming `US-2` collides the moment any project in the workspace has a second story —
   * an e2e run, a developer clicking Add — and `onConflictDoNothing` then skips the fixture
   * SILENTLY: the rows appear to exist, the plan reads zero rollup, and nothing says why. (That is
   * exactly what happened here, twice: first at `US-2`, then at `US-90`, which e2e debris in another
   * project already held.) `US-D1` is a shape the counter never produces, so the fixture can always
   * be inserted.
   *
   * Typed as the table's own insert row: `.values()` takes an ARRAY here, and without the annotation
   * the two rows' literal types (`in_progress` vs `accepted`) widen into a union the overload refuses.
   */
  const splitFeatureChildren: (typeof workItems.$inferInsert)[] = [
    {
      id: NXP_STORY_2_ID,
      workspaceId: WORKSPACE_ID,
      projectId: nxpId,
      teamId: TEAM_ALPHA_ID,
      iterationId: NXP_ITER_CURRENT_ID,
      releaseId: NXP_RELEASE_1_ID,
      itemKey: 'US-D1',
      type: 'story',
      title: 'Reorder API endpoint',
      statusId: inProgressStatus,
      scheduleState: 'in_progress',
      flowState: 'in_progress',
      priority: 'normal',
      storyPoints: '3',
      assigneeId: DEVELOPER_ID,
      createdBy: ADMIN_USER_ID,
      rank: getDeterministicRank('US-D1'),
    },
    {
      /**
       * Team Beta's story, and therefore NOT in Sprint 26.1.
       *
       * It used to carry `iterationId: NXP_ITER_CURRENT_ID` while Sprint 26.1 belongs to Team
       * Alpha — a pair `assertIterationAssignable` refuses with `ITERATION_TEAM_MISMATCH`, which
       * a raw seed insert bypasses. The Phase 6 reports then attributed its 8 points by the
       * ITERATION's team, so Alpha's Velocity bar carried Beta's work and Beta's chart was empty.
       * A seed must not manufacture a state the service would reject.
       *
       * Accepted with no iteration is a real shape: it still rolls up to FE-2 and the Portfolio
       * percentages (which read `schedule_state`), and Velocity legitimately ignores unscheduled
       * work because there is no timebox to attribute it to.
       */
      id: NXP_STORY_3_ID,
      workspaceId: WORKSPACE_ID,
      projectId: nxpId,
      teamId: TEAM_BETA_ID,
      releaseId: NXP_RELEASE_1_ID,
      itemKey: 'US-D2',
      type: 'story',
      title: 'Reorder payment re-auth',
      statusId: acceptedStatus,
      scheduleState: 'accepted',
      flowState: 'accepted',
      priority: 'normal',
      storyPoints: '8',
      assigneeId: DEVELOPER_ID,
      createdBy: ADMIN_USER_ID,
      rank: getDeterministicRank('US-D2'),
    },
  ];
  await db.insert(workItems).values(splitFeatureChildren).onConflictDoNothing();

  // Linked in a second statement, as FE-1's children are: `featureId` is the only tie between a work
  // item and the portfolio, and setting it here keeps both link sites reading the same way.
  await db
    .update(workItems)
    .set({ featureId: NXP_FEATURE_3_ID })
    .where(inArray(workItems.id, [NXP_STORY_2_ID, NXP_STORY_3_ID]));

  // Capacity plan fixture (P5.2): one draft plan on the seeded release, with Team Alpha
  // added and capacity deliberately left NULL so the "not entered" state — distinct from a
  // capacity of zero — has a case to render.
  await db
    .insert(capacityPlans)
    .values({
      id: NXP_CAPACITY_PLAN_ID,
      workspaceId: WORKSPACE_ID,
      projectId: nxpId,
      releaseId: NXP_RELEASE_1_ID,
      // The per-project key the list's ID column links from. Set explicitly because migration 0076
      // backfills EXISTING rows: on a fresh database it runs before this seed, so a plan inserted
      // without a key keeps none, the ID cell renders `—`, and nothing on the list is clickable.
      planKey: 'CP-1',
      name: 'NX Platform v2 capacity',
      unit: 'points' as const,
      // The release's own window (RE-1: 2026-07-01 → 07-31). Without planned dates there is
      // no window to forecast INTO, so Calculate Capacity Forecast could only ever refuse —
      // and publish (slice 7) writes these dates onto the Features it publishes.
      plannedStartDate: '2026-07-01',
      plannedEndDate: '2026-07-31',
    })
    .onConflictDoNothing();

  await db
    .insert(capacityPlanTeams)
    .values([
      { planId: NXP_CAPACITY_PLAN_ID, teamId: TEAM_ALPHA_ID },
      /**
       * Beta carries a REAL capacity while Alpha's stays null, so one plan shows both states the
       * whole feature turns on: "not entered" (no ceiling stated — every percentage is absent and
       * the missing-capacity warning fires) and an entered ceiling that demand can exceed.
       */
      { planId: NXP_CAPACITY_PLAN_ID, teamId: TEAM_BETA_ID, capacity: '20' },
    ])
    .onConflictDoNothing();

  /**
   * The plan's allocations — one row per state the BA flow reaches (§4.4–§4.6).
   *
   *   FE-1  Alpha, primary, source `feature_estimate` → 5, COPIED from its Preliminary size M at
   *                                             allocation time (§185). The badge says `Feature
   *                                             Estimate`, and the number no longer follows later
   *                                             edits to the Feature — that is the fixed snapshot
   *   FE-2  Alpha, primary, `manual` 5        → a number a planner typed (§186)
   *   FE-3  Alpha primary 8 + Beta 13         → SPLIT: `→ to Beta` on one row, `← from Alpha` on the
   *                                             other, a boxed count on the Features tab, and the
   *                                             only case where Remove All Assignments does work
   *   FE-4  no team                           → the Unallocated bucket: demand with nowhere to go,
   *                                             which is what the plan's Unassigned count counts
   *
   * Beta's ceiling is 20 and it is charged 13, so it sits UNDER capacity; Alpha has no ceiling at
   * all. Neither is over — a planner has to type a number to see the red rules, which is the point:
   * a seed that started over-capacity would make the warning look like the default state.
   */
  await db
    .insert(capacityPlanAllocations)
    .values([
      {
        planId: NXP_CAPACITY_PLAN_ID,
        portfolioItemId: NXP_FEATURE_1_ID,
        teamId: TEAM_ALPHA_ID,
        isPrimary: true,
        // 5 = the Preliminary M mapping, which is what a blank Estimate copied.
        value: '5',
        source: 'feature_estimate' as const,
      },
      {
        planId: NXP_CAPACITY_PLAN_ID,
        portfolioItemId: NXP_FEATURE_2_ID,
        teamId: TEAM_ALPHA_ID,
        isPrimary: true,
        value: '5',
        source: 'manual' as const,
      },
      {
        planId: NXP_CAPACITY_PLAN_ID,
        portfolioItemId: NXP_FEATURE_3_ID,
        teamId: TEAM_ALPHA_ID,
        isPrimary: true,
        value: '8',
        source: 'manual' as const,
      },
      {
        planId: NXP_CAPACITY_PLAN_ID,
        portfolioItemId: NXP_FEATURE_3_ID,
        teamId: TEAM_BETA_ID,
        isPrimary: false,
        value: '13',
        source: 'manual' as const,
      },
      {
        planId: NXP_CAPACITY_PLAN_ID,
        portfolioItemId: NXP_FEATURE_4_ID,
        teamId: null,
        isPrimary: false,
        value: '3',
        source: 'manual' as const,
      },
    ])
    .onConflictDoNothing();

  /**
   * A PUBLISHED plan on the second release.
   *
   * Published is half the lifecycle and the seed had no case for it: the read-only grid, the
   * `Revert to draft` path and the list's Published badge could only be reached by a test publishing
   * the draft plan first — which then left it published for every later test. This one exists to be
   * looked at, not edited.
   */
  await db
    .insert(capacityPlans)
    .values({
      id: NXP_CAPACITY_PLAN_2_ID,
      workspaceId: WORKSPACE_ID,
      projectId: nxpId,
      releaseId: NXP_RELEASE_2_ID,
      planKey: 'CP-2',
      name: 'Payments hardening capacity',
      unit: 'points' as const,
      plannedStartDate: '2026-08-01',
      plannedEndDate: '2026-08-31',
      status: 'published' as const,
      publishedAt: new Date('2026-07-20T09:00:00Z'),
      publishedBy: ADMIN_USER_ID,
    })
    .onConflictDoNothing();

  await db
    .insert(capacityPlanTeams)
    .values({ planId: NXP_CAPACITY_PLAN_2_ID, teamId: TEAM_BETA_ID, capacity: '34' })
    .onConflictDoNothing();

  await db
    .insert(capacityPlanAllocations)
    .values({
      planId: NXP_CAPACITY_PLAN_2_ID,
      portfolioItemId: NXP_FEATURE_7_ID,
      teamId: TEAM_BETA_ID,
      isPrimary: true,
      value: '21',
      source: 'manual' as const,
    })
    .onConflictDoNothing();

  // Assign the Story to the milestone (Iteration Status "Milestones" column).
  await db
    .insert(milestoneArtifacts)
    .values({
      milestoneId: NXP_MILESTONE_1_ID,
      entityType: 'work_item' as const,
      entityId: NXP_STORY_1_ID,
    })
    .onConflictDoNothing();

  // Work-item relation — populates the "Linked Items" block on Work Item Detail
  // (the CI defect relates to the upgrade story). Optional m2m; set explicitly.
  await db
    .insert(workItemRelations)
    .values({
      workspaceId: WORKSPACE_ID,
      sourceItemId: NXP_DEFECT_1_ID,
      targetItemId: NXP_STORY_1_ID,
      relationType: 'relates_to',
      createdBy: ADMIN_USER_ID,
    })
    .onConflictDoNothing();

  // ── 6. 3 Tasks under the Story — team/iteration EXPLICITLY inherited from ─
  //    the parent, mirroring WorkItemsService.createTask's real business rule
  //    (`teamId: opts.teamId ?? parent.teamId`, `iterationId: opts.iterationId
  //    ?? parent.iterationId`) so no seeded task is ever team-less.
  await db
    .insert(tasks)
    .values([
      {
        id: NXP_TASK_1_ID,
        workspaceId: WORKSPACE_ID,
        projectId: nxpId,
        parentId: NXP_STORY_1_ID,
        teamId: TEAM_ALPHA_ID,
        iterationId: NXP_ITER_CURRENT_ID,
        itemKey: 'TA-1',
        title: 'Update workspace.json for NX v21 breaking changes',
        state: 'completed' as const,
        assigneeId: DEVELOPER_ID,
        // Real-Rally task time: Estimate is an independent planned value; a
        // Completed task has To Do = 0 (nothing left); Actuals is what was
        // logged. Estimate (2) stays independent of To Do (0) / Actual (1.5).
        estimateHours: '2',
        todoHours: '0',
        actualHours: '1.5',
        rank: getDeterministicRank('TA-1'),
        createdBy: ADMIN_USER_ID,
      },
      {
        id: NXP_TASK_2_ID,
        workspaceId: WORKSPACE_ID,
        projectId: nxpId,
        parentId: NXP_STORY_1_ID,
        teamId: TEAM_ALPHA_ID,
        iterationId: NXP_ITER_CURRENT_ID,
        itemKey: 'TA-2',
        title: 'Validate all affected generators after upgrade',
        state: 'in_progress' as const,
        assigneeId: ADMIN_USER_ID,
        // Real-Rally task time: independent Estimate (3h planned); To Do (3h
        // remaining, defaulted to Estimate before work started); no Actuals yet.
        estimateHours: '3',
        todoHours: '3',
        actualHours: '0',
        rank: getDeterministicRank('TA-2'),
        createdBy: ADMIN_USER_ID,
      },
      {
        id: NXP_TASK_3_ID,
        workspaceId: WORKSPACE_ID,
        projectId: nxpId,
        parentId: NXP_STORY_1_ID,
        teamId: TEAM_ALPHA_ID,
        iterationId: NXP_ITER_CURRENT_ID,
        itemKey: 'TA-3',
        title: 'Migrate CI workflows to the NX v21 task runner',
        state: 'in_progress' as const,
        assigneeId: ADMIN_USER_ID,
        // The admin's task WITH logged Actuals, so Team Status' member progress
        // bar has something to draw on a fresh database. The bar is
        // `actual / estimate` (Team_Status SRS §10) and every local session signs
        // in as this user, so without a row like this their group reads a
        // truthful-but-useless 0% and the bar reads as broken. Deliberately
        // partial (5 of 8 logged, 3 remaining) rather than complete: it exercises
        // a mid-range fill instead of an empty or full bar, and it keeps the three
        // hour fields independent, which is the rule the other two rows also show.
        estimateHours: '8',
        todoHours: '3',
        actualHours: '5',
        rank: getDeterministicRank('TA-3'),
        createdBy: ADMIN_USER_ID,
      },
    ])
    .onConflictDoNothing();

  // ── 7. Workspace-wide per-type counters — keep in lock-step with what was
  //    actually seeded (US-1, DE-1, TA-1/TA-2/TA-3) so a later app-created item never
  //    collides on the unique (workspace_id, item_key) index.
  await db
    .update(workspaceItemCounters)
    .set({ lastItemNumber: sql`GREATEST(${workspaceItemCounters.lastItemNumber}, 1)` })
    .where(
      and(
        eq(workspaceItemCounters.workspaceId, WORKSPACE_ID),
        eq(workspaceItemCounters.itemType, 'story'),
      ),
    );
  await db
    .update(workspaceItemCounters)
    .set({ lastItemNumber: sql`GREATEST(${workspaceItemCounters.lastItemNumber}, 1)` })
    .where(
      and(
        eq(workspaceItemCounters.workspaceId, WORKSPACE_ID),
        eq(workspaceItemCounters.itemType, 'defect'),
      ),
    );
  await db
    .update(workspaceItemCounters)
    .set({ lastItemNumber: sql`GREATEST(${workspaceItemCounters.lastItemNumber}, 3)` })
    .where(
      and(
        eq(workspaceItemCounters.workspaceId, WORKSPACE_ID),
        eq(workspaceItemCounters.itemType, 'task'),
      ),
    );

  // ── 8. Activity logs (Revision History tab) ─────────────────────────────
  const existingActivity = await db
    .select({ id: schema.activityLogs.id })
    .from(schema.activityLogs)
    .where(eq(schema.activityLogs.contextId, NXP_STORY_1_ID))
    .limit(1);
  if (existingActivity.length === 0) {
    type ActivityRow = typeof schema.activityLogs.$inferInsert;
    const rows: ActivityRow[] = [
      {
        id: uuidv7(),
        workspaceId: WORKSPACE_ID,
        projectId: nxpId,
        contextId: NXP_STORY_1_ID,
        entityType: 'work_item',
        entityId: NXP_STORY_1_ID,
        actorId: ADMIN_USER_ID,
        action: 'work_item.created',
        changes: null,
        metadata: { title: 'Upgrade NX workspace to v21', type: 'story' },
      },
      {
        id: uuidv7(),
        workspaceId: WORKSPACE_ID,
        projectId: nxpId,
        contextId: NXP_STORY_1_ID,
        entityType: 'work_item',
        entityId: NXP_STORY_1_ID,
        actorId: ADMIN_USER_ID,
        action: 'work_item.assigned',
        changes: { field: 'assigneeId', old: null, new: ADMIN_USER_ID },
        metadata: {},
      },
      {
        id: uuidv7(),
        workspaceId: WORKSPACE_ID,
        projectId: nxpId,
        contextId: NXP_STORY_1_ID,
        entityType: 'work_item',
        entityId: NXP_STORY_1_ID,
        actorId: DEVELOPER_ID,
        action: 'work_item.schedule_state_changed',
        changes: { field: 'scheduleState', old: 'defined', new: 'in_progress' },
        metadata: {},
      },
      {
        id: uuidv7(),
        workspaceId: WORKSPACE_ID,
        projectId: nxpId,
        contextId: NXP_DEFECT_1_ID,
        entityType: 'work_item',
        entityId: NXP_DEFECT_1_ID,
        actorId: DEVELOPER_ID,
        action: 'work_item.created',
        changes: null,
        metadata: {
          title: 'CI pipeline fails intermittently on Windows build agents',
          type: 'defect',
        },
      },
      {
        id: uuidv7(),
        workspaceId: WORKSPACE_ID,
        projectId: nxpId,
        contextId: NXP_DEFECT_1_ID,
        entityType: 'work_item',
        entityId: NXP_DEFECT_1_ID,
        actorId: ADMIN_USER_ID,
        action: 'work_item.priority_changed',
        changes: { field: 'priority', old: 'normal', new: 'urgent' },
        metadata: {},
      },
    ];
    await db.insert(schema.activityLogs).values(rows);
  }

  // ── 8b. Iteration activity logs — unified activity_logs, entity_type=iteration
  const existingIterActivity = await db
    .select({ id: schema.activityLogs.id })
    .from(schema.activityLogs)
    .where(
      and(
        eq(schema.activityLogs.entityType, 'iteration'),
        eq(schema.activityLogs.entityId, NXP_ITER_CURRENT_ID),
      ),
    )
    .limit(1);
  if (existingIterActivity.length === 0) {
    type ActivityRow = typeof schema.activityLogs.$inferInsert;
    const iterRows: ActivityRow[] = [
      {
        id: uuidv7(),
        workspaceId: WORKSPACE_ID,
        projectId: nxpId,
        entityType: 'iteration',
        entityId: NXP_ITER_CURRENT_ID,
        actorId: ADMIN_USER_ID,
        action: 'iteration.created',
        changes: null,
        metadata: { name: 'Sprint 26.1' },
      },
      {
        id: uuidv7(),
        workspaceId: WORKSPACE_ID,
        projectId: nxpId,
        entityType: 'iteration',
        entityId: NXP_ITER_CURRENT_ID,
        actorId: ADMIN_USER_ID,
        action: 'iteration.updated',
        changes: { field: 'plannedVelocity', old: null, new: 21 },
        metadata: {},
      },
      {
        id: uuidv7(),
        workspaceId: WORKSPACE_ID,
        projectId: nxpId,
        entityType: 'iteration',
        entityId: NXP_ITER_CURRENT_ID,
        actorId: ADMIN_USER_ID,
        action: 'iteration.committed',
        changes: { field: 'state', old: 'planning', new: 'committed' },
        metadata: {},
      },
    ];
    await db.insert(schema.activityLogs).values(iterRows);
  }

  // ── 9. Member capacity — Team Alpha in the active iteration (Team Status) ─
  await db
    .insert(memberCapacity)
    .values([
      {
        id: '00000000-0000-7000-8000-0000000000c0',
        workspaceId: WORKSPACE_ID,
        projectId: nxpId,
        teamId: TEAM_ALPHA_ID,
        iterationId: NXP_ITER_CURRENT_ID,
        userId: ADMIN_USER_ID,
        capacityHours: '60',
      },
      {
        id: '00000000-0000-7000-8000-0000000000c1',
        workspaceId: WORKSPACE_ID,
        projectId: nxpId,
        teamId: TEAM_ALPHA_ID,
        iterationId: NXP_ITER_CURRENT_ID,
        userId: DEVELOPER_ID,
        capacityHours: '72',
      },
    ])
    .onConflictDoNothing();

  // ── 10. Labels + assignments ────────────────────────────────────────────
  const LBL_BUG = '00000000-0000-7000-8000-0000000000d0';
  const LBL_UX = '00000000-0000-7000-8000-0000000000d2';
  await db
    .insert(labels)
    .values([
      { id: LBL_BUG, workspaceId: WORKSPACE_ID, projectId: nxpId, name: 'bug', color: '#e5484d' },
      { id: LBL_UX, workspaceId: WORKSPACE_ID, projectId: nxpId, name: 'ux', color: '#3b82f6' },
    ])
    .onConflictDoNothing();
  await db
    .insert(workItemLabels)
    .values([
      { workItemId: NXP_DEFECT_1_ID, labelId: LBL_BUG },
      { workItemId: NXP_STORY_1_ID, labelId: LBL_UX },
    ])
    .onConflictDoNothing();

  // ── 11. Comments (one threaded reply on the Story, one on the Defect) ──
  await db
    .insert(comments)
    .values([
      {
        id: '00000000-0000-7000-8000-0000000000e0',
        workspaceId: WORKSPACE_ID,
        entityType: 'work_item' as const,
        entityId: NXP_STORY_1_ID,
        authorId: ADMIN_USER_ID,
        body: 'Kicking this off for the v2 milestone — aligning scope with the GA release.',
      },
      {
        id: '00000000-0000-7000-8000-0000000000e1',
        workspaceId: WORKSPACE_ID,
        entityType: 'work_item' as const,
        entityId: NXP_STORY_1_ID,
        authorId: DEVELOPER_ID,
        body: 'Picking it up. Will break the API work into tasks.',
        parentId: '00000000-0000-7000-8000-0000000000e0',
      },
      {
        id: '00000000-0000-7000-8000-0000000000e2',
        workspaceId: WORKSPACE_ID,
        entityType: 'work_item' as const,
        entityId: NXP_DEFECT_1_ID,
        authorId: DEVELOPER_ID,
        body: 'Reproduced on the Windows build agent; looks like a flaky checkout step.',
      },
    ])
    .onConflictDoNothing();

  // ── 12. Time logs ────────────────────────────────────────────────────────
  await db
    .insert(timeLogs)
    .values([
      {
        id: '00000000-0000-7000-8000-0000000000f0',
        workspaceId: WORKSPACE_ID,
        workItemId: NXP_STORY_1_ID,
        userId: DEVELOPER_ID,
        loggedDate: '2026-06-24',
        hours: '4.5',
        description: 'workspace.json migration + generator validation',
      },
      {
        id: '00000000-0000-7000-8000-0000000000f1',
        workspaceId: WORKSPACE_ID,
        workItemId: NXP_DEFECT_1_ID,
        userId: DEVELOPER_ID,
        loggedDate: '2026-06-25',
        hours: '2',
        description: 'Debug flaky Windows CI checkout step',
      },
    ])
    .onConflictDoNothing();

  // ── 13. Watchers ─────────────────────────────────────────────────────────
  await db
    .insert(workItemWatchers)
    .values([
      { workItemId: NXP_STORY_1_ID, userId: ADMIN_USER_ID, workspaceId: WORKSPACE_ID },
      { workItemId: NXP_DEFECT_1_ID, userId: DEVELOPER_ID, workspaceId: WORKSPACE_ID },
    ])
    .onConflictDoNothing();

  // ── 13.5. Phase 7 — Test Cases + Results (Phase A) ──────────────────────
  // Two Test Cases under the seeded Story: one WITH Results (incl. a `fail`, so `Last
  // Verdict`/`Last Run` — maintained by `trg_test_case_last_result` — are populated) and one with
  // NONE, so the tab's `Not Run` / `Not run yet` rendering (BR10, never `--`) has a case on a
  // fresh database. `type` is a literal snapshot string (D8) — not a lookup against
  // `work.test_case_types`, which a project only gets rows in via the migration 0129 backfill
  // (existing projects) or a future project-create hook (Phase G's G3); neither runs against a
  // project this seed itself creates on a FRESH database, so there is nothing to look up yet.
  await db
    .insert(testCases)
    .values([
      {
        id: NXP_TEST_CASE_1_ID,
        workspaceId: WORKSPACE_ID,
        projectId: nxpId,
        teamId: TEAM_ALPHA_ID,
        workItemId: NXP_STORY_1_ID,
        testCaseKey: 'TC-1',
        name: 'User can log in with valid credentials',
        objective: 'Verify the login flow accepts a correct email/password pair.',
        preconditions: 'A registered, active user account exists.',
        type: 'Functional',
        method: 'manual',
        priority: 'high',
        ownerId: ADMIN_USER_ID,
        assigneeId: DEVELOPER_ID,
        rank: getDeterministicRank('TC-1'),
        createdBy: ADMIN_USER_ID,
      },
      {
        id: NXP_TEST_CASE_2_ID,
        workspaceId: WORKSPACE_ID,
        projectId: nxpId,
        teamId: TEAM_ALPHA_ID,
        workItemId: NXP_STORY_1_ID,
        testCaseKey: 'TC-2',
        name: 'Login is rate-limited after repeated failures',
        objective: 'Verify the account locks out after 5 consecutive failed attempts.',
        type: 'Regression',
        method: 'manual',
        priority: 'normal',
        rank: getDeterministicRank('TC-2'),
        createdBy: ADMIN_USER_ID,
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(testResults)
    .values([
      {
        id: NXP_TEST_RESULT_1_ID,
        workspaceId: WORKSPACE_ID,
        projectId: nxpId,
        testCaseId: NXP_TEST_CASE_1_ID,
        workItemId: NXP_STORY_1_ID,
        testResultKey: 'TR-1',
        build: '2026.06.20-rc1',
        runDate: '2026-06-20',
        verdict: 'fail',
        durationMinutes: 4,
        testerId: DEVELOPER_ID,
        notes: 'Login rejected a valid password — traced to a stale bcrypt salt round config.',
        createdBy: DEVELOPER_ID,
      },
      {
        // Later date than TR-1, so this is the row `trg_test_case_last_result` should surface as
        // the Test Case's Last Verdict/Last Run — proves the trigger's own tie-break (latest
        // run_date, then created_at) rather than "whichever inserted last".
        id: NXP_TEST_RESULT_2_ID,
        workspaceId: WORKSPACE_ID,
        projectId: nxpId,
        testCaseId: NXP_TEST_CASE_1_ID,
        workItemId: NXP_STORY_1_ID,
        testResultKey: 'TR-2',
        build: '2026.06.21-rc2',
        runDate: '2026-06-21',
        verdict: 'pass',
        durationMinutes: 3,
        testerId: DEVELOPER_ID,
        notes: 'Fix verified — salt rounds corrected, login succeeds.',
        createdBy: DEVELOPER_ID,
      },
    ])
    .onConflictDoNothing();

  // Seeded keys must advance the counter, or the app mints TC-1 / TR-1 again and collides. Test
  // Cases/Results mint MAX+1 from their OWN table (like Portfolio), not `workspace_item_counters`
  // (whose `item_type` enum is narrowed to story/task/defect and cannot fit these) — so there is no
  // separate counter row to bump here; a fresh `MAX(substring(...))` naturally sees TC-2 / TR-2.

  // ── 14. Phase 6 report history ────────────────────────────────────────────
  await seedReportHistory();

  console.log(
    '✅  Demo flow seeded — Team Alpha, Story + Defect (team+iteration+release-linked), 3 Tasks, ' +
      '1 Iteration, 1 Release, 1 Milestone, plus capacity/labels/comments/time logs/watchers, ' +
      '2 Test Cases (one with 2 Results, one with none), and frozen Burndown + Release burnup history',
  );
}

/**
 * Frozen daily history for the Phase 6 reports.
 *
 * Without it every report renders its empty state on a fresh database, because Burndown and the
 * Release burnup read STORED snapshots (IB §5, RT-BR-09) and the hourly job only ever writes
 * TODAY — it cannot reconstruct the past, by design. The seeded iteration ran 2026-06-16..27 and
 * the seeded release 2026-07-01..31, both in the past, so no cron tick will ever fill them and
 * anyone reviewing the reports locally sees nothing at all.
 *
 * These rows are FABRICATED history, which is exactly what production must never do — hence
 * `finalized: true` and a seed-only writer. They are shaped to exercise the contract rather than
 * to look tidy:
 *   • one deliberate GAP (2026-06-24) so a reviewer sees a real gap rendered as a gap, not as a
 *     zero — the single most important behaviour in IB §5;
 *   • a weekend row (2026-06-20) that must NOT appear on the working-day axis, so the axis rule
 *     is visible too;
 *   • a captured `total_task_estimate_at_start`, so the Ideal line has a baseline to descend from;
 *   • a sparse burnup (four scattered days) so the isolated-point rendering stays honest.
 */
async function seedReportHistory() {
  /**
   * Burndown: hours remaining fall from the 40h baseline; accepted points climb to the sprint's 8.
   *
   * The sprint runs Tue 2026-06-16 → Sat 2026-06-27, so its LAST WORKING day is Fri 06-26 — that
   * is where the Ideal line reaches zero and where the team therefore has to land. Ending the
   * measured series at 06-27 instead left 4h outstanding on the last plotted day and the report
   * read `Behind plan`, correctly. The dates are the fixture's; the arithmetic is the SRS's.
   */
  const burndown: Array<{ date: string; todo: string; accepted: string }> = [
    { date: '2026-06-16', todo: '40', accepted: '0' },
    { date: '2026-06-17', todo: '36', accepted: '0' },
    { date: '2026-06-18', todo: '30', accepted: '0' },
    { date: '2026-06-19', todo: '26', accepted: '3' },
    // Saturday: stored for audit, never plotted.
    { date: '2026-06-20', todo: '26', accepted: '3' },
    { date: '2026-06-22', todo: '20', accepted: '3' },
    { date: '2026-06-23', todo: '16', accepted: '5' },
    // 2026-06-24 is MISSING on purpose — the job did not run. It must render as a gap.
    { date: '2026-06-25', todo: '6', accepted: '5' },
    // The last working day: finished, so the report reads `On track` rather than `Behind plan`.
    { date: '2026-06-26', todo: '0', accepted: '8' },
    // Also a Saturday, and after the finish — a second audit-only row.
    { date: '2026-06-27', todo: '0', accepted: '8' },
  ];

  /**
   * The Burndown baseline, in `iteration_team_baselines` (0098) rather than on the iteration.
   *
   * Attributed to Team Alpha, because every task in this sprint is Alpha's — and that row is what the
   * table sums into All Teams, so the Ideal reads 40 under either selection. A `teamId: null` row here
   * would claim the work has no resolvable team, which is false for this fixture.
   *
   * Replaced OUTRIGHT, not captured-once. Production must never overwrite a captured baseline (the
   * repository's insert uses `onConflictDoNothing`) — but the seed owns this fixed-UUID iteration, and
   * a shared dev database picks up whatever the e2e suites leave behind. A stale baseline of 5 under a
   * 40-hour seeded burndown draws an Ideal line that contradicts the bars beside it, which is worse
   * for a reviewer than no chart at all.
   */
  await db
    .delete(iterationTeamBaselines)
    .where(eq(iterationTeamBaselines.iterationId, NXP_ITER_CURRENT_ID));
  await db.insert(iterationTeamBaselines).values({
    id: uuidv7(),
    workspaceId: WORKSPACE_ID,
    iterationId: NXP_ITER_CURRENT_ID,
    teamId: TEAM_ALPHA_ID,
    totalTaskEstimateAtStart: '40',
    capturedAt: new Date('2026-06-16T08:00:00Z'),
  });

  /**
   * Two series per day: All Teams (`teamId: null`) and Team Alpha's own.
   *
   * Burndown history carries a team dimension from migration 0093, because a team-scoped chart
   * cannot be recomputed on read. Every task in this sprint belongs to Team Alpha, so the two
   * series carry the same numbers — that is what MEASURING each scope independently produces, and
   * it is what lets a reviewer switch the team selector and still see a chart.
   */
  await db
    .insert(iterationDailySnapshots)
    .values(
      burndown.flatMap((row) =>
        [null, TEAM_ALPHA_ID].map((teamId) => ({
          id: uuidv7(),
          workspaceId: WORKSPACE_ID,
          iterationId: NXP_ITER_CURRENT_ID,
          teamId,
          snapshotDate: row.date,
          remainingTodo: row.todo,
          acceptedPoints: row.accepted,
          capturedAt: new Date(`${row.date}T17:00:00Z`),
          // Every seeded day is a CLOSED day, so the job will not try to rewrite one.
          finalized: true,
        })),
      ),
    )
    .onConflictDoNothing();

  /**
   * Release burnup: one row per DAY across the release window (RE-1 runs 2026-07-01 → 07-31), with a
   * deliberate gap.
   *
   * Daily because that is what the cron writes, and because the chart cannot draw a LINE otherwise: a
   * segment needs two adjacent measured days, so four scattered days rendered as four isolated dots and
   * a lone Ideal line. Which is honest — RT-BR-09 forbids bridging a gap — but it made a working chart
   * look broken on the only data anyone sees locally.
   *
   * `accepted` ramps 0 → 13 in the steps a real release accepts work in (flat for days, then a jump when
   * a Story is signed off), so the shaded Accepted band has a shape rather than a slope. It ends at 13
   * against the Ideal's own 13, so the release reads as finished on time.
   *
   * 2026-07-17 is MISSING on purpose: the cron did not run, and the chart must show that day as a gap
   * rather than interpolate through it. One gap is enough to prove the rule; the previous fixture was
   * ALL gaps.
   *
   * `teamId: null` is the All Teams row and it is MEASURED, not summed from team rows — a work item two
   * teams both touch must be counted once.
   */
  const ACCEPTED_BY_DAY: Record<number, { accepted: string; count: number }> = {
    1: { accepted: '0', count: 0 },
    8: { accepted: '3', count: 1 },
    14: { accepted: '5', count: 2 },
    21: { accepted: '8', count: 3 },
    27: { accepted: '13', count: 4 },
  };
  const burnup = (() => {
    const rows: { date: string; accepted: string; count: number }[] = [];
    let current = ACCEPTED_BY_DAY[1];
    for (let day = 1; day <= 31; day += 1) {
      // The cron skipped this one. Everything else carries the last accepted figure forward, which is
      // what a daily snapshot of an unchanged release records.
      if (day === 17) continue;
      current = ACCEPTED_BY_DAY[day] ?? current;
      rows.push({ date: `2026-07-${String(day).padStart(2, '0')}`, ...current });
    }
    return rows;
  })();

  /**
   * Two series per day, as the burndown above does: All Teams (`teamId: null`, MEASURED) and Team
   * Alpha's own. Alpha carries every item in this release, so the numbers coincide — which is what
   * measuring each scope independently produces, and it is what gives the team-scoped burnup a
   * series to sit beneath its own Ideal target below.
   */
  await db
    .insert(releaseDailySnapshots)
    .values(
      burnup.flatMap((row) =>
        [null, TEAM_ALPHA_ID].map((teamId) => ({
          id: uuidv7(),
          workspaceId: WORKSPACE_ID,
          releaseId: NXP_RELEASE_1_ID,
          teamId,
          snapshotDate: row.date,
          acceptedPoints: row.accepted,
          acceptedCount: row.count,
          plannedPoints: '13',
          plannedCount: 4,
          preliminaryPoints: '21',
          preliminaryCount: 6,
          capturedAt: new Date(`${row.date}T17:00:00Z`),
          finalized: true,
        })),
      ),
    )
    .onConflictDoNothing();

  /**
   * The Ideal target the burnup climbs toward, per scope, in `release_team_targets`.
   *
   * One row per scope the snapshots above carry, because this table's `team_id IS NULL` row is the
   * MEASURED All Teams target and is never summed — unlike `iteration_team_baselines`. Alpha owns every
   * item in this release, so both rows read 13 points / 4 items.
   *
   * Replaced outright, again because the seed owns this release and the job's own write is capture-once.
   */
  await db.delete(releaseTeamTargets).where(eq(releaseTeamTargets.releaseId, NXP_RELEASE_1_ID));
  await db.insert(releaseTeamTargets).values(
    [null, TEAM_ALPHA_ID].map((teamId) => ({
      id: uuidv7(),
      workspaceId: WORKSPACE_ID,
      releaseId: NXP_RELEASE_1_ID,
      teamId,
      idealTargetPoints: '13',
      idealTargetCount: 4,
      capturedAt: new Date('2026-07-06T17:00:00Z'),
    })),
  );
}

/**
 * Run all DEMO seed operations against the given database URL: the sample `acme`
 * workspace, demo users, projects, work items, teams, releases, iterations and a
 * dev SSO connection. These are FIXTURES for dev/staging/E2E only — never real
 * production. The reference role catalogue (seedSystemRoles) is invoked first so
 * role assignments resolve; that part is prod-safe, the rest is not.
 *
 * Exported so db/migrate.ts can call it when SEED_ON_DEPLOY=true.
 * Safe to call multiple times — all inserts use onConflictDoNothing.
 */
export async function seed(connectionUrl?: string): Promise<void> {
  // Develop runs with NODE_ENV=production but legitimately opts into seeding via
  // SEED_ON_DEPLOY=true. Only a real production deploy (no SEED_ON_DEPLOY) is blocked.
  if (process.env['NODE_ENV'] === 'production' && process.env['SEED_ON_DEPLOY'] !== 'true') {
    throw new Error('Seed script must not run in production (NODE_ENV=production).');
  }

  const url = connectionUrl ?? process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL or connectionUrl required');

  const pool = new Pool({ ...pgOptions(url), max: 1 });
  db = drizzle(pool, { schema });

  try {
    console.log('Seeding...');

    // ── Workspace + SSO connection (shared prod-safe bootstrap) ───────────────
    // The primary workspace and its Entra SSO connection are created by the same
    // prod-safe routine used on real deploys, so dev and prod resolve identically.
    await seedTenantBootstrapInto(db);

    // ── Admin user ───────────────────────────────────────────────────────────
    // SSO-only: no password. The platform-admin email is seeded so the first
    // Entra SSO login merges into this row (upsertBySsoIdentity matches by email)
    // and PLATFORM_ADMIN_EMAILS auto-elevates it to workspace_admin.
    const adminEmail = process.env['ADMIN_EMAIL'] ?? 'admin@qnsc.dev';
    await db
      .insert(schema.users)
      .values({
        id: ADMIN_USER_ID,
        email: adminEmail,
        displayName: 'Admin User',
        emailVerified: true,
        locale: 'en',
        timezone: 'Asia/Ho_Chi_Minh',
      })
      .onConflictDoNothing();

    // ── Workspace member ─────────────────────────────────────────────────────
    await db
      .insert(schema.workspaceMembers)
      .values({
        workspaceId: WORKSPACE_ID,
        userId: ADMIN_USER_ID,
      })
      .onConflictDoNothing();

    // ── Additional users: developer + viewer ─────────────────────────────────
    // SSO-only: passwordless. Sign in via Entra; roles are assigned below.
    await db
      .insert(schema.users)
      .values([
        {
          id: DEVELOPER_ID,
          email: 'dev@qnsc.dev',
          displayName: 'Alice Developer',
          emailVerified: true,
          locale: 'en',
          timezone: 'Asia/Ho_Chi_Minh',
        },
        {
          id: VIEWER_ID,
          email: 'viewer@qnsc.dev',
          displayName: 'Bob Viewer',
          emailVerified: true,
          locale: 'en',
          timezone: 'Asia/Ho_Chi_Minh',
        },
      ])
      .onConflictDoNothing();

    await db
      .insert(schema.workspaceMembers)
      .values([
        { workspaceId: WORKSPACE_ID, userId: DEVELOPER_ID },
        { workspaceId: WORKSPACE_ID, userId: VIEWER_ID },
      ])
      .onConflictDoNothing();

    // ── System roles ─────────────────────────────────────────────────────────
    // Reference catalogue (roles + permission grants). Shared with the prod-safe
    // standalone entrypoint so dev seeds and production deploys stay in lock-step.
    await seedSystemRolesInto(db);

    // Resolve a role id preferring the workspace-owned editable copy over the
    // global template (both share a slug after migration 0047). Workspace Admin
    // has no per-workspace copy, so it resolves to the global immutable anchor.
    const resolveRoleId = async (slug: string): Promise<string | undefined> => {
      const rows = await db
        .select({ id: schema.systemRoles.id, workspaceId: schema.systemRoles.workspaceId })
        .from(schema.systemRoles)
        .where(
          and(
            eq(schema.systemRoles.slug, slug),
            or(
              isNull(schema.systemRoles.workspaceId),
              eq(schema.systemRoles.workspaceId, WORKSPACE_ID),
            ),
          ),
        );
      return (rows.find((r) => r.workspaceId === WORKSPACE_ID) ?? rows[0])?.id;
    };

    // ── Admin user role assignment (workspace_admin for the default workspace) ──
    const adminRoleId = await resolveRoleId('workspace_admin');

    if (adminRoleId) {
      await db
        .insert(userRoleAssignments)
        .values({
          workspaceId: WORKSPACE_ID,
          userId: ADMIN_USER_ID,
          roleId: adminRoleId,
          scopeType: 'workspace',
          scopeId: WORKSPACE_ID,
          grantedBy: ADMIN_USER_ID,
        })
        .onConflictDoNothing();
    }

    // ── The developer and the viewer get NO workspace-scoped tier role ─────────
    //
    // This block used to assign `project_member` to DEVELOPER_ID and `project_viewer` to
    // VIEWER_ID at `scopeType: 'workspace'`. Both are gone deliberately, and re-adding either
    // would undo migration 0111 on every seed.
    //
    // Under the 3-level model a per-Project tier role is granted PER PROJECT, through
    // `work.project_members.access_level` — which is why 0111 DELETEs exactly these rows as
    // "pure legacy over-grant". The seed re-created them immediately afterwards, so a
    // developer carried the full Editor delivery set as a workspace baseline in every project,
    // including ones they hold no grant on.
    //
    // The cost of that was not hypothetical: it made the project-scoped path unreachable in
    // testing, and so it MASKED the two P0 access defects of 2026-08-14 — the same shape
    // CLAUDE.md records for `report:view`, where a Workspace Admin's `workspace:*` hid a broken
    // gate from every test. `read-scoping.e2e.spec.ts` said so out loud in a comment: "the
    // honest expectation here is not 'fewer projects'", because with this grant in place there
    // was no narrowing left to observe.
    //
    // DEVELOPER_ID's real access is the NXP `editor` row written below; VIEWER_ID deliberately
    // has none, which is what makes it usable as a No Access principal. A spec that needs a
    // read-only workspace grant asks for one explicitly — `ensureViewerGrant` in
    // `test/e2e/support/flow-harness.ts` creates a custom role, exercising the supported
    // mechanism instead of a fixture shortcut.
    //
    // `project_viewer` did not exist to be granted anyway: it was removed in the Phase 4.2
    // reconciliation, so `resolveRoleId('project_viewer')` had been returning undefined and
    // that half of the block was already dead.

    // ── Projects (real business flow: project + counter + member + statuses) ──
    for (const project of SEED_PROJECTS) {
      await seedProject(project);
    }

    // ── Add developer as NXP project member (so seeded assigneeId is valid) ──
    await db
      .insert(projectMembers)
      .values({
        id: uuidv7(),
        workspaceId: WORKSPACE_ID,
        projectId: SEED_PROJECTS[0].id, // NXP
        userId: DEVELOPER_ID,
        accessLevel: 'editor',
        status: 'active',
      })
      .onConflictDoNothing();

    // ── NXP's deep reference data (team, story+defect, tasks, iteration, ─────
    // release, milestone — see seedFlow() for the full relation graph) ───────
    await seedFlow();

    // ── PAY: the SECOND project, one row of every entity type ───────────────
    // Every rule that needs "somewhere else" — isolation, permission scoping, cross-project
    // refusals — now has a fixture instead of building its own. See second-project.ts.
    await seedSecondProject(db);

    // ── The reference data no seed reached ──────────────────────────────────
    // Ten tables had zero rows on a freshly seeded database — attachments/files, every notification
    // table, the whole SCM chain behind the Connections tab, audit logs, workflow transitions — plus
    // NXP had one iteration, which cannot express Velocity or an unscheduled backlog.
    await seedReferenceExtras(db);

    console.log(
      `✅  Test fixture seeded — 1 project (NXP), 3 users, 1 team, 1 iteration, 1 release, 1 milestone, 1 story + 1 defect + 3 tasks (one fully-linked flow)`,
    );
  } finally {
    await pool.end();
  }
}
