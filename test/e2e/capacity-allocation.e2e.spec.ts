/**
 * Capacity allocation E2E — the metric definitions, against real SQL.
 *
 * These exist because only a real database can show whether the SQL implements
 * `P5-CAP-AC-016`: Complete is the live sum of child Plan Estimate at `Completed`, `Accepted` or
 * `Release`; Rollup is the live sum of EVERY linked Story/Defect Plan Estimate. No Project or
 * Release qualifier — the BA reversed Rally's on 2026-08-17 (`P5-CP-029`, P0), which is why the
 * first test here now asserts the opposite of what it used to.
 *
 * Three consequences are asserted here and cannot be seen from a unit test:
 *
 *   • EVERY linked child counts, including one carrying no Release of its own — the ordinary shape,
 *     and the one that made the BA's Feature report `Rollup = 0`;
 *   • a Feature SHARED between teams is not double-counted, and its team slices still SUM to the
 *     Feature's own total: a child lands in exactly one slice, its own team's when that team is
 *     allocated the Feature here, otherwise the Feature's owner's;
 *   • `Complete` uses COMPLETED_SCHEDULE_STATES while the portfolio's Percent Done uses
 *     ACCEPTED_SCHEDULE_STATES — the D1 distinction, which must stay different.
 *
 * Prereqs: docker deps up + `pnpm db:migrate` (see flow-harness).
 */
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CapacityPlansService } from '@modules/capacity';
import { PortfolioItemsService } from '@modules/portfolio';
import { ProjectsService } from '@modules/projects';
import { ReleasesService } from '@modules/releases';
import { DRIZZLE } from '@platform';
import type { DrizzleDB } from '@platform';
import { projectTeams, teams, workItems, workflowStatuses } from '@db/schema/work';
import { eq } from 'drizzle-orm';

import { WORKSPACE_ID, adminActor, bootRovaApp, uniqueKey } from './support/flow-harness';

