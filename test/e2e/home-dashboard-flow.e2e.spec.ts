/**
 * BA business-flow E2E — Home dashboard aggregates.
 *
 * Verifies the bounded / workspace-scoped endpoints that replace the old
 * per-project fan-out: work-items summary counts, "my work" top-N, and the
 * per-project health rollup. Drives the REAL application services + seeded DB.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ProjectsService } from '@modules/projects';
import { WorkItemsService } from '@modules/work-items';
import { IterationsService } from '@modules/iterations';

import { adminActor, bootRovaApp, uniqueKey, ADMIN_USER_ID } from './support/flow-harness';

describe('BA flow: Home dashboard aggregates (real AppModule + seeded DB)', () => {
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

  it('summary counts reflect a freshly created project + assigned/blocked/defect items', async () => {
    const before = await workItems.getWorkspaceSummary(actor);

    const project = await projects.createProject(actor, { key: uniqueKey(), name: 'Home Summary' });
    const iteration = await iterations.createIteration(actor, project.id, 'Home Sprint');
    // Story assigned to the actor.
    const story = await workItems.createWorkItem(actor, project.id, 'story', 'Assigned story', {
      assigneeId: ADMIN_USER_ID,
    });
    // Defect assigned to the actor, then blocked.
    const defect = await workItems.createWorkItem(actor, project.id, 'defect', 'Assigned defect', {
      assigneeId: ADMIN_USER_ID,
    });
    await workItems.updateWorkItem(actor, defect.id, { isBlocked: true });

    const after = await workItems.getWorkspaceSummary(actor);
    expect(after.activeProjects).toBe(before.activeProjects + 1);
    expect(after.assignedToMe).toBeGreaterThanOrEqual(before.assignedToMe + 2);
    expect(after.openDefects).toBeGreaterThanOrEqual(before.openDefects + 1);
    expect(after.blockedItems).toBeGreaterThanOrEqual(before.blockedItems + 1);

    // Committing the iteration bumps the active-sprint count.
    await iterations.commitIteration(actor, iteration.id);
    const afterCommit = await workItems.getWorkspaceSummary(actor);
    expect(afterCommit.activeSprints).toBe(after.activeSprints + 1);

    void story;
  });

  it('my-work returns items assigned to the actor, bounded and priority-ordered', async () => {
    const project = await projects.createProject(actor, { key: uniqueKey(), name: 'Home MyWork' });
    const normal = await workItems.createWorkItem(actor, project.id, 'story', 'Normal', {
      assigneeId: ADMIN_USER_ID,
    });
    const urgent = await workItems.createWorkItem(actor, project.id, 'defect', 'Urgent bug', {
      assigneeId: ADMIN_USER_ID,
      priority: 'urgent',
    });

    // Generous limit so BOTH fresh items are in the window regardless of seed
    // size. `actor` is the shared seeded admin, and the e2e DB is never cleaned
    // between runs, so admin accumulates many assigned items across runs (96+
    // and growing). my-work orders by `priority DESC, rank ASC` and new rows get
    // the highest rank — so a default-priority ("normal") item sorts LAST within
    // its priority band and falls outside a small window once accumulation
    // exceeds it (the real cause of this test's flake: "expected [50 items] to
    // include <normal.id>"). The bounded/limit behaviour is asserted separately
    // below. (Long-term fix is per-test data isolation for the whole e2e suite.)
    const rows = await workItems.listMyWork(actor, 100_000);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(normal.id);
    expect(ids).toContain(urgent.id);
    // Every row is assigned to the actor and carries its project key.
    const mine = rows.find((r) => r.id === urgent.id);
    expect(mine?.projectKey).toBe(project.key);
    // Urgent sorts ahead of normal within this project's items.
    expect(ids.indexOf(urgent.id)).toBeLessThan(ids.indexOf(normal.id));

    // Bounded: never returns more than the requested limit.
    expect((await workItems.listMyWork(actor, 1)).length).toBeLessThanOrEqual(1);
  });

  it('project-health returns a bounded rollup with sprint / defect / blocked figures', async () => {
    const project = await projects.createProject(actor, { key: uniqueKey(), name: 'Home Health' });
    const iteration = await iterations.createIteration(actor, project.id, 'Health Sprint');
    await iterations.commitIteration(actor, iteration.id);
    const defect = await workItems.createWorkItem(actor, project.id, 'defect', 'Health defect');
    await workItems.updateWorkItem(actor, defect.id, { isBlocked: true });

    // A generous limit so the fresh project is included regardless of seed size.
    const health = await projects.listProjectHealth(actor, 50);
    const row = health.find((h) => h.id === project.id);
    expect(row).toBeDefined();
    expect(row?.activeSprintName).toBe('Health Sprint');
    expect(row?.openDefects).toBeGreaterThanOrEqual(1);
    expect(row?.blockedCount).toBeGreaterThanOrEqual(1);
    expect(row?.progressPercent).toBeGreaterThanOrEqual(0);
    expect(row?.progressPercent).toBeLessThanOrEqual(100);

    // Bounded.
    expect((await projects.listProjectHealth(actor, 3)).length).toBeLessThanOrEqual(3);
  });
});
