/**
 * Capacity plan E2E — plan CRUD and team membership.
 *
 * Real SQL because the guarantees that matter here are schema-level:
 *
 *   • `uq_capacity_plan_project_release` — one plan per release, which only a real index
 *     can enforce under a race; the service pre-check just makes the error friendly;
 *   • `ck_capacity_non_negative` actually rejects the values the DTO claims it does, so the
 *     DTO bounds are a convenience rather than the only defence;
 *   • `capacity` distinguishes NULL ("not entered") from 0, which is the rule the whole
 *     summary and every later warning depends on.
 *
 * Prereqs: docker deps up + `pnpm db:migrate` (see flow-harness).
 */
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { CapacityPlansService } from '@modules/capacity';
import { ProjectsService } from '@modules/projects';
import { ReleasesService } from '@modules/releases';
import { DRIZZLE } from '@platform';
import type { DrizzleDB } from '@platform';
import { capacityPlanTeams, capacityPlans, projectTeams, teams } from '@db/schema/work';

// `users`, `workspaceMembers`, `VIEWER_ID`, `viewerActor` and `AccessService` were imported for the
// custom-role fixtures this spec used to build (a "read-only planner" holding `capacity:view` without
// `capacity:manage`). Those are gone with the ruling; the Editor half of AC-010/AC-013 is asserted in
// `test/capacity-access-gate.spec.ts`, which reads the route decorators the guard reads.
import {
  WORKSPACE_ID,
  adminActor,
  bootRovaApp,
  makeActor,
  uniqueKey,
} from './support/flow-harness';

