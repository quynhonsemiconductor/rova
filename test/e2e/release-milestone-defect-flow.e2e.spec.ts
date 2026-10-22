/**
 * BA business-flow E2E — release + milestone artifact assignment + defect lifecycle.
 *
 * Encodes flows E2E-013 (a Story/Defect has a single active Release assignment and
 * reassignment moves it, using existing work items — no clone), E2E-014 (Milestone
 * artifacts are independent from Release/Iteration assignment and reject out-of-scope
 * items) and E2E-015 (Quality Defect shares the Backlog source, optional parent,
 * valid state machine, delete forbidden) from
 * product-docs/projects/mini-rally/testing/E2E_BUSINESS_FLOW_COVERAGE.md.
 *
 * Drives the REAL application services against the seeded DB.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sql } from 'drizzle-orm';
import { DRIZZLE } from '@platform';
import type { DrizzleDB } from '@platform';
import { IterationsService } from '@modules/iterations';
import { MilestonesService } from '@modules/milestones';
import { ProjectsService } from '@modules/projects';
import { ReleasesService } from '@modules/releases';
import { WorkItemsService } from '@modules/work-items';
import { TeamService } from '@modules/workspace';

import { ALL, SEEDED, adminActor, bootRovaApp, uniqueKey } from './support/flow-harness';

describe('BA flows: releases + milestones + defect lifecycle (real AppModule + seeded DB)', () => {
  let app: NestFastifyApplication;
  let projects: ProjectsService;
  let workItems: WorkItemsService;
  let releases: ReleasesService;
  let milestones: MilestonesService;
  let iterations: IterationsService;
  let teams: TeamService;
  let db: DrizzleDB;
  const actor = adminActor();

  beforeAll(async () => {
    app = await bootRovaApp();
    projects = app.get(ProjectsService);
    workItems = app.get(WorkItemsService);
    releases = app.get(ReleasesService);
    milestones = app.get(MilestonesService);
    iterations = app.get(IterationsService);
    teams = app.get(TeamService);
    db = app.get<DrizzleDB>(DRIZZLE);
  });

  afterAll(async () => {
    await app?.close();
  });

  // ── E2E-013: single active release assignment; reassignment moves the item ──
  describe('release Plan Estimate is clearable', () => {
    it('sets, changes and CLEARS the value without a 500', async () => {
      /**
       * `ReleaseDrizzleRepository.update` ran every supplied `planEstimate` through
       * `String(...)`, so clearing the field sent the four-character string `"null"` into a
       * `numeric(8,2)` column and the request answered 500. Reachable from the release detail form
       * by emptying the field — the one gesture that means "no estimate yet".
       *
       * Driven through the SERVICE rather than a repository unit test on purpose: the bug was a
       * value crossing the application/persistence boundary, and only a real column rejects
       * `"null"`. A mocked repository would have accepted the string happily.
       */
      const project = await projects.createProject(actor, {
        key: uniqueKey(),
        name: 'Plan Estimate Project',
      });
      const release = await releases.createRelease(actor, project.id, 'Estimate Release');

      const set = await releases.updateRelease(actor, release.id, { planEstimate: 42.5 });
      expect(set.planEstimate).toBe('42.50');

      const changed = await releases.updateRelease(actor, release.id, { planEstimate: 10 });
      expect(changed.planEstimate).toBe('10.00');

      // The case that used to 500. `null` CLEARS; it is not the string "null".
      const cleared = await releases.updateRelease(actor, release.id, { planEstimate: null });
      expect(cleared.planEstimate).toBeNull();

      // And it survives a re-read, so the column really holds NULL rather than a rejected write
      // having been swallowed somewhere.
      expect((await releases.getRelease(actor.workspaceId, release.id)).planEstimate).toBeNull();
    });
  });

  describe('E2E-013 release artifact assignment', () => {
    it('assigns an existing work item to one release and moves it on reassignment', async () => {
      const project = await projects.createProject(actor, {
        key: uniqueKey(),
        name: 'Release Project',
      });
      const releaseA = await releases.createRelease(actor, project.id, 'Release A');
      const releaseB = await releases.createRelease(actor, project.id, 'Release B');
      const story = await workItems.createWorkItem(actor, project.id, 'story', 'Shippable story');

      // Assign to A — appears under A only, no clone.
      await workItems.updateWorkItem(actor, story.id, { releaseId: releaseA.id });
      let artifactsA = await releases.listReleaseArtifacts(actor, releaseA.id, ALL);
      let artifactsB = await releases.listReleaseArtifacts(actor, releaseB.id, ALL);
      expect(artifactsA.data.some((a) => a.id === story.id)).toBe(true);
      expect(artifactsB.data.some((a) => a.id === story.id)).toBe(false);

      // Reassign to B — the single releaseId column moves the item off A.
      await workItems.updateWorkItem(actor, story.id, { releaseId: releaseB.id });
      artifactsA = await releases.listReleaseArtifacts(actor, releaseA.id, ALL);
      artifactsB = await releases.listReleaseArtifacts(actor, releaseB.id, ALL);
      expect(artifactsA.data.some((a) => a.id === story.id)).toBe(false);
      expect(artifactsB.data.some((a) => a.id === story.id)).toBe(true);
    });

    it('rejects assigning a work item to a release in a different project', async () => {
      const projectA = await projects.createProject(actor, {
        key: uniqueKey(),
        name: 'Rel Scope A',
      });
      const projectB = await projects.createProject(actor, {
        key: uniqueKey(),
        name: 'Rel Scope B',
      });
      const releaseB = await releases.createRelease(actor, projectB.id, 'Foreign Release');
      const story = await workItems.createWorkItem(actor, projectA.id, 'story', 'A story');

      await expect(
        workItems.updateWorkItem(actor, story.id, { releaseId: releaseB.id }),
      ).rejects.toMatchObject({ code: 'RELEASE_PROJECT_MISMATCH' });
    });

    // FR-004 §6.1 — Task Estimate is a read-only roll-up of the child tasks'
    // estimate hours under the release's assigned work items (same definition
    // as Iteration Status), surfaced on both the list and the detail.
    it('rolls up child task estimate hours into the release Task Estimate', async () => {
      const project = await projects.createProject(actor, {
        key: uniqueKey(),
        name: 'Estimate Rollup Project',
      });
      const release = await releases.createRelease(actor, project.id, 'Estimate Release');
      const story = await workItems.createWorkItem(actor, project.id, 'story', 'Estimated story');
      await workItems.updateWorkItem(actor, story.id, { releaseId: release.id });
      // Task Estimate is an independent planned value (real Rally); the release
      // Task Estimate roll-up sums the child task estimates (3 + 5 = 8).
      await workItems.createTask(actor, story.id, 'Task 1', { estimateHours: '3' });
      await workItems.createTask(actor, story.id, 'Task 2', { estimateHours: '5' });

      const detail = await releases.getReleaseDetail(actor, release.id);
      expect(detail.taskEstimate).toBe(8);

      const page = await releases.listReleases(actor, project.id, { limit: 50, cursor: null });
      const listed = page.data.find((r) => r.id === release.id);
      expect(listed?.taskEstimate).toBe(8);
    });
  });

  // ── E2E-014: milestone artifacts are independent from release/iteration ──────
  describe('E2E-014 milestone artifact assignment', () => {
    it('adds/removes a milestone artifact without mutating release or iteration', async () => {
      const project = await projects.createProject(actor, {
        key: uniqueKey(),
        name: 'Milestone Project',
      });
      const release = await releases.createRelease(actor, project.id, 'MS Release');
      const iteration = await iterations.createIteration(actor, project.id, 'MS Sprint');
      const milestone = await milestones.createMilestone(actor, project.id, 'GA Milestone');
      const story = await workItems.createWorkItem(actor, project.id, 'story', 'Tracked story');

      // Give the story a release + iteration first, to prove independence.
      await workItems.updateWorkItem(actor, story.id, {
        releaseId: release.id,
        iterationId: iteration.id,
      });

      // Assign the milestone artifact.
      await workItems.setWorkItemMilestones(actor, story.id, [milestone.id]);
      const linked = await workItems.getWorkItemMilestones(actor, story.id);
      expect(linked.some((m) => m.id === milestone.id)).toBe(true);

      // Release + iteration assignment are untouched by the milestone write.
      const afterAdd = await workItems.getWorkItem(actor.workspaceId, story.id);
      expect(afterAdd.releaseId).toBe(release.id);
      expect(afterAdd.iterationId).toBe(iteration.id);

      // Removing the milestone likewise leaves release + iteration intact.
      await workItems.setWorkItemMilestones(actor, story.id, []);
      expect(await workItems.getWorkItemMilestones(actor, story.id)).toHaveLength(0);
      const afterRemove = await workItems.getWorkItem(actor.workspaceId, story.id);
      expect(afterRemove.releaseId).toBe(release.id);
      expect(afterRemove.iterationId).toBe(iteration.id);
    });

    it('rejects a milestone artifact outside the work item project scope', async () => {
      const projectA = await projects.createProject(actor, {
        key: uniqueKey(),
        name: 'MS Scope A',
      });
      const projectB = await projects.createProject(actor, {
        key: uniqueKey(),
        name: 'MS Scope B',
      });
      const milestoneB = await milestones.createMilestone(actor, projectB.id, 'Foreign MS');
      const story = await workItems.createWorkItem(actor, projectA.id, 'story', 'A story');

      await expect(
        workItems.setWorkItemMilestones(actor, story.id, [milestoneB.id]),
      ).rejects.toMatchObject({ code: 'MILESTONE_PROJECT_MISMATCH' });
    });

    it('rejects an out-of-scope work item on the milestone-side artifact write', async () => {
      // Symmetric guard: PUT /milestones/:id/artifacts must also reject items
      // that do not belong to the milestone's project (FR-023 / AC12).
      const projectA = await projects.createProject(actor, {
        key: uniqueKey(),
        name: 'MS Side A',
      });
      const projectB = await projects.createProject(actor, {
        key: uniqueKey(),
        name: 'MS Side B',
      });
      const milestoneA = await milestones.createMilestone(actor, projectA.id, 'Scoped MS');
      const inScope = await workItems.createWorkItem(actor, projectA.id, 'story', 'In-scope story');
      const outOfScope = await workItems.createWorkItem(
        actor,
        projectB.id,
        'story',
        'Foreign story',
      );

      // A foreign work item is rejected — no partial write.
      await expect(
        milestones.setMilestoneArtifacts(actor, milestoneA.id, [inScope.id, outOfScope.id]),
      ).rejects.toMatchObject({ code: 'MILESTONE_PROJECT_MISMATCH' });
      expect(await milestones.getMilestoneArtifacts(actor, milestoneA.id)).toHaveLength(0);

      // An in-scope work item is accepted.
      const linked = await milestones.setMilestoneArtifacts(actor, milestoneA.id, [inScope.id]);
      expect(linked).toContain(inScope.id);
    });

    it('rejects a work item outside the milestone team scope (FR-021/023 / SRS §5.2)', async () => {
      // When a milestone selects Team scope, an artifact must belong to one of
      // its selected teams; items on any other team (or no team) are rejected.
      const project = await projects.createProject(actor, {
        key: uniqueKey(),
        name: 'MS Team Scope',
      });
      const teamIn = await teams.createTeam(
        actor.workspaceId,
        { name: 'Team In Scope', key: uniqueKey('T') },
        actor.sub,
      );
      const teamOut = await teams.createTeam(
        actor.workspaceId,
        { name: 'Team Out Scope', key: uniqueKey('T') },
        actor.sub,
      );
      // Work items can only join teams linked to their project.
      await projects.linkTeam(actor.workspaceId, project.id, teamIn.id);
      await projects.linkTeam(actor.workspaceId, project.id, teamOut.id);

      const milestone = await milestones.createMilestone(actor, project.id, 'Team-scoped MS');
      await milestones.setMilestoneTeams(actor, milestone.id, [teamIn.id]);

      // A work item on the wrong team is rejected — no partial write.
      const foreignTeamItem = await workItems.createWorkItem(
        actor,
        project.id,
        'story',
        'Wrong-team story',
        { teamId: teamOut.id },
      );
      await expect(
        milestones.setMilestoneArtifacts(actor, milestone.id, [foreignTeamItem.id]),
      ).rejects.toMatchObject({ code: 'MILESTONE_TEAM_MISMATCH' });
      expect(await milestones.getMilestoneArtifacts(actor, milestone.id)).toHaveLength(0);

      // A work item on an in-scope team is accepted.
      const inTeamItem = await workItems.createWorkItem(
        actor,
        project.id,
        'story',
        'Right-team story',
        { teamId: teamIn.id },
      );
      const linked = await milestones.setMilestoneArtifacts(actor, milestone.id, [inTeamItem.id]);
      expect(linked).toContain(inTeamItem.id);
    });
  });

  // ── E2E-015: quality defect lifecycle shares the backlog source ─────────────
  describe('E2E-015 defect lifecycle', () => {
    it('creates a parentless defect, walks the valid state machine, and deletes it', async () => {
      const project = await projects.createProject(actor, {
        key: uniqueKey(),
        name: 'Defect Lifecycle',
      });
      const defect = await workItems.createWorkItem(
        actor,
        project.id,
        'defect',
        'Standalone defect',
      );
      expect(defect.type).toBe('defect');
      expect(defect.parentId ?? null).toBeNull();

      // Same source: the defect is in the Backlog.
      const backlog = await workItems.listBacklog(actor, project.id, {}, ALL);
      expect(backlog.data.some((w) => w.id === defect.id)).toBe(true);

      // Valid state walk: submitted → open → fixed → closed.
      await workItems.updateWorkItem(actor, defect.id, { defectState: 'submitted' });
      await workItems.updateWorkItem(actor, defect.id, { defectState: 'open' });
      await workItems.updateWorkItem(actor, defect.id, { defectState: 'fixed' });
      const closed = await workItems.updateWorkItem(actor, defect.id, { defectState: 'closed' });
      expect(closed.defectState).toBe('closed');

      // Invalid transition: closed → fixed (Closed is terminal in Phase 3.4).
      await expect(
        workItems.updateWorkItem(actor, defect.id, { defectState: 'fixed' }),
      ).rejects.toMatchObject({ code: 'WORK_ITEM_INVALID_TRANSITION' });

      // FR-017: reopen from Closed is DEFERRED — must be rejected in Phase 3.4.
      await expect(
        workItems.updateWorkItem(actor, defect.id, { defectState: 'open' }),
      ).rejects.toMatchObject({ code: 'WORK_ITEM_INVALID_TRANSITION' });

      // A defect IS deletable since the BA's ruling of 2026-08-20 (§3.2:81 over Phase 3.4), so what
      // is asserted here now is that resolving by state stays the ordinary path and the delete no
      // longer refuses. Deleted last, because the row is unreadable afterwards.
      await workItems.deleteWorkItem(actor, defect.id);
      await expect(workItems.getWorkItem(actor.workspaceId, defect.id)).rejects.toMatchObject({
        code: 'WORK_ITEM_NOT_FOUND',
      });
    });

    it('a soft delete CASCADES NOTHING and records the actor (P3-QA-FR-020)', async () => {
      /**
       * "Soft delete retains child Tasks, attachments, comments and relations, records the
       * actor/action and performs no physical cascade delete" — and §187 spells the second half out:
       * "Successful delete sets `work_items.deleted_at` and writes an activity/audit event with actor
       * and Defect ID."
       *
       * The relation half was a real cascade: the service deleted the defect's relation rows so no
       * link dangled on the OTHER item. `listForItem` already hides a relation whose other end is
       * soft-deleted, so nothing dangled either way — the cascade only made the delete partly
       * irreversible. Asserted from the SURVIVING item, because the deleted one is unreadable.
       */
      // SEEDED.nxp, not a fresh project: `test/e2e-fixtures.ratchet.spec.ts` caps the suite's
      // `createProject` count and may only ever let it fall, and nothing here needs a project of
      // its own — the rule under test is about one item's own relations.
      const projectId = SEEDED.nxp.projectId;
      const story = await workItems.createWorkItem(actor, projectId, 'story', 'Survivor story');
      const defect = await workItems.createWorkItem(actor, projectId, 'defect', 'Linked defect');
      await workItems.linkWorkItem(actor, defect.id, story.id, 'relates_to');

      // The premise: the link is visible from both ends before the delete.
      expect((await workItems.listRelations(actor, story.id)).length).toBe(1);

      await workItems.deleteWorkItem(actor, defect.id);

      // The surviving item shows no link — `listForItem` filters a soft-deleted other end — while the
      // ROW itself is still there, which is what makes the delete reversible in the database.
      expect(await workItems.listRelations(actor, story.id)).toEqual([]);
      const relationRows = await db.execute<{ count: number }>(
        sql`select count(*)::int as count from work.work_item_relations
            where source_item_id = ${defect.id}::uuid or target_item_id = ${defect.id}::uuid`,
      );
      expect(relationRows.rows[0].count).toBe(1);

      // And the delete named its actor, in the item's own history.
      const logged = await db.execute<{ actor_id: string }>(
        sql`select actor_id from work.activity_logs
            where entity_id = ${defect.id}::uuid and action = 'work_item.deleted'`,
      );
      expect(logged.rows).toHaveLength(1);
      expect(logged.rows[0].actor_id).toBe(actor.sub);
    });

    it('declines a defect after triage (Open → Closed Declined) and treats it as terminal', async () => {
      const project = await projects.createProject(actor, {
        key: uniqueKey(),
        name: 'Defect Decline',
      });
      const defect = await workItems.createWorkItem(actor, project.id, 'defect', 'Declined defect');

      // Submitted → Open → Closed Declined (declined after triage, SRS §6).
      await workItems.updateWorkItem(actor, defect.id, { defectState: 'open' });
      const declined = await workItems.updateWorkItem(actor, defect.id, {
        defectState: 'closed_declined',
      });
      expect(declined.defectState).toBe('closed_declined');

      // FR-017: reopen from Closed Declined is DEFERRED — must be rejected.
      await expect(
        workItems.updateWorkItem(actor, defect.id, { defectState: 'open' }),
      ).rejects.toMatchObject({ code: 'WORK_ITEM_INVALID_TRANSITION' });
    });
  });
});
