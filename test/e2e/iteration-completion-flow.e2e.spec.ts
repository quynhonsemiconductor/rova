/**
 * BA business-flow E2E — task completion → parent auto-complete + iteration auto-accept.
 *
 * Encodes flows E2E-011 (parent Story/Defect auto-completes when all child Tasks
 * complete) and E2E-012 (auto-complete is convenience-only — manual override still
 * works — and a committed Iteration auto-accepts when all its Stories/Defects are
 * accepted) from
 * product-docs/projects/mini-rally/testing/E2E_BUSINESS_FLOW_COVERAGE.md.
 *
 * Drives the REAL application services against the seeded DB. The completion rules
 * live in WorkItemsService.updateWorkItem, so we exercise them directly rather than
 * through the Team Status board (which only surfaces tasks).
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IterationsService } from '@modules/iterations';
import { ProjectsService } from '@modules/projects';
import { WorkItemsService } from '@modules/work-items';

import { adminActor, bootRovaApp, uniqueKey } from './support/flow-harness';

describe('BA flows: task completion → parent + iteration auto-status (real AppModule + seeded DB)', () => {
  let app: NestFastifyApplication;
  let projects: ProjectsService;
  let workItems: WorkItemsService;
  let iterations: IterationsService;
  const actor = adminActor();

  beforeAll(async () => {
    app = await bootRovaApp();
    projects = app.get(ProjectsService);
    workItems = app.get(WorkItemsService);
    iterations = app.get(IterationsService);
  });

  afterAll(async () => {
    await app?.close();
  });

  // ── E2E-011: parent auto-completes only when ALL child tasks complete ────────
  describe('E2E-011 parent auto-complete', () => {
    it('completes the parent story only after every child task is completed', async () => {
      const project = await projects.createProject(actor, {
        key: uniqueKey(),
        name: 'Auto-complete Project',
      });
      const story = await workItems.createWorkItem(
        actor,
        project.id,
        'story',
        'Story with two tasks',
      );
      const task1 = await workItems.createTask(actor, story.id, 'Task 1');
      const task2 = await workItems.createTask(actor, story.id, 'Task 2');

      // Complete the first task — parent must NOT auto-complete yet.
      await workItems.updateWorkItem(actor, task1.id, { scheduleState: 'completed' });
      const afterFirst = await workItems.getWorkItem(actor.workspaceId, story.id);
      expect(afterFirst.scheduleState).not.toBe('completed');

      // Complete the second (last) task — parent auto-completes.
      await workItems.updateWorkItem(actor, task2.id, { scheduleState: 'completed' });
      const afterSecond = await workItems.getWorkItem(actor.workspaceId, story.id);
      expect(afterSecond.scheduleState).toBe('completed');
    });
  });

  // ── E2E-012: auto-complete is convenience-only; iteration auto-accept ────────
  describe('E2E-012 manual override + iteration auto-accept', () => {
    it('allows a manual schedule-state change after auto-complete (no scope lock)', async () => {
      const project = await projects.createProject(actor, {
        key: uniqueKey(),
        name: 'Manual Override Project',
      });
      const story = await workItems.createWorkItem(actor, project.id, 'story', 'Reopenable story');
      const task = await workItems.createTask(actor, story.id, 'Only task');

      await workItems.updateWorkItem(actor, task.id, { scheduleState: 'completed' });
      expect((await workItems.getWorkItem(actor.workspaceId, story.id)).scheduleState).toBe(
        'completed',
      );

      // A user can still move the parent back — auto-complete is not a lock.
      const reopened = await workItems.updateWorkItem(actor, story.id, {
        scheduleState: 'in_progress',
      });
      expect(reopened.scheduleState).toBe('in_progress');
    });

    it('auto-accepts a committed iteration when all its stories are accepted', async () => {
      const project = await projects.createProject(actor, {
        key: uniqueKey(),
        name: 'Auto-accept Project',
      });
      const iteration = await iterations.createIteration(actor, project.id, 'Sprint AA');
      const story = await workItems.createWorkItem(actor, project.id, 'story', 'Only sprint story');

      // Assign to the iteration, then commit it (planning → committed).
      await workItems.updateWorkItem(actor, story.id, { iterationId: iteration.id });
      const committed = await iterations.commitIteration(actor, iteration.id);
      expect(committed.state).toBe('committed');

      // Accepting the last outstanding story flips the committed iteration to accepted.
      await workItems.updateWorkItem(actor, story.id, { scheduleState: 'accepted' });
      const finalState = await iterations.getIteration(actor.workspaceId, iteration.id);
      expect(finalState.state).toBe('accepted');
    });
  });
});