describe('capacity plans (e2e)', () => {
  let app: NestFastifyApplication;
  let capacity: CapacityPlansService;
  let projects: ProjectsService;
  let releases: ReleasesService;
  let db: DrizzleDB;

  const admin = adminActor();
  let projectAId: string;
  let projectBId: string;
  let teamId: string;

  /** A release in project A, fresh per call — a release may hold only one plan. */
  async function newRelease(projectId = projectAId): Promise<string> {
    const r = await releases.createRelease(admin, projectId, `Rel ${uniqueKey()}`, {});
    return r.id;
  }

  beforeAll(async () => {
    app = await bootRovaApp();
    capacity = app.get(CapacityPlansService);
    projects = app.get(ProjectsService);
    releases = app.get(ReleasesService);
    db = app.get<DrizzleDB>(DRIZZLE);

    const a = await projects.createProject(admin, { key: uniqueKey(), name: 'Capacity A' });
    const b = await projects.createProject(admin, { key: uniqueKey(), name: 'Capacity B' });
    projectAId = a.id;
    projectBId = b.id;

    teamId = await newTeamInProject(projectAId);
  });

  /**
   * A team LINKED to a project, which is what `addTeam` now requires.
   *
   * A plan's team has to be one of the project's own — the BA's "Project Breakdown" — and the guard
   * checks `project_teams`, not merely the workspace. A fixture that skipped the link was creating the
   * very state an audit found 11 of in the live database: a team contributing demand to a plan while
   * being absent from the project's team picker, so it could not be removed through the UI at all.
   */
  async function newTeamInProject(projectId: string): Promise<string> {
    const [team] = await db
      .insert(teams)
      .values({
        workspaceId: WORKSPACE_ID,
        name: `Cap Team ${uniqueKey()}`,
        key: uniqueKey('T'),
        status: 'active',
      })
      .returning({ id: teams.id });
    await db.insert(projectTeams).values({ workspaceId: WORKSPACE_ID, projectId, teamId: team.id });
    return team.id;
  }

  afterAll(async () => {
    await app?.close();
  });

  describe('create', () => {
    it('creates a draft plan and returns it with names resolved', async () => {
      const releaseId = await newRelease();
      const created = await capacity.createPlan(admin, {
        projectId: projectAId,
        releaseId,
        name: 'Q3 capacity',
        unit: 'points',
      });

      expect(created.status).toBe('draft');
      expect(created.unit).toBe('points');
      expect(created.projectName).toBe('Capacity A');
      expect(created.releaseName).toBeTruthy();
      // No team yet, so no capacity has been entered — null, NOT zero.
      expect(created.teams).toEqual([]);
      expect(created.totalCapacity).toBeNull();
    });

    it('refuses a SECOND plan for the same release — and the index agrees', async () => {
      const releaseId = await newRelease();
      await capacity.createPlan(admin, {
        projectId: projectAId,
        releaseId,
        name: 'First',
        unit: 'points',
      });

      await expect(
        capacity.createPlan(admin, {
          projectId: projectAId,
          releaseId,
          name: 'Second',
          unit: 'count',
        }),
      ).rejects.toMatchObject({ code: 'CAPACITY_PLAN_EXISTS' });

      // Prove the constraint is real rather than trusting the service's pre-check: bypass
      // the service entirely. Drizzle wraps the pg error, so the constraint name is on the
      // cause rather than the top-level message.
      const direct = db.insert(capacityPlans).values({
        workspaceId: WORKSPACE_ID,
        projectId: projectAId,
        releaseId,
        name: 'Direct duplicate',
        // `plan_key` is NOT NULL since 0085 — the service mints `CP-<n>`, and a direct insert that
        // bypasses it has to say one. Uniqueness is (project_id, plan_key), so a distinct key here
        // proves the (project, release) index is what rejects the row.
        planKey: 'CP-DUP',
        unit: 'points',
      });
      await expect(direct).rejects.toThrow();
      const err = await direct.catch((e: unknown) => e);
      expect(JSON.stringify((err as { cause?: unknown }).cause ?? err)).toContain(
        'uq_capacity_plan_project_release',
      );
    });

    it('refuses a release belonging to a DIFFERENT project', async () => {
      const releaseInB = await newRelease(projectBId);
      await expect(
        capacity.createPlan(admin, {
          projectId: projectAId,
          releaseId: releaseInB,
          name: 'Cross project',
          unit: 'points',
        }),
      ).rejects.toMatchObject({ code: 'CAPACITY_PLAN_RELEASE_MISMATCH' });
    });

    it('refuses a caller without capacity:manage on the project', async () => {
      const releaseId = await newRelease();
      const stranger = makeActor(randomUUID(), []);
      await expect(
        capacity.createPlan(stranger, {
          projectId: projectAId,
          releaseId,
          name: 'Should not exist',
          unit: 'points',
        }),
      ).rejects.toMatchObject({ code: 'PROJECT_PERMISSION_DENIED' });
    });
  });

  describe('teams and capacity', () => {
    async function planWithTeam() {
      const releaseId = await newRelease();
      const p = await capacity.createPlan(admin, {
        projectId: projectAId,
        releaseId,
        name: `Plan ${uniqueKey()}`,
        unit: 'points',
      });
      return capacity.addTeam(admin, p.id, teamId);
    }

    it('adds a team with capacity NULL — joining is not a capacity of zero', async () => {
      const withTeam = await planWithTeam();
      expect(withTeam.teams).toHaveLength(1);
      expect(withTeam.teams[0].capacity).toBeNull();
      expect(withTeam.teams[0].teamName).toBeTruthy();
      // The summary must stay null too, or an untouched plan reads as fully committed.
      expect(withTeam.totalCapacity).toBeNull();
    });

    it('sets a capacity, then CLEARS it back to null rather than to zero', async () => {
      const p = await planWithTeam();

      const set = await capacity.setTeamCapacity(admin, p.id, teamId, '40');
      expect(Number(set.teams[0].capacity)).toBe(40);
      expect(Number(set.totalCapacity)).toBe(40);

      const cleared = await capacity.setTeamCapacity(admin, p.id, teamId, null);
      expect(cleared.teams[0].capacity).toBeNull();
      expect(cleared.totalCapacity).toBeNull();

      // Distinguishable in the column itself, not just in the mapping layer.
      const rows = await db
        .select({ capacity: capacityPlanTeams.capacity })
        .from(capacityPlanTeams)
        .where(and(eq(capacityPlanTeams.planId, p.id), eq(capacityPlanTeams.teamId, teamId)));
      expect(rows[0].capacity).toBeNull();
    });

    it('keeps ZERO distinct from null', async () => {
      const p = await planWithTeam();
      const zero = await capacity.setTeamCapacity(admin, p.id, teamId, '0');
      // A real, entered ceiling of zero: the total is 0, not null.
      expect(Number(zero.teams[0].capacity)).toBe(0);
      expect(Number(zero.totalCapacity)).toBe(0);
    });

    it('rejects a NEGATIVE capacity at the database level', async () => {
      const p = await planWithTeam();
      const direct = db
        .update(capacityPlanTeams)
        .set({ capacity: '-5' })
        .where(and(eq(capacityPlanTeams.planId, p.id), eq(capacityPlanTeams.teamId, teamId)));
      await expect(direct).rejects.toThrow();
      const err = await direct.catch((e: unknown) => e);
      expect(JSON.stringify((err as { cause?: unknown }).cause ?? err)).toContain(
        'ck_capacity_non_negative',
      );
    });

    it('refuses the same team twice', async () => {
      const p = await planWithTeam();
      await expect(capacity.addTeam(admin, p.id, teamId)).rejects.toMatchObject({
        code: 'CAPACITY_TEAM_ALREADY_ADDED',
      });
    });

    it('refuses a team from outside the workspace', async () => {
      const releaseId = await newRelease();
      const p = await capacity.createPlan(admin, {
        projectId: projectAId,
        releaseId,
        name: `Plan ${uniqueKey()}`,
        unit: 'points',
      });
      await expect(capacity.addTeam(admin, p.id, randomUUID())).rejects.toMatchObject({
        code: 'CAPACITY_TEAM_NOT_FOUND',
      });
    });

    it('removes a team and drops it from the totals', async () => {
      const p = await planWithTeam();
      await capacity.setTeamCapacity(admin, p.id, teamId, '25');
      const after = await capacity.removeTeam(admin, p.id, teamId);
      expect(after.teams).toEqual([]);
      expect(after.totalCapacity).toBeNull();
    });

    it('sums only the capacities that were entered', async () => {
      // Two teams, one with a capacity and one without: the total is the entered one, not
      // a sum that silently treats the blank as zero.
      const p = await planWithTeam();
      const secondId = await newTeamInProject(projectAId);

      await capacity.addTeam(admin, p.id, secondId);
      const set = await capacity.setTeamCapacity(admin, p.id, teamId, '30');

      expect(set.teams).toHaveLength(2);
      expect(Number(set.totalCapacity)).toBe(30);
    });
  });

  describe('published plans are read-only', () => {
    /**
     * Publish arrives in a later slice, so nothing in the app can reach this state yet.
     * Inserted directly precisely so the guard is proven now rather than discovered to be
     * missing once publish exists.
     */
    async function publishedPlan() {
      const releaseId = await newRelease();
      const [row] = await db
        .insert(capacityPlans)
        .values({
          workspaceId: WORKSPACE_ID,
          projectId: projectAId,
          releaseId,
          name: 'Already published',
          planKey: `CP-PUB-${randomUUID().slice(0, 8)}`,
          unit: 'points',
          status: 'published',
          publishedAt: new Date(),
        })
        .returning({ id: capacityPlans.id });
      return row.id;
    }

    it('refuses an update', async () => {
      const id = await publishedPlan();
      await expect(capacity.updatePlan(admin, id, { name: 'nope' })).rejects.toMatchObject({
        code: 'CAPACITY_PLAN_NOT_DRAFT',
      });
    });

    it('refuses adding a team', async () => {
      const id = await publishedPlan();
      await expect(capacity.addTeam(admin, id, teamId)).rejects.toMatchObject({
        code: 'CAPACITY_PLAN_NOT_DRAFT',
      });
    });

    it('still allows READING it', async () => {
      const id = await publishedPlan();
      const plan = await capacity.getPlan(admin, id);
      expect(plan.status).toBe('published');
      expect(plan.publishedAt).not.toBeNull();
    });
  });

  describe('list and update', () => {
    it('lists only the requested project’s plans', async () => {
      const releaseId = await newRelease();
      const mine = await capacity.createPlan(admin, {
        projectId: projectAId,
        releaseId,
        name: `Listed ${uniqueKey()}`,
        unit: 'points',
      });

      const releaseInB = await newRelease(projectBId);
      const other = await capacity.createPlan(admin, {
        projectId: projectBId,
        releaseId: releaseInB,
        name: `Other ${uniqueKey()}`,
        unit: 'points',
      });

      const listed = await capacity.listPlans(admin, projectAId);
      const ids = listed.map((p) => p.id);
      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(other.id);
    });

    it('updates the editable fields and leaves the rest alone', async () => {
      const releaseId = await newRelease();
      const p = await capacity.createPlan(admin, {
        projectId: projectAId,
        releaseId,
        name: 'Before',
        unit: 'points',
      });

      const updated = await capacity.updatePlan(admin, p.id, {
        name: 'After',
        plannedStartDate: '2026-08-01',
      });

      expect(updated.name).toBe('After');
      expect(updated.plannedStartDate).toBe('2026-08-01');
      // Untouched by an update that never mentioned them.
      expect(updated.unit).toBe('points');
      expect(updated.releaseId).toBe(releaseId);
      expect(updated.plannedEndDate).toBeNull();
    });
  });
  /**
   * Capacity access, as the BA actually specifies it.
   *
   * This block used to build a "read-only planner" from a CUSTOM ROLE holding
   * `project:view` + `capacity:view` (+ `capacity:view_draft`) and assert it could open Drafts but not
   * change them. That principal does not exist in the specified model, and the SRS is explicit on
   * origin/main:
   *
   *   • `P5-CAP-AC-010` — "Workspace Admin manages all Projects; Admin manages assigned Projects;
   *     Editor/No Access do NOT access Capacity Planning."
   *   • `P5-CAP-AC-013` — N/A, "Viewer level removed; access model is now 3-level … Capacity Planning
   *     is hidden from Editor and No Access."
   *   • `P5-CAP-AC-012` — Capacity Planning "uses the fixed Phase 4 Project Access baseline and has NO
   *     temporary editable Full/View permission row."
   *
   * So there is no read-only capacity tier to test, and the old fixture was pinning a shape the BA
   * removed along with `Viewer`. It also depended on custom roles, which AC-11 forbids and which are
   * now deleted — that dependency was the last one in this suite.
   *
   * What remains worth asserting is the real boundary: an Editor is refused outright, and an Admin
   * manages. `capacity:view_draft` consequently has no holder that lacks `capacity:manage`, which makes
   * it redundant — flagged for removal rather than removed here, because a permission code in live role
   * arrays needs a migration, not a catalogue edit.
   */
  describe('capacity access is Admin/WA only (P5-CAP-AC-010/012/013)', () => {
    // The Editor half of AC-010/AC-013 is NOT asserted here, on purpose.
    //
    // "Editor/No Access do not access Capacity Planning" is a ROUTE gate — `@RequirePermission`
    // ('capacity:view' / 'capacity:manage') on `CapacityPlansController`. This spec calls the SERVICE,
    // and `listPlans` deliberately FILTERS rather than refusing (it is what hides Drafts), so an Editor
    // reaching it directly gets rows back and a refusal assertion here fails for the right reason:
    // CLAUDE.md records twice that a spec calling a service directly cannot see a guard defect. I wrote
    // that assertion first and it failed exactly that way.
    //
    // `test/capacity-access-gate.spec.ts` reads the decorator metadata the guard itself reads and
    // applies the catalogue's Editor/Admin permission sets to it, which is the assertion that can.

    it('shows both DRAFT and PUBLISHED plans to the managing Admin', async () => {
      const releaseId = await newRelease();
      const draft = await capacity.createPlan(admin, {
        projectId: projectAId,
        releaseId,
        name: `Visible to admin ${uniqueKey()}`,
        unit: 'points',
      });

      const withDraft = await capacity.listPlans(admin, projectAId);
      expect(withDraft.map((pl) => pl.id)).toContain(draft.id);
      await expect(capacity.getPlan(admin, draft.id)).resolves.toMatchObject({ status: 'draft' });

      await capacity.addTeam(admin, draft.id, teamId);
      await capacity.publishPlan(admin, draft.id, { updateFields: false });
      await expect(capacity.getPlan(admin, draft.id)).resolves.toMatchObject({
        status: 'published',
      });
    });
  });

  describe('plan key + delete — real index, real cascade', () => {
    it('mints CP-<n> per PROJECT, so two projects both start at CP-1', async () => {
      // `uq_capacity_plans_key` is on (project_id, plan_key): a per-project counter is the
      // point, and a workspace-wide one would make the numbers jump for no visible reason.
      const inA = await capacity.createPlan(admin, {
        projectId: projectAId,
        releaseId: await newRelease(projectAId),
        name: `Key A ${uniqueKey()}`,
        unit: 'points',
      });
      const inB = await capacity.createPlan(admin, {
        projectId: projectBId,
        releaseId: await newRelease(projectBId),
        name: `Key B ${uniqueKey()}`,
        unit: 'points',
      });

      expect(inA.planKey).toMatch(/^CP-\d+$/);
      expect(inB.planKey).toMatch(/^CP-\d+$/);

      // The NEXT plan in project A takes the number after A's, not after B's.
      const secondA = await capacity.createPlan(admin, {
        projectId: projectAId,
        releaseId: await newRelease(projectAId),
        name: `Key A2 ${uniqueKey()}`,
        unit: 'points',
      });
      const n = (key: string | null) => Number(key?.split('-')[1]);
      expect(n(secondA.planKey)).toBe(n(inA.planKey) + 1);
    });

    it('deletes a draft and CASCADES its teams', async () => {
      const p = await capacity.createPlan(admin, {
        projectId: projectAId,
        releaseId: await newRelease(projectAId),
        name: `Doomed ${uniqueKey()}`,
        unit: 'points',
      });
      await capacity.addTeam(admin, p.id, teamId);
      expect(
        await db.select().from(capacityPlanTeams).where(eq(capacityPlanTeams.planId, p.id)),
      ).toHaveLength(1);

      await capacity.deletePlan(admin, p.id);

      expect(await db.select().from(capacityPlans).where(eq(capacityPlans.id, p.id))).toHaveLength(
        0,
      );
      // `fk_capacity_plan_teams_plan ... ON DELETE CASCADE` — the service issues ONE statement,
      // so an orphaned team row here would mean the constraint, not the code, is wrong.
      expect(
        await db.select().from(capacityPlanTeams).where(eq(capacityPlanTeams.planId, p.id)),
      ).toHaveLength(0);
    });

    it('frees the release, so a NEW plan can take it', async () => {
      // `uq_capacity_plan_project_release` blocks a second plan per release; deleting the first
      // has to actually release that slot or a mistaken plan would block the release forever.
      const releaseId = await newRelease(projectAId);
      const first = await capacity.createPlan(admin, {
        projectId: projectAId,
        releaseId,
        name: `First ${uniqueKey()}`,
        unit: 'points',
      });
      await capacity.deletePlan(admin, first.id);

      const second = await capacity.createPlan(admin, {
        projectId: projectAId,
        releaseId,
        name: `Second ${uniqueKey()}`,
        unit: 'points',
      });
      expect(second.releaseId).toBe(releaseId);
    });

    it('deletes a PUBLISHED plan — Rally allows it', async () => {
      const p = await capacity.createPlan(admin, {
        projectId: projectAId,
        releaseId: await newRelease(projectAId),
        name: `Published ${uniqueKey()}`,
        unit: 'points',
      });
      // Publish refuses an EMPTY plan, so give it the team that makes it publishable.
      await capacity.addTeam(admin, p.id, teamId);
      await capacity.publishPlan(admin, p.id, { updateFields: false });

      await capacity.deletePlan(admin, p.id);

      expect(await db.select().from(capacityPlans).where(eq(capacityPlans.id, p.id))).toHaveLength(
        0,
      );
    });
  });
});
