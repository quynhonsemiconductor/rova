/**
 * Rally's primary team assignment — real SQL.
 *
 * Rally: "you can assign the portfolio item to one primary team and then allocate points or story
 * counts to the additional teams that will contribute to the work" (Broadcom TechDocs). One team
 * owns the Feature; the rest contribute. The Items tab's "Planned Team Assignment" column shows
 * that team, which is why it is recorded rather than inferred.
 *
 * Real SQL because the guarantees here are schema-level and a mock cannot hold them:
 *   • `uq_capacity_allocation_primary` — one primary per (plan, Feature), which only a partial
 *     unique index can enforce under a race;
 *   • `ck_capacity_primary_has_team` — an Unallocated row can never own the work;
 *   • the promotion rules survive a real delete, not just a stubbed call.
 *
 * Prereqs: docker deps up + `pnpm db:migrate` (see flow-harness).
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { CapacityPlansService } from '@modules/capacity';
import { PortfolioItemsService } from '@modules/portfolio';
import { ProjectsService } from '@modules/projects';
import { ReleasesService } from '@modules/releases';
import { DRIZZLE } from '@platform';
import type { DrizzleDB } from '@platform';
import { capacityPlanAllocations, teams } from '@db/schema/work';

import { WORKSPACE_ID, adminActor, bootRovaApp, uniqueKey } from './support/flow-harness';

describe('capacity primary team (e2e)', () => {
  let app: NestFastifyApplication;
  let capacity: CapacityPlansService;
  let portfolio: PortfolioItemsService;
  let projects: ProjectsService;
  let releases: ReleasesService;
  let db: DrizzleDB;

  const admin = adminActor();
  let projectId: string;
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

  async function newPlanWithTeams() {
    const release = await releases.createRelease(admin, projectId, `Rel ${uniqueKey()}`, {});
    const plan = await capacity.createPlan(admin, {
      projectId,
      releaseId: release.id,
      name: `Plan ${uniqueKey()}`,
      unit: 'points',
    });
    await capacity.addTeam(admin, plan.id, teamAId);
    await capacity.addTeam(admin, plan.id, teamBId);
    return plan.id;
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

  /** Straight from the table: which allocations carry the flag. */
  async function primaries(planId: string, portfolioItemId: string) {
    return db
      .select({ id: capacityPlanAllocations.id, teamId: capacityPlanAllocations.teamId })
      .from(capacityPlanAllocations)
      .where(
        and(
          eq(capacityPlanAllocations.planId, planId),
          eq(capacityPlanAllocations.portfolioItemId, portfolioItemId),
          eq(capacityPlanAllocations.isPrimary, true),
        ),
      );
  }

  /**
   * The Postgres constraint a write violated.
   *
   * Drizzle wraps driver errors as "Failed query: …", so the constraint name is only on the
   * CAUSE — asserting on the message would pass for any failing query at all.
   */
  async function violatedConstraint(write: Promise<unknown>): Promise<string | undefined> {
    try {
      await write;
      return undefined;
    } catch (error) {
      const cause = (error as { cause?: { constraint?: string } }).cause;
      return cause?.constraint;
    }
  }

  beforeAll(async () => {
    app = await bootRovaApp();
    capacity = app.get(CapacityPlansService);
    portfolio = app.get(PortfolioItemsService);
    projects = app.get(ProjectsService);
    releases = app.get(ReleasesService);
    db = app.get<DrizzleDB>(DRIZZLE);

    const project = await projects.createProject(admin, {
      key: uniqueKey(),
      name: 'Primary Project',
    });
    projectId = project.id;
    teamAId = await newTeam('Primary A');
    teamBId = await newTeam('Primary B');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('assigns the FIRST team and leaves the second as a contributor', async () => {
    const planId = await newPlanWithTeams();
    const feature = await newFeature();

    await capacity.allocate(admin, planId, { portfolioItemId: feature, teamId: teamAId, value: 5 });
    await capacity.allocate(admin, planId, { portfolioItemId: feature, teamId: teamBId, value: 3 });

    const rows = await primaries(planId, feature);
    expect(rows).toHaveLength(1);
    expect(rows[0].teamId).toBe(teamAId);
  });

  it('never marks an Unallocated row as primary', async () => {
    const planId = await newPlanWithTeams();
    const feature = await newFeature();

    await capacity.allocate(admin, planId, { portfolioItemId: feature, teamId: null, value: 5 });

    expect(await primaries(planId, feature)).toHaveLength(0);
  });

  it('moves the assignment, leaving exactly one primary', async () => {
    const planId = await newPlanWithTeams();
    const feature = await newFeature();
    await capacity.allocate(admin, planId, { portfolioItemId: feature, teamId: teamAId, value: 5 });
    await capacity.allocate(admin, planId, { portfolioItemId: feature, teamId: teamBId, value: 3 });

    const detail = await capacity.getPlanDetail(admin, planId);
    const teamB = detail.allocations.find((a) => a.teamId === teamBId);
    await capacity.setPrimaryAllocation(admin, planId, teamB!.id);

    const rows = await primaries(planId, feature);
    expect(rows).toHaveLength(1);
    expect(rows[0].teamId).toBe(teamBId);
  });

  it('refuses to make an Unallocated row the primary', async () => {
    const planId = await newPlanWithTeams();
    const feature = await newFeature();
    await capacity.allocate(admin, planId, { portfolioItemId: feature, teamId: null, value: 5 });

    const detail = await capacity.getPlanDetail(admin, planId);
    const parked = detail.allocations.find((a) => a.teamId === null);
    await expect(capacity.setPrimaryAllocation(admin, planId, parked!.id)).rejects.toMatchObject({
      code: 'CAPACITY_PRIMARY_NEEDS_TEAM',
    });
  });

  it('the DATABASE refuses a second primary, not just the service', async () => {
    // The partial unique index is the real guarantee: two concurrent "make this primary" calls
    // would otherwise both succeed and leave the Feature with two owners.
    const planId = await newPlanWithTeams();
    const feature = await newFeature();
    await capacity.allocate(admin, planId, { portfolioItemId: feature, teamId: teamAId, value: 5 });
    await capacity.allocate(admin, planId, { portfolioItemId: feature, teamId: teamBId, value: 3 });

    const detail = await capacity.getPlanDetail(admin, planId);
    const contributor = detail.allocations.find((a) => a.teamId === teamBId);
    expect(
      await violatedConstraint(
        db
          .update(capacityPlanAllocations)
          .set({ isPrimary: true })
          .where(eq(capacityPlanAllocations.id, contributor!.id)),
      ),
    ).toBe('uq_capacity_allocation_primary');
  });

  it('the DATABASE refuses a primary with no team', async () => {
    const planId = await newPlanWithTeams();
    const feature = await newFeature();
    await capacity.allocate(admin, planId, { portfolioItemId: feature, teamId: null, value: 5 });

    const detail = await capacity.getPlanDetail(admin, planId);
    const parked = detail.allocations.find((a) => a.teamId === null);
    expect(
      await violatedConstraint(
        db
          .update(capacityPlanAllocations)
          .set({ isPrimary: true })
          .where(eq(capacityPlanAllocations.id, parked!.id)),
      ),
    ).toBe('ck_capacity_primary_has_team');
  });

  it('PROMOTES the next team when the primary allocation is removed', async () => {
    // A Feature with allocations but no primary would read as unassigned while teams are visibly
    // holding work on it.
    const planId = await newPlanWithTeams();
    const feature = await newFeature();
    await capacity.allocate(admin, planId, { portfolioItemId: feature, teamId: teamAId, value: 5 });
    await capacity.allocate(admin, planId, { portfolioItemId: feature, teamId: teamBId, value: 3 });

    const detail = await capacity.getPlanDetail(admin, planId);
    const teamA = detail.allocations.find((a) => a.teamId === teamAId);
    await capacity.removeAllocation(admin, planId, teamA!.id);

    const rows = await primaries(planId, feature);
    expect(rows).toHaveLength(1);
    expect(rows[0].teamId).toBe(teamBId);
  });

  it('hands the assignment on when the primary is parked as unallocated', async () => {
    const planId = await newPlanWithTeams();
    const feature = await newFeature();
    await capacity.allocate(admin, planId, { portfolioItemId: feature, teamId: teamAId, value: 5 });
    await capacity.allocate(admin, planId, { portfolioItemId: feature, teamId: teamBId, value: 3 });

    const detail = await capacity.getPlanDetail(admin, planId);
    const teamA = detail.allocations.find((a) => a.teamId === teamAId);
    await capacity.updateAllocation(admin, planId, teamA!.id, { teamId: null });

    const rows = await primaries(planId, feature);
    expect(rows).toHaveLength(1);
    expect(rows[0].teamId).toBe(teamBId);
  });

  it('leaves no primary behind when the LAST team allocation goes', async () => {
    // Nothing to promote — and an Unallocated leftover must not inherit ownership.
    const planId = await newPlanWithTeams();
    const feature = await newFeature();
    await capacity.allocate(admin, planId, { portfolioItemId: feature, teamId: teamAId, value: 5 });
    await capacity.allocate(admin, planId, { portfolioItemId: feature, teamId: null, value: 2 });

    const detail = await capacity.getPlanDetail(admin, planId);
    const teamA = detail.allocations.find((a) => a.teamId === teamAId);
    await capacity.removeAllocation(admin, planId, teamA!.id);

    expect(await primaries(planId, feature)).toHaveLength(0);
  });
});