describe('capacity allocation (e2e)', () => {
  let app: NestFastifyApplication;
  let capacity: CapacityPlansService;
  let portfolio: PortfolioItemsService;
  let projects: ProjectsService;
  let releases: ReleasesService;
  let db: DrizzleDB;

  const admin = adminActor();
  let projectId: string;
  let planReleaseId: string;
  let otherReleaseId: string;
  let planId: string;
  let teamAId: string;
  let teamBId: string;
  let statusId: string;

  /** A story under `featureId`, in the given release, owned by the given team. */
  async function story(args: {
    featureId: string;
    releaseId: string | null;
    teamId: string | null;
    points: string;
    state?: 'defined' | 'completed' | 'accepted';
  }) {
    const [row] = await db
      .insert(workItems)
      .values({
        workspaceId: WORKSPACE_ID,
        projectId,
        itemKey: `US-CAP-${uniqueKey()}`,
        type: 'story',
        title: 'Capacity child',
        statusId,
        scheduleState: args.state ?? 'defined',
        flowState: args.state ?? 'defined',
        storyPoints: args.points,
        featureId: args.featureId,
        releaseId: args.releaseId,
        teamId: args.teamId,
        rank: `r${uniqueKey()}`,
        createdBy: admin.sub,
      })
      .returning({ id: workItems.id });
    return row.id;
  }

  async function newFeature(name: string) {
    const f = await portfolio.createItem(admin, { projectId, type: 'feature', name });
    return f.id;
  }

  beforeAll(async () => {
    app = await bootRovaApp();
    capacity = app.get(CapacityPlansService);
    portfolio = app.get(PortfolioItemsService);
    projects = app.get(ProjectsService);
    releases = app.get(ReleasesService);
    db = app.get<DrizzleDB>(DRIZZLE);

    const p = await projects.createProject(admin, { key: uniqueKey(), name: 'Alloc Project' });
    projectId = p.id;

    // `work_items.status_id` is NOT NULL and `createProject` seeds the project's default
    // statuses, so read one straight from the table — the same thing the demo seed does.
    const statuses = await db
      .select({ id: workflowStatuses.id })
      .from(workflowStatuses)
      .where(eq(workflowStatuses.projectId, projectId))
      .limit(1);
    statusId = statuses[0].id;

    planReleaseId = (await releases.createRelease(admin, projectId, `Rel ${uniqueKey()}`, {})).id;
    otherReleaseId = (await releases.createRelease(admin, projectId, `Rel ${uniqueKey()}`, {})).id;

    const made = await db
      .insert(teams)
      .values([
        {
          workspaceId: WORKSPACE_ID,
          name: `Alloc A ${uniqueKey()}`,
          key: uniqueKey('A'),
          status: 'active',
        },
        {
          workspaceId: WORKSPACE_ID,
          name: `Alloc B ${uniqueKey()}`,
          key: uniqueKey('B'),
          status: 'active',
        },
      ])
      .returning({ id: teams.id });
    teamAId = made[0].id;
    teamBId = made[1].id;
    // Both LINKED to the project: `addTeam` requires a plan's team to be one of the project's own
    // (the BA's "Project Breakdown"), which the guard reads from `project_teams`.
    await db.insert(projectTeams).values([
      { workspaceId: WORKSPACE_ID, projectId, teamId: teamAId },
      { workspaceId: WORKSPACE_ID, projectId, teamId: teamBId },
    ]);

    const plan = await capacity.createPlan(admin, {
      projectId,
      releaseId: planReleaseId,
      name: 'Alloc plan',
      unit: 'points',
    });
    planId = plan.id;
    await capacity.addTeam(admin, planId, teamAId);
    await capacity.addTeam(admin, planId, teamBId);
    await capacity.setTeamCapacity(admin, planId, teamAId, '50');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('counts EVERY linked child, whatever Release it carries — AC-016 has no qualifier', async () => {
    /**
     * `P5-CP-029`, and the exact assertion this test used to make in reverse.
     *
     * It read "ONLY the 8. Without Rally's release filter this would read 16", pinning the declared
     * divergence in Broadcom's favour. The BA ruled against it on 2026-08-17 (Confirmed Fail, P0): the
     * release-less child is the ORDINARY shape — a Story gets a Release only if someone sets one — so
     * the filter made a Feature whose children were all in progress report `Rollup = 0` on all three
     * surfaces at once.
     */
    const featureId = await newFeature(`Release filter ${uniqueKey()}`);
    await capacity.allocate(admin, planId, {
      portfolioItemId: featureId,
      teamId: teamAId,
      value: 100,
    });

    // 8 points in the plan's release, 5 in another release, 3 with no release at all.
    await story({ featureId, releaseId: planReleaseId, teamId: teamAId, points: '8' });
    await story({ featureId, releaseId: otherReleaseId, teamId: teamAId, points: '5' });
    await story({ featureId, releaseId: null, teamId: teamAId, points: '3' });

    const detail = await capacity.getPlanDetail(admin, planId);
    const row = detail.allocations.find((a) => a.portfolioItemId === featureId);
    const item = detail.items.find((i) => i.portfolioItemId === featureId);

    // All 16, on the team slice and on the Features tab alike.
    expect(row?.metrics.rollup).toBe(16);
    expect(item?.rollup).toBe(16);
  });

  it('does NOT double-count a Feature shared between two teams, and the slices SUM', async () => {
    const featureId = await newFeature(`Shared ${uniqueKey()}`);
    await capacity.allocate(admin, planId, {
      portfolioItemId: featureId,
      teamId: teamAId,
      value: 10,
    });
    await capacity.allocate(admin, planId, {
      portfolioItemId: featureId,
      teamId: teamBId,
      value: 10,
    });

    await story({ featureId, releaseId: planReleaseId, teamId: teamAId, points: '7' });
    await story({ featureId, releaseId: planReleaseId, teamId: teamBId, points: '4' });

    const detail = await capacity.getPlanDetail(admin, planId);
    const rows = detail.allocations.filter((a) => a.portfolioItemId === featureId);
    const byTeam = new Map(rows.map((r) => [r.teamId, r.metrics.rollup]));

    // Each child lands in exactly ONE slice — 7 and 4, not 11 and 11.
    expect(byTeam.get(teamAId)).toBe(7);
    expect(byTeam.get(teamBId)).toBe(4);
    // ...and together they are the Feature's own total, which is what makes the plan header (the sum
    // of the team rows) agree with the Features tab. AC-017's reconciliation requirement.
    const item = detail.items.find((i) => i.portfolioItemId === featureId);
    expect((byTeam.get(teamAId) ?? 0) + (byTeam.get(teamBId) ?? 0)).toBe(item?.rollup);
  });

  it('gives an UNTEAMED child to the Feature’s owner, so no slice loses it', async () => {
    /**
     * The two-tier attribution, and the half that was missing. `work_items.team_id` is nullable and
     * mostly unset, and the slice predicate was a strict `work_items.team_id = ?` — SQL equality never
     * matches NULL, so an unteamed child fell out of EVERY team slice and therefore out of the plan
     * header, which is the sum of them. It now falls to the Feature's primary team, Rally's Planned
     * Team Assignment: exactly one slice, and the slices still sum.
     */
    const featureId = await newFeature(`Unteamed ${uniqueKey()}`);
    await capacity.allocate(admin, planId, {
      portfolioItemId: featureId,
      teamId: teamAId,
      value: 10,
    });
    await capacity.allocate(admin, planId, {
      portfolioItemId: featureId,
      teamId: teamBId,
      value: 10,
    });

    // No team at all, and `completed` so it lands in both sums.
    await story({
      featureId,
      releaseId: planReleaseId,
      teamId: null,
      points: '6',
      state: 'completed',
    });

    const detail = await capacity.getPlanDetail(admin, planId);
    const rows = detail.allocations.filter((a) => a.portfolioItemId === featureId);
    const owner = rows.find((r) => r.isPrimary);
    const contributor = rows.find((r) => !r.isPrimary);

    // The first team allocated becomes the primary (`allocate`), so team A owns it here.
    expect(owner?.teamId).toBe(teamAId);
    expect(owner?.metrics.rollup).toBe(6);
    expect(owner?.metrics.complete).toBe(6);
    // Counted ONCE: the contributor's slice is empty rather than a second copy.
    expect(contributor?.metrics.rollup).toBe(0);
    const item = detail.items.find((i) => i.portfolioItemId === featureId);
    expect(item?.rollup).toBe(6);
  });

  it('separates Complete (COMPLETED states) from the portfolio’s accepted-only rule', async () => {
    const featureId = await newFeature(`Complete ${uniqueKey()}`);
    await capacity.allocate(admin, planId, {
      portfolioItemId: featureId,
      teamId: teamAId,
      value: 30,
    });

    await story({
      featureId,
      releaseId: planReleaseId,
      teamId: teamAId,
      points: '2',
      state: 'defined',
    });
    await story({
      featureId,
      releaseId: planReleaseId,
      teamId: teamAId,
      points: '3',
      state: 'completed',
    });
    await story({
      featureId,
      releaseId: planReleaseId,
      teamId: teamAId,
      points: '4',
      state: 'accepted',
    });

    const detail = await capacity.getPlanDetail(admin, planId);
    const row = detail.allocations.find((a) => a.portfolioItemId === featureId);

    expect(row?.metrics.rollup).toBe(9);
    // completed + accepted = 7. The portfolio's Percent Done would count only the accepted 4.
    expect(row?.metrics.complete).toBe(7);

    const item = await portfolio.getItem(admin, featureId);
    expect(item.rollup.acceptedPoints).toBe(4);
    expect(item.rollup.completedPoints).toBe(7);
  });

  it('labels a supplied value MANUAL, and warns when children outgrow it', async () => {
    const featureId = await newFeature(`Tier ${uniqueKey()}`);
    await capacity.allocate(admin, planId, {
      portfolioItemId: featureId,
      teamId: teamAId,
      value: 5,
    });
    await story({ featureId, releaseId: planReleaseId, teamId: teamAId, points: '9' });

    const detail = await capacity.getPlanDetail(admin, planId);
    const row = detail.allocations.find((a) => a.portfolioItemId === featureId);

    expect(row?.source).toBe('manual');
    // The SERVICE returns the raw numeric string; the controller is what converts it for the wire.
    expect(Number(row?.value)).toBe(5);
    // 9 > 5: the plan under-committed for this work.
    expect(row?.metrics.warnings).toContain('rollup_exceeds_estimated');
    // The Feature's own Estimated resolves to Total Allocated (AC-014), so the tier is `allocated`
    // even though the ROW itself is a typed number rather than a tier.
    const item = detail.items.find((i) => i.portfolioItemId === featureId);
    expect(item?.tier).toBe('allocated');
    expect(item?.estimated).toBe(5);
  });

  it('keeps the Unallocated bucket out of team demand and out of Total Allocated', async () => {
    const featureId = await newFeature(`Bucket ${uniqueKey()}`);
    await capacity.allocate(admin, planId, { portfolioItemId: featureId, teamId: null, value: 12 });

    const detail = await capacity.getPlanDetail(admin, planId);
    const row = detail.allocations.find((a) => a.portfolioItemId === featureId);

    expect(row?.teamId).toBeNull();
    expect(detail.unallocated).toBeGreaterThanOrEqual(12);
    // 12 is real demand a planner typed, and the plan reports it under `unallocated` above. What it
    // must NOT do is reach the Feature's Estimated: §294 counts only team-assigned rows toward Total
    // Allocated, so the Feature still resolves through Refined → Preliminary.
    expect(row?.source).toBe('manual');
    const item = detail.items.find((i) => i.portfolioItemId === featureId);
    expect(item?.estimateBreakdown.allocated).toBeNull();
    // The bucket contributes nothing to any team's Estimated.
    const teamA = detail.teams.find((t) => t.teamId === teamAId);
    const chargedToA = detail.allocations
      .filter((a) => a.teamId === teamAId)
      .reduce((sum, a) => sum + a.metrics.estimated, 0);
    expect(teamA?.metrics.estimated).toBe(chargedToA);
  });

  it('COPIES the Feature estimate into a fixed row, and the copy does not follow the Feature', async () => {
    /**
     * §185-186 against real SQL, which is where the fixed-snapshot rule is actually visible: only the
     * database can show the column holding a copied 5 rather than a NULL resolved per read.
     *
     * Preliminary 'm' explicitly — the shared fixture leaves the estimate empty, which copies 0. A
     * legitimate state, but not the one this rule is about.
     */
    const feature = await portfolio.createItem(admin, {
      projectId,
      type: 'feature',
      name: `Assigned ${uniqueKey()}`,
      preliminaryEstimate: 'm',
    });
    const featureId = feature.id;
    await capacity.allocate(admin, planId, { portfolioItemId: featureId, teamId: teamAId });

    const detail = await capacity.getPlanDetail(admin, planId);
    const row = detail.allocations.find((a) => a.portfolioItemId === featureId);

    // The seeded map puts 'm' at 5 points, and that 5 is STORED.
    expect(Number(row?.value)).toBe(5);
    expect(row?.source).toBe('feature_estimate');
    expect(row?.metrics.estimated).toBe(5);

    /**
     * Now the Feature is re-forecast to 21. The plan must not move: a planner's committed demand is
     * not a subscription to someone else's edit, which is what a resolving read made it.
     */
    await portfolio.updateItem(admin, featureId, { refinedEstimate: '21' });
    const afterEdit = (await capacity.getPlanDetail(admin, planId)).allocations.find(
      (a) => a.portfolioItemId === featureId,
    );
    expect(Number(afterEdit?.value)).toBe(5);
    expect(afterEdit?.metrics.estimated).toBe(5);
    // The Feature's new forecast still travels, so the row can be compared against it and re-copied.
    expect(afterEdit?.estimateBreakdown.refined).toBe(21);

    // Typing a slice relabels the row `manual`…
    await capacity.updateAllocation(admin, planId, row!.id, { value: 13 });
    const sliced = (await capacity.getPlanDetail(admin, planId)).allocations.find(
      (a) => a.portfolioItemId === featureId,
    );
    expect(Number(sliced?.value)).toBe(13);
    expect(sliced?.source).toBe('manual');

    // …and emptying the cell RE-COPIES the Feature's estimate as it stands NOW — 21, not the 5 the
    // row was first created with. A re-copy is a deliberate re-baseline, not a subscription.
    await capacity.updateAllocation(admin, planId, row!.id, { value: null });
    const recopied = (await capacity.getPlanDetail(admin, planId)).allocations.find(
      (a) => a.portfolioItemId === featureId,
    );
    expect(Number(recopied?.value)).toBe(21);
    expect(recopied?.source).toBe('feature_estimate');
  });

  it('stays silent INSIDE capacity and warns only once past it — plan level included', async () => {
    /**
     * There was a `load_above_target` rule here: capacity 50 with the plan's 80% target load meant a
     * ceiling of 40, and a team at 45 was flagged. It is gone with `capacity_plans.target_load_pct` —
     * nothing in the BA's advisory set rations headroom, and every surface drew that warning with the
     * SAME red triangle as a real breach, so a team at 90% of capacity was indistinguishable from one
     * that had blown through it.
     *
     * The plan-level assertions are the other half of this change: `computeCapacityWarnings` was never
     * called over the plan's totals, so the summary strip and the Breakdown overlay showed a plan in
     * breach with no warning on it at all.
     */
    const featureId = await newFeature(`Load ${uniqueKey()}`);
    await capacity.allocate(admin, planId, {
      portfolioItemId: featureId,
      teamId: teamBId,
      value: 1,
    });
    await capacity.setTeamCapacity(admin, planId, teamBId, '50');

    // Push team B's demand to 45: above the 40 ceiling but under capacity.
    const alloc = (await capacity.getPlanDetail(admin, planId)).allocations.find(
      (a) => a.portfolioItemId === featureId && a.teamId === teamBId,
    );
    const beforeB = (await capacity.getPlanDetail(admin, planId)).teams.find(
      (t) => t.teamId === teamBId,
    );
    const bump = 45 - (beforeB?.metrics.estimated ?? 0) + Number(alloc?.value ?? 0);
    await capacity.updateAllocation(admin, planId, alloc!.id, { value: bump });

    const midPlan = await capacity.getPlanDetail(admin, planId);
    const mid = midPlan.teams.find((t) => t.teamId === teamBId);
    expect(mid?.metrics.estimated).toBe(45);
    // 45 of 50 — 90% of capacity, and nothing to say about it.
    expect(mid?.metrics.warnings).toEqual([]);

    // Now past capacity, where the one hard rule fires.
    await capacity.updateAllocation(admin, planId, alloc!.id, { value: bump + 20 });
    const overPlan = await capacity.getPlanDetail(admin, planId);
    const over = overPlan.teams.find((t) => t.teamId === teamBId);
    expect(over?.metrics.warnings).toContain('estimated_exceeds_capacity');
  });

  it('gives the PLAN its own warnings, over the summed team rows', async () => {
    /**
     * `computeCapacityWarnings` ran for allocation rows, team rows and Feature rows — never over the
     * plan's totals. `CapacityPlanResponse` had no plan-level `warnings` at all, so the header bar
     * and the Breakdown overlay showed a plan in breach with nothing on them while the rows
     * underneath flagged.
     *
     * Its OWN plan, not the shared one every other test allocates into: this asserts a BOUNDARY, and
     * a shared plan's totals move with whatever ran before it.
     *
     * A team in breach is NOT automatically a plan in breach — team B at 65 of its own 50 still fits
     * inside the shared plan's 100 across two teams — so the plan is judged against its own summed
     * ceiling rather than inheriting a row's verdict.
     */
    const releaseId = (await releases.createRelease(admin, projectId, `Rel ${uniqueKey()}`, {})).id;
    const plan = await capacity.createPlan(admin, {
      projectId,
      releaseId,
      name: 'Plan warnings',
      unit: 'points',
    });
    await capacity.addTeam(admin, plan.id, teamAId);
    await capacity.addTeam(admin, plan.id, teamBId);

    // No capacity entered anywhere: the plan cannot be measured and says so, rather than reading as
    // "all clear" — the same answer its team rows give.
    const fresh = await capacity.getPlanDetail(admin, plan.id);
    expect(fresh.warnings).toEqual(['team_missing_capacity']);

    await capacity.setTeamCapacity(admin, plan.id, teamAId, '30');
    await capacity.setTeamCapacity(admin, plan.id, teamBId, '20');

    // 50 against the plan's 50, split so NEITHER team is over its own ceiling: 30 on A, 20 on B.
    const featureA = await newFeature(`Plan warn A ${uniqueKey()}`);
    const featureB = await newFeature(`Plan warn B ${uniqueKey()}`);
    await capacity.allocate(admin, plan.id, {
      portfolioItemId: featureA,
      teamId: teamAId,
      value: 30,
    });
    await capacity.allocate(admin, plan.id, {
      portfolioItemId: featureB,
      teamId: teamBId,
      value: 20,
    });

    // Planned exactly to the line — not over it, on any row or on the plan.
    const atLine = await capacity.getPlanDetail(admin, plan.id);
    expect(atLine.warnings).toEqual([]);
    expect(atLine.teams.every((team) => team.metrics.warnings.length === 0)).toBe(true);

    // One point more, which tips both team B's own 20 and the plan's 50.
    const allocB = atLine.allocations.find((a) => a.portfolioItemId === featureB);
    await capacity.updateAllocation(admin, plan.id, allocB!.id, { value: 21 });

    const over = await capacity.getPlanDetail(admin, plan.id);
    expect(over.warnings).toContain('estimated_exceeds_capacity');
  });

  it('SETS a second allocation for the same Feature and team rather than adding to it', async () => {
    // The BA: "Re-applying allocation replaces the Feature's Team allocation rows." Adding meant
    // applying the same dialog twice doubled committed demand, and a slice could never be corrected
    // downwards through this path. Still ONE row for the pair — a second would double-count in every
    // total, which is what the length assertion guards.
    const featureId = await newFeature(`Merge ${uniqueKey()}`);
    await capacity.allocate(admin, planId, {
      portfolioItemId: featureId,
      teamId: teamAId,
      value: 6,
    });
    await capacity.allocate(admin, planId, {
      portfolioItemId: featureId,
      teamId: teamAId,
      value: 4,
    });

    const rows = (await capacity.getPlanDetail(admin, planId)).allocations.filter(
      (a) => a.portfolioItemId === featureId && a.teamId === teamAId,
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].value)).toBe(4);
  });

  it('removes a SPLIT Feature from the plan in one call, leaving no row behind', async () => {
    // Against the real database because the point is atomicity: the client used to loop a DELETE per
    // allocation, so a three-way split was three requests and a failure on the second left the Feature
    // on the plan minus the team the first had already dropped.
    const featureId = await newFeature(`Remove split ${uniqueKey()}`);
    await capacity.allocate(admin, planId, {
      portfolioItemId: featureId,
      teamId: teamAId,
      value: 4,
    });
    await capacity.allocate(admin, planId, {
      portfolioItemId: featureId,
      teamId: teamBId,
      value: 6,
    });
    await capacity.allocate(admin, planId, { portfolioItemId: featureId, teamId: null, value: 2 });

    const before = (await capacity.getPlanDetail(admin, planId)).allocations.filter(
      (a) => a.portfolioItemId === featureId,
    );
    expect(before).toHaveLength(3);

    const after = await capacity.removeItemFromPlan(admin, planId, featureId);
    expect(after.allocations.filter((a) => a.portfolioItemId === featureId)).toHaveLength(0);
    // The Feature itself survives: removal is a planning decision, not a portfolio one.
    expect(await portfolio.getItem(admin, featureId)).toMatchObject({ id: featureId });
  });

  it('reports a Feature that is not on the plan instead of succeeding silently', async () => {
    const featureId = await newFeature(`Never added ${uniqueKey()}`);
    await expect(capacity.removeItemFromPlan(admin, planId, featureId)).rejects.toMatchObject({
      code: 'CAPACITY_ALLOCATION_NOT_FOUND',
    });
  });

  it("RE-PARKS a removed team's demand as unassigned, against the real unique index", async () => {
    // AC-005: "removed Teams move their allocation rows back to Unallocated." Against the real
    // database because the rule is bounded by a constraint — `uq_capacity_allocation_unassigned`
    // permits ONE unassigned row per (plan, Feature), so re-parking cannot simply insert.
    const featureId = await newFeature(`Repark ${uniqueKey()}`);
    await capacity.allocate(admin, planId, {
      portfolioItemId: featureId,
      teamId: teamBId,
      value: 3,
    });

    const after = await capacity.removeTeam(admin, planId, teamBId);
    expect(after.teams.map((t) => t.teamId)).not.toContain(teamBId);

    const rows = (await capacity.getPlanDetail(admin, planId)).allocations.filter(
      (a) => a.portfolioItemId === featureId,
    );
    // The demand survived, with nobody holding it — which is what makes it reassignable.
    expect(rows).toHaveLength(1);
    expect(rows[0].teamId).toBeNull();
    expect(Number(rows[0].value)).toBe(3);
    expect(rows[0].isPrimary).toBe(false);

    // Put the team back for the specs that follow.
    await capacity.addTeam(admin, planId, teamBId);
  });

  it('MERGES into an existing unassigned row rather than violating the index', async () => {
    // The Feature is parked AND allocated: `Add Features` at plan level leaves an unassigned row, and
    // allocating a team afterwards consumes it — so the pair is built here deliberately, with the
    // parked row created after the team row.
    const featureId = await newFeature(`Merge park ${uniqueKey()}`);
    await capacity.allocate(admin, planId, {
      portfolioItemId: featureId,
      teamId: teamBId,
      value: 5,
    });
    await capacity.allocate(admin, planId, { portfolioItemId: featureId, teamId: null, value: 2 });

    await capacity.removeTeam(admin, planId, teamBId);

    const rows = (await capacity.getPlanDetail(admin, planId)).allocations.filter(
      (a) => a.portfolioItemId === featureId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].teamId).toBeNull();
    // 5 + 2: both rows were real demand, and a removal must not quietly drop either.
    expect(Number(rows[0].value)).toBe(7);

    await capacity.addTeam(admin, planId, teamBId);
  });

  it('MOVE keeps the numbers a planner typed, folding the lost teams into one parked row', async () => {
    /**
     * `Move To Another Plan` created the collapsed row with a hard-coded `value: null`, so every
     * figure belonging to a team the target does not hold was silently destroyed — and the parked
     * row then resolved through Refined → Preliminary, so the plan reported an estimate nobody
     * entered. `mergeParkedValue` is the helper `removeTeam` has always used for the same
     * situation; the move simply did not call it.
     *
     * Against the real database because the collapse is bounded by a constraint:
     * `uq_capacity_allocation_unassigned` permits ONE unassigned row per (plan, Feature), which is
     * why N lost teams have to become one row rather than N.
     */
    const featureId = await newFeature(`Move value ${uniqueKey()}`);
    await capacity.allocate(admin, planId, {
      portfolioItemId: featureId,
      teamId: teamAId,
      value: 8,
    });
    await capacity.allocate(admin, planId, {
      portfolioItemId: featureId,
      teamId: teamBId,
      value: 5,
    });

    // A second plan on this project holding NEITHER team, so both rows have to park.
    const target = await capacity.createPlan(admin, {
      projectId,
      releaseId: otherReleaseId,
      name: `Move target ${uniqueKey()}`,
      unit: 'points',
    });

    const result = await capacity.moveItemToPlan(admin, planId, {
      portfolioItemId: featureId,
      targetPlanId: target.id,
      updateRelease: true,
      republish: false,
    });
    expect(result.carried).toBe(0);
    expect(result.parked).toBe(1);

    const moved = (await capacity.getPlanDetail(admin, target.id)).allocations.filter(
      (a) => a.portfolioItemId === featureId,
    );
    expect(moved).toHaveLength(1);
    expect(moved[0].teamId).toBeNull();
    // 8 + 5. Not null, and not 13 by coincidence — the sum of exactly what the two rows stated.
    expect(Number(moved[0].value)).toBe(13);

    // And gone from the source: a move relocates, it does not copy.
    const left = (await capacity.getPlanDetail(admin, planId)).allocations.filter(
      (a) => a.portfolioItemId === featureId,
    );
    expect(left).toHaveLength(0);
  });

  it('refuses to allocate an Epic', async () => {
    const epic = await portfolio.createItem(admin, {
      projectId,
      type: 'epic',
      name: `Epic ${uniqueKey()}`,
    });
    await expect(
      capacity.allocate(admin, planId, { portfolioItemId: epic.id, teamId: teamAId }),
    ).rejects.toMatchObject({ code: 'CAPACITY_ALLOCATION_NOT_FEATURE' });
  });

  it('rejects a NEGATIVE allocation at the database level', async () => {
    const featureId = await newFeature(`Negative ${uniqueKey()}`);
    await capacity.allocate(admin, planId, {
      portfolioItemId: featureId,
      teamId: teamAId,
      value: 1,
    });
    const alloc = (await capacity.getPlanDetail(admin, planId)).allocations.find(
      (a) => a.portfolioItemId === featureId,
    );

    const { capacityPlanAllocations } = await import('@db/schema/work');
    const direct = db
      .update(capacityPlanAllocations)
      .set({ value: '-1' })
      .where(eq(capacityPlanAllocations.id, alloc!.id));

    await expect(direct).rejects.toThrow();
    const err = await direct.catch((e: unknown) => e);
    expect(JSON.stringify((err as { cause?: unknown }).cause ?? err)).toContain(
      'ck_capacity_allocation_non_negative',
    );
  });

  it('refuses an allocation id from another plan', async () => {
    await expect(
      capacity.updateAllocation(admin, planId, randomUUID(), { value: 1 }),
    ).rejects.toMatchObject({ code: 'CAPACITY_ALLOCATION_NOT_FOUND' });
  });
});
