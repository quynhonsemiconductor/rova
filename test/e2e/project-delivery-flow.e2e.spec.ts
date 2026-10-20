/**
 * BA business-flow E2E — project foundation → work items → tasks → iteration.
 *
 * Encodes flows E2E-001 … E2E-007 from
 * product-docs/projects/mini-rally/testing/E2E_BUSINESS_FLOW_COVERAGE.md,
 * driving the REAL application services against the seeded DB. Each flow proves
 * that the shipped codebase honours the BA project scope and rules.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IterationsService, IterationStatusService } from '@modules/iterations';
import type { IterationStatusFilters } from '@modules/iterations';
import { ProjectsService } from '@modules/projects';
import { WorkItemsService } from '@modules/work-items';
import type { WorkItemFilters } from '@modules/work-items';

import { ALL, ADMIN_USER_ID, adminActor, bootRovaApp, uniqueKey } from './support/flow-harness';

const NO_WI_FILTERS = {} as WorkItemFilters;
const NO_IS_FILTERS = {} as IterationStatusFilters;

describe('BA flows: project foundation → work items → iteration (real AppModule + seeded DB)', () => {
  let app: NestFastifyApplication;
  let projects: ProjectsService;
  let workItems: WorkItemsService;
  let iterations: IterationsService;
  let iterationStatus: IterationStatusService;
  const actor = adminActor();

  beforeAll(async () => {
    app = await bootRovaApp();
    projects = app.get(ProjectsService);
    workItems = app.get(WorkItemsService);
    iterations = app.get(IterationsService);
    iterationStatus = app.get(IterationStatusService);
  });

  afterAll(async () => {
    await app?.close();
  });

  // ── E2E-001: Admin creates the project foundation ───────────────────────────
  describe('E2E-001 project foundation', () => {
    it('creates a project with a normalised, immutable key', async () => {
      const key = uniqueKey();
      const project = await projects.createProject(actor, {
        key: key.toLowerCase(),
        name: 'Foundation Project',
      });

      // Key is normalised to upper-case and the lead defaults to the actor.
      expect(project.key).toBe(key.toUpperCase());
      expect(project.leadId).toBe(ADMIN_USER_ID);

      // Foundation is queryable and its key is unchanged (immutable identity).
      const fetched = await projects.getProject(actor.workspaceId, project.id);
      expect(fetched.key).toBe(key.toUpperCase());
    });

    it('rejects a duplicate project key with PROJECT_KEY_TAKEN', async () => {
      const key = uniqueKey();
      await projects.createProject(actor, { key: key, name: 'First' });
      await expect(
        projects.createProject(actor, { key: key, name: 'Second' }),
      ).rejects.toMatchObject({
        code: 'PROJECT_KEY_TAKEN',
      });
    });

    it('rejects a project whose lead is not an active workspace member', async () => {
      const notAMember = '00000000-0000-7000-8000-0000000009ff';
      await expect(
        projects.createProject(actor, { key: uniqueKey(), name: 'Bad Lead', leadId: notAMember }),
      ).rejects.toMatchObject({ code: 'PROJECT_LEAD_NOT_MEMBER' });
    });
  });

  // ── E2E-003: Create a Story and manage its detail ───────────────────────────
  describe('E2E-003 story create + detail', () => {
    it('persists description / owner / scheduleState / planEstimate on a story', async () => {
      const project = await projects.createProject(actor, {
        key: uniqueKey(),
        name: 'Story Project',
      });
      const story = await workItems.createWorkItem(
        actor,
        project.id,
        'story',
        'As a user I can log in',
      );

      const updated = await workItems.updateWorkItem(actor, story.id, {
        description: 'Login with SSO',
        assigneeId: ADMIN_USER_ID,
        scheduleState: 'in_progress',
        storyPoints: '5',
      });

      expect(updated.description).toBe('Login with SSO');
      expect(updated.assigneeId).toBe(ADMIN_USER_ID);
      expect(updated.scheduleState).toBe('in_progress');
      // WorkItemsService surfaces numeric columns as strings to preserve
      // precision (see WorkItem.storyPoints); the HTTP boundary coerces to a
      // number. Assert the numeric value to honour that service contract.
      expect(Number(updated.storyPoints)).toBe(5);

      // Re-read proves the writes are durable (not just the returned copy).
      const reread = await workItems.getWorkItem(actor.workspaceId, story.id);
      expect(reread.description).toBe('Login with SSO');
      expect(reread.scheduleState).toBe('in_progress');
    });

    it('rejects a priority on a story (stories carry no priority)', async () => {
      const project = await projects.createProject(actor, {
        key: uniqueKey(),
        name: 'Story Priority',
      });
      const story = await workItems.createWorkItem(actor, project.id, 'story', 'No priority story');
      await expect(
        workItems.updateWorkItem(actor, story.id, { priority: 'high' }),
      ).rejects.toMatchObject({ code: 'WORK_ITEM_STORY_HAS_NO_PRIORITY' });
    });
  });

  // ── E2E-004: Create a Defect + defect-specific behaviour ────────────────────
  describe('E2E-004 defect create', () => {
    it('creates a top-level defect carrying a priority', async () => {
      const project = await projects.createProject(actor, {
        key: uniqueKey(),
        name: 'Defect Project',
      });
      const defect = await workItems.createWorkItem(actor, project.id, 'defect', 'Login crashes', {
        priority: 'high',
      });
      expect(defect.type).toBe('defect');
      expect(defect.priority).toBe('high');
    });

    it('allows a defect under a story parent but rejects a defect under a defect', async () => {
      const project = await projects.createProject(actor, {
        key: uniqueKey(),
        name: 'Defect Parent',
      });
      const story = await workItems.createWorkItem(actor, project.id, 'story', 'Parent story');
      const parentDefect = await workItems.createWorkItem(
        actor,
        project.id,
        'defect',
        'Parent defect',
      );

      const child = await workItems.createWorkItem(actor, project.id, 'defect', 'Child defect', {
        parentId: story.id,
      });
      expect(child.parentId).toBe(story.id);

      await expect(
        workItems.createWorkItem(actor, project.id, 'defect', 'Bad child', {
          parentId: parentDefect.id,
        }),
      ).rejects.toMatchObject({ code: 'WORK_ITEM_INVALID_PARENT_TYPE' });
    });
  });

  // ── E2E-005: Add a Task under a Story + track time ──────────────────────────
  describe('E2E-005 task under story + time tracking', () => {
    it('creates a child task (not a backlog item) and totals its hours', async () => {
      const project = await projects.createProject(actor, {
        key: uniqueKey(),
        name: 'Task Project',
      });
      const story = await workItems.createWorkItem(actor, project.id, 'story', 'Story with tasks');

      // Task time model (real Rally): Estimate is an independent planned value;
      // To Do defaults to the Estimate when not given; Actuals is separate.
      const task = await workItems.createTask(actor, story.id, 'Implement endpoint', {
        estimateHours: '8',
        actualHours: '5',
      });
      expect(task.type).toBe('task');
      expect(task.parentId).toBe(story.id);
      expect(Number(task.estimateHours)).toBe(8); // independent, client-set
      expect(Number(task.todoHours)).toBe(8); // defaulted to Estimate (To Do omitted)

      const totals = await workItems.getTaskTotals(actor, story.id);
      expect(totals.taskCount).toBe(1);
      expect(totals.estimateHours).toBe(8); // Σ(estimate), independent
      expect(totals.todoHours).toBe(8);
      expect(totals.actualHours).toBe(5);

      // A task is NOT a backlog item — backlog holds stories + defects only.
      const backlog = await workItems.listBacklog(actor, project.id, NO_WI_FILTERS, ALL);
      expect(backlog.data.some((w) => w.id === task.id)).toBe(false);
      expect(backlog.data.some((w) => w.id === story.id)).toBe(true);
    });

    // TASK-FR-012: reassign a task's Work Product within the same project.
    it('reassigns a task to another work product in the same project', async () => {
      const project = await projects.createProject(actor, {
        key: uniqueKey(),
        name: 'Task Reassign Project',
      });
      const storyA = await workItems.createWorkItem(actor, project.id, 'story', 'Story A');
      const storyB = await workItems.createWorkItem(actor, project.id, 'story', 'Story B');
      const task = await workItems.createTask(actor, storyA.id, 'Movable task');
      expect(task.parentId).toBe(storyA.id);

      const moved = await workItems.updateWorkItem(actor, task.id, { parentId: storyB.id });
      expect(moved.parentId).toBe(storyB.id);

      // The move is durable and the task follows its new Work Product's roll-up.
      const refetched = await workItems.getWorkItem(actor.workspaceId, task.id);
      expect(refetched.parentId).toBe(storyB.id);
      expect((await workItems.getTaskTotals(actor, storyA.id)).taskCount).toBe(0);
      expect((await workItems.getTaskTotals(actor, storyB.id)).taskCount).toBe(1);
    });

    it('rejects reassigning a task to a work product in a different project', async () => {
      const projectA = await projects.createProject(actor, {
        key: uniqueKey(),
        name: 'Reassign Scope A',
      });
      const projectB = await projects.createProject(actor, {
        key: uniqueKey(),
        name: 'Reassign Scope B',
      });
      const storyA = await workItems.createWorkItem(actor, projectA.id, 'story', 'In-scope story');
      const foreignStory = await workItems.createWorkItem(
        actor,
        projectB.id,
        'story',
        'Out-of-scope story',
      );
      const task = await workItems.createTask(actor, storyA.id, 'Scoped task');

      await expect(
        workItems.updateWorkItem(actor, task.id, { parentId: foreignStory.id }),
      ).rejects.toMatchObject({ code: 'WORK_ITEM_PARENT_SCOPE_MISMATCH' });

      // No partial move — the task keeps its original Work Product.
      const refetched = await workItems.getWorkItem(actor.workspaceId, task.id);
      expect(refetched.parentId).toBe(storyA.id);
    });
  });

  // ── E2E-006: A backlog item enters an Iteration → appears in Iteration Status
  describe('E2E-006 backlog item enters an iteration', () => {
    it('assigns a story to an iteration and surfaces it in Iteration Status (same item)', async () => {
      const project = await projects.createProject(actor, {
        key: uniqueKey(),
        name: 'Iteration Project',
      });
      const iteration = await iterations.createIteration(actor, project.id, 'Sprint 1');
      const story = await workItems.createWorkItem(actor, project.id, 'story', 'Sprint story');

      const assigned = await workItems.updateWorkItem(actor, story.id, {
        iterationId: iteration.id,
      });
      expect(assigned.iterationId).toBe(iteration.id);

      const status = await iterationStatus.getStatus(actor, iteration.id, NO_IS_FILTERS, ALL);
      const found = status.items.data.find((i) => i.id === story.id);
      expect(found).toBeDefined();
      expect(found?.itemKey).toBe(story.itemKey);
    });
  });

  // ── E2E-007: Create an item directly in Iteration Status ────────────────────
  describe('E2E-007 create directly in iteration status', () => {
    it('creates a story in the iteration, NOT in the backlog, and returns it when unscheduled', async () => {
      /**
       * The Backlog is unscheduled work only: "Plan > Backlog shows only Story/Defect items whose
       * Iteration is `Unscheduled`. Assigning a Story/Defect to an Iteration removes it from Backlog
       * … moving it back to `Unscheduled` returns it to Backlog"
       * (`RECONCILED_SOURCE_OF_TRUTH.md:42`).
       *
       * This test previously asserted the opposite — "also visible in the backlog" — because the
       * `iteration_id IS NULL` predicate that defines the screen was missing from `listBacklog`, so
       * the Backlog showed everything and an item could be in both places at once. The intent behind
       * it ("single source of truth", no duplicates) is kept and strengthened: the item is in exactly
       * one of the two lists at any moment, and the round trip is asserted in both directions rather
       * than only the way that happened to pass.
       */
      const project = await projects.createProject(actor, {
        key: uniqueKey(),
        name: 'Direct Iteration',
      });
      const iteration = await iterations.createIteration(actor, project.id, 'Sprint A');

      const { workItemId } = await iterationStatus.createItemInIteration(actor, iteration.id, {
        type: 'story',
        title: 'Created in iteration',
      });

      // Visible in the iteration…
      const status = await iterationStatus.getStatus(actor, iteration.id, NO_IS_FILTERS, ALL);
      expect(status.items.data.some((i) => i.id === workItemId)).toBe(true);

      // …and therefore NOT in the backlog, which is the unscheduled list.
      const scheduled = await workItems.listBacklog(actor, project.id, NO_WI_FILTERS, ALL);
      expect(scheduled.data.filter((w) => w.id === workItemId)).toHaveLength(0);

      // Moving it back to Unscheduled returns it — exactly once.
      await workItems.updateWorkItem(actor, workItemId, { iterationId: null });
      const unscheduled = await workItems.listBacklog(actor, project.id, NO_WI_FILTERS, ALL);
      expect(unscheduled.data.filter((w) => w.id === workItemId)).toHaveLength(1);

      // And it has left the iteration, so it is never in both.
      const after = await iterationStatus.getStatus(actor, iteration.id, NO_IS_FILTERS, ALL);
      expect(after.items.data.some((i) => i.id === workItemId)).toBe(false);
    });

    it('rejects a task created directly in an iteration (stories/defects only)', async () => {
      const project = await projects.createProject(actor, {
        key: uniqueKey(),
        name: 'Iteration Task Guard',
      });
      const iteration = await iterations.createIteration(actor, project.id, 'Sprint B');
      await expect(
        iterationStatus.createItemInIteration(actor, iteration.id, {
          type: 'task',
          title: 'Illegal task',
        }),
      ).rejects.toMatchObject({ code: 'WORK_ITEM_NOT_BACKLOG_TYPE' });
    });
  });
});
