/**
 * The Items tab and Rally's cutline — real SQL.
 *
 * Rally: "Items above the cutline fit within the defined plan capacity… The cutline only
 * displays when you sort portfolio items by rank in ascending order" (Broadcom TechDocs,
 * Capacity Plan Items Tab). So the line is PLAN-wide, over one row per Feature, in rank order.
 *
 * Real SQL because two of the three inputs come from the database and cannot be faked
 * convincingly: the Feature's LexoRank (which decides the order the line accumulates down) and
 * `itemRollup` — the Feature's OWN child totals across every team, which is a different query
 * from the per-team slice the team rows use.
 *
 * Prereqs: docker deps up + `pnpm db:migrate` (see flow-harness).
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { CapacityPlansService } from '@modules/capacity';
import { PortfolioItemsService } from '@modules/portfolio';
import { ProjectsService } from '@modules/projects';
import { ReleasesService } from '@modules/releases';
import { WorkItemsService } from '@modules/work-items';
import { DRIZZLE } from '@platform';
import type { DrizzleDB } from '@platform';
import { teams, workflowStatuses } from '@db/schema/work';

import { WORKSPACE_ID, adminActor, bootRovaApp, uniqueKey } from './support/flow-harness';

describe('capacity items + cutline (e2e)', () => {
  let app: NestFastifyApplication;
  let capacity: CapacityPlansService;
  let portfolio: PortfolioItemsService;
  let projects: ProjectsService;
  let releases: ReleasesService;
  let workItems: WorkItemsService;
  let db: DrizzleDB;

  const admin = adminActor();
  let projectId: string;
  let statusId: string;
  let teamAId: string;
  let teamBId: string;

  async function newTeam(label: string): Promise<string> {
    const [row] = await db
      .insert(teams)
      .values({
        workspaceId: WORKSPACE_ID,
        name: `${label} ${uniqueKey()}`,
        key: uniqueKey('T'),
        status: 'active',
      })
      .returning({ id: teams.id });
    await projects.linkTeam(WORKSPACE_ID, projectId, row.id);
    return row.id;
  }

  /** A plan on its own release — a release holds only one plan. */
  async function newPlan() {
    const release = await releases.createRelease(admin, projectId, `Rel ${uniqueKey()}`, {});
    const plan = await capacity.createPlan(admin, {
      projectId,
      releaseId: release.id,
      name: `Plan ${uniqueKey()}`,
      unit: 'points',
    });
    return { planId: plan.id, releaseId: release.id };
  }

  async function newFeature(): Promise<string> {
    const item = await portfolio.createItem(admin, {
      projectId,
      type: 'feature',
      name: `FE ${uniqueKey()}`,
      preliminaryEstimate: 'm',
    });
    return item.id;
  }

  beforeAll(async () => {
    app = await bootRovaApp();
    capacity = app.get(CapacityPlansService);
    portfolio = app.get(PortfolioItemsService);
    projects = app.get(ProjectsService);
    releases = app.get(ReleasesService);
    workItems = app.get(WorkItemsService);
    db = app.get<DrizzleDB>(DRIZZLE);

    const project = await projects.createProject(admin, {
      key: uniqueKey(),
      name: 'Items Project',
    });
    projectId = project.id;
    const rows = await db
      .select({ id: workflowStatuses.id })
      .from(workflowStatuses)
      .where(eq(workflowStatuses.projectId, projectId))
      .limit(1);
    statusId = rows[0].id;
    teamAId = await newTeam('Items A');
    teamBId = await newTeam('Items B');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('lists one row per Feature, in the rank order the database assigned', async () => {
    const { planId } = await newPlan();
    await capacity.addTeam(admin, planId, teamAId);
    // Created in order, so rank ascends with creation — the order the cutline walks.
    const first = await newFeature();
    const second = await newFeature();
    await capacity.allocate(admin, planId, { portfolioItemId: second, teamId: teamAId, value: 5 });
    await capacity.allocate(admin, planId, { portfolioItemId: first, teamId: teamAId, value: 5 });

    const detail = await capacity.getPlanDetail(admin, planId);
    expect(detail.items).toHaveLength(2);
    expect(detail.items[0].portfolioItemId).toBe(first);
    expect(detail.items[1].portfolioItemId).toBe(second);
  });

  it('collapses a Feature shared by two teams into ONE item, summing its allocations', async () => {
    const { planId } = await newPlan();
    await capacity.addTeam(admin, planId, teamAId);
    await capacity.addTeam(admin, planId, teamBId);
    const shared = await newFeature();
    await capacity.allocate(admin, planId, { portfolioItemId: shared, teamId: teamAId, value: 8 });
    await capacity.allocate(admin, planId, { portfolioItemId: shared, teamId: teamBId, value: 4 });

    const detail = await capacity.getPlanDetail(admin, planId);
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0].estimated).toBe(12);
    expect(detail.items[0].teamIds).toHaveLength(2);
    // Both allocations are still listed individually for the per-team view.
    expect(detail.allocations).toHaveLength(2);
  });

  it("reports the Feature's OWN rollup, and the team slices sum to it", async () => {
    /**
     * `itemRollup` is a separate query so the Features tab reports the Feature once rather than once
     * per team. What it must NOT be is a different POPULATION from the slices: a child belonging to a
     * team that is not on the plan used to count toward the Feature and toward no team at all, so the
     * plan header (the sum of the team rows) disagreed with the Features tab beside it — `P5-CP-029`'s
     * "Team slices must be consistent with the Feature/Plan totals". Such a child now falls to the
     * Feature's owner on the plan, which is the only team that has agreed to do the work.
     */
    const { planId, releaseId } = await newPlan();
    await capacity.addTeam(admin, planId, teamAId);
    const feature = await newFeature();
    await capacity.allocate(admin, planId, {
      portfolioItemId: feature,
      teamId: teamAId,
      value: 10,
    });

    for (const [team, points] of [
      [teamAId, '3'],
      [teamBId, '7'],
    ] as const) {
      const story = await workItems.createWorkItem(admin, projectId, 'story', `S ${uniqueKey()}`, {
        statusId,
        storyPoints: points,
      });
      // `featureId` goes through the service now — it used to need a direct UPDATE because no
      // API could set it.
      await workItems.updateWorkItem(admin, story.id, {
        releaseId,
        teamId: team,
        featureId: feature,
      });
    }

    const detail = await capacity.getPlanDetail(admin, planId);
    // 3 + 7 across both teams, even though only team A is on the plan.
    expect(detail.items[0].rollup).toBe(10);
    // And team A's row carries all 10: it owns the Feature here, and team B holds no allocation of it,
    // so the 7 has exactly one slice it can belong to. Previously this read 3 and the plan header
    // reported 3 against a Features tab reading 10.
    expect(detail.teams[0].metrics.rollup).toBe(10);
  });

  it('draws the cutline against the PLAN total, not one team', async () => {
    // Two teams of 10 each: 20 total. Three 8-point Features — 8 and 16 fit, 24 does not, so the line
    // falls after the second ("items above the cutline fit within the defined plan capacity"). Per
    // team, none of the three would fit, which is the answer Rally does NOT give here.
    const { planId } = await newPlan();
    await capacity.addTeam(admin, planId, teamAId);
    await capacity.addTeam(admin, planId, teamBId);
    await capacity.setTeamCapacity(admin, planId, teamAId, '10');
    await capacity.setTeamCapacity(admin, planId, teamBId, '10');

    for (let i = 0; i < 3; i += 1) {
      const feature = await newFeature();
      await capacity.allocate(admin, planId, {
        portfolioItemId: feature,
        teamId: teamAId,
        value: 8,
      });
    }

    const detail = await capacity.getPlanDetail(admin, planId);
    expect(detail.items).toHaveLength(3);
    expect(detail.itemCutlineIndex).toBe(1);
  });

  it('has no cutline until some capacity is entered', async () => {
    const { planId } = await newPlan();
    await capacity.addTeam(admin, planId, teamAId);
    const feature = await newFeature();
    await capacity.allocate(admin, planId, { portfolioItemId: feature, teamId: teamAId, value: 5 });

    expect((await capacity.getPlanDetail(admin, planId)).itemCutlineIndex).toBeNull();
  });

  it('flags an item parked in the Unallocated bucket', async () => {
    const { planId } = await newPlan();
    await capacity.addTeam(admin, planId, teamAId);
    const feature = await newFeature();
    await capacity.allocate(admin, planId, { portfolioItemId: feature, teamId: null, value: 5 });

    const detail = await capacity.getPlanDetail(admin, planId);
    expect(detail.items[0].unallocated).toBe(true);
    expect(detail.items[0].teamIds).toEqual([]);
  });

  it('no longer reports a per-team cutline — Rally has none', async () => {
    // The correction this slice carries: the line belongs to the plan and its item list.
    const { planId } = await newPlan();
    await capacity.addTeam(admin, planId, teamAId);
    const detail = await capacity.getPlanDetail(admin, planId);
    expect(detail.teams[0]).not.toHaveProperty('cutlineIndex');
  });
});
