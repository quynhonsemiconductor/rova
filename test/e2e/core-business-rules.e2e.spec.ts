/**
 * Core business rules — concise regression checks for the invariants the SRS
 * cares most about, run against the REAL AppModule + seeded DB. Each case
 * asserts one rule end-to-end at the service boundary.
 *
 * Scope: rules NOT already owned by a richer scenario spec. (Parent
 * auto-complete + iteration auto-accept live in iteration-completion-flow;
 * task Estimate = ToDo + Actual lives in project-delivery-flow; those are not
 * duplicated here.)
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ProjectsService } from '@modules/projects';
import { WorkItemsService } from '@modules/work-items';
import { IterationsService } from '@modules/iterations';
import { ReleasesService } from '@modules/releases';
import { MilestonesService } from '@modules/milestones';

import { ALL, adminActor, bootRovaApp, uniqueKey } from './support/flow-harness';

describe('Core business rules (real AppModule + seeded DB)', () => {
  let app: NestFastifyApplication;
  let projects: ProjectsService;
  let workItems: WorkItemsService;
  let iterations: IterationsService;
  let releases: ReleasesService;
  let milestones: MilestonesService;
  const actor = adminActor();
  const newProject = (name: string) => projects.createProject(actor, { key: uniqueKey(), name });

  beforeAll(async () => {
    app = await bootRovaApp();
    projects = app.get(ProjectsService);
    workItems = app.get(WorkItemsService);
    iterations = app.get(IterationsService);
    releases = app.get(ReleasesService);
    milestones = app.get(MilestonesService);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('iteration walks the Planning → Committed → Accepted lifecycle', async () => {
    const p = await newProject('Iteration lifecycle');
    const it = await iterations.createIteration(actor, p.id, 'Sprint 1');
    expect(it.state).toBe('planning');
    // Accept requires scope, so give the iteration one item before accepting.
    const s = await workItems.createWorkItem(actor, p.id, 'story', 'Scoped');
    await workItems.updateWorkItem(actor, s.id, { iterationId: it.id });
    expect((await iterations.commitIteration(actor, it.id)).state).toBe('committed');
    await workItems.updateWorkItem(actor, s.id, { scheduleState: 'accepted' });
    expect((await iterations.getIteration(actor.workspaceId, it.id)).state).toBe('accepted');
  });

  it('releases default to Planning and expose only the confirmed status catalog', async () => {
    const p = await newProject('Release catalog');
    const a = await releases.createRelease(actor, p.id, 'Release A');
    const b = await releases.createRelease(actor, p.id, 'Release B');
    expect(a.status).toBe('planning');
    expect(b.status).toBe('planning');
    // Catalog is exactly the three confirmed states.
    expect((await releases.updateRelease(actor, a.id, { status: 'active' })).status).toBe('active');
    expect((await releases.updateRelease(actor, a.id, { status: 'accepted' })).status).toBe(
      'accepted',
    );
  });

  it('milestone derives MIN start / MAX end from its linked releases', async () => {
    const p = await newProject('Milestone dates');
    const a = await releases.createRelease(actor, p.id, 'Rel A', {
      startDate: '2026-07-20',
      releaseDate: '2026-08-10',
    });
    const b = await releases.createRelease(actor, p.id, 'Rel B', {
      startDate: '2026-07-25',
      releaseDate: '2026-08-31',
    });
    const ms = await milestones.createMilestone(actor, p.id, 'GA');
    await milestones.setMilestoneReleases(actor, ms.id, [a.id, b.id]);
    const detail = await milestones.getMilestone(actor.workspaceId, ms.id);
    expect(detail.targetStartDate).toBe('2026-07-20'); // MIN(start)
    expect(detail.targetEndDate).toBe('2026-08-31'); // MAX(releaseDate)
  });

  it('assigning a story to an iteration persists and leaves the iteration in Planning', async () => {
    const p = await newProject('Iteration assign');
    const it = await iterations.createIteration(actor, p.id, 'Sprint 5');
    const s = await workItems.createWorkItem(actor, p.id, 'story', 'Assignable');
    await workItems.updateWorkItem(actor, s.id, { iterationId: it.id });
    expect((await workItems.getWorkItem(actor.workspaceId, s.id)).iterationId).toBe(it.id);
    expect((await iterations.getIteration(actor.workspaceId, it.id)).state).toBe('planning');
  });

  it('a work item has one Release and many Milestones, and milestones survive a release change', async () => {
    const p = await newProject('Release + milestones');
    const relA = await releases.createRelease(actor, p.id, 'RA');
    const relB = await releases.createRelease(actor, p.id, 'RB');
    const m1 = await milestones.createMilestone(actor, p.id, 'M1');
    const m2 = await milestones.createMilestone(actor, p.id, 'M2');
    const s = await workItems.createWorkItem(actor, p.id, 'story', 'Shipped');

    await workItems.updateWorkItem(actor, s.id, { releaseId: relA.id });
    await workItems.setWorkItemMilestones(actor, s.id, [m1.id, m2.id]);
    // Change the release — milestones must persist independently.
    await workItems.updateWorkItem(actor, s.id, { releaseId: relB.id });

    expect((await workItems.getWorkItem(actor.workspaceId, s.id)).releaseId).toBe(relB.id);
    const linked = (await workItems.getWorkItemMilestones(actor, s.id)).map((m) => m.id).sort();
    expect(linked).toEqual([m1.id, m2.id].sort());
  });

  it('tasks live under a story (counted on the parent) and never appear in the backlog', async () => {
    const p = await newProject('Tasks under story');
    const s = await workItems.createWorkItem(actor, p.id, 'story', 'Parent');
    await workItems.createTask(actor, s.id, 'T1');
    await workItems.createTask(actor, s.id, 'T2');
    expect((await workItems.listTasks(actor, s.id)).length).toBe(2);
    const backlog = await workItems.listBacklog(actor, p.id, {}, ALL);
    expect(backlog.data.every((w) => w.type !== 'task')).toBe(true);
  });

  it('reopening a completed task moves the parent story back to In-Progress', async () => {
    const p = await newProject('Task reopen');
    const s = await workItems.createWorkItem(actor, p.id, 'story', 'Parent');
    const t1 = await workItems.createTask(actor, s.id, 'T1');
    await workItems.updateWorkItem(actor, t1.id, { scheduleState: 'completed' });
    await workItems.updateWorkItem(actor, t1.id, { scheduleState: 'in_progress' });
    expect((await workItems.getWorkItem(actor.workspaceId, s.id)).scheduleState).toBe('in_progress');
  });

  it('schedule and flow states walk the six-state catalog and mirror both ways', async () => {
    const p = await newProject('State mirror');
    const s = await workItems.createWorkItem(actor, p.id, 'story', 'Stateful');
    const states = ['idea', 'defined', 'in_progress', 'completed', 'accepted', 'release'] as const;
    for (const st of states) {
      const u = await workItems.updateWorkItem(actor, s.id, { scheduleState: st });
      expect(u.scheduleState).toBe(st);
      expect(u.flowState).toBe(st); // mirror
    }
    // Reverse direction: setting flowState mirrors onto scheduleState.
    const rev = await workItems.updateWorkItem(actor, s.id, { flowState: 'defined' });
    expect(rev.scheduleState).toBe('defined');
  });

  it('a committed iteration does not lock scope — new items can still be assigned', async () => {
    const p = await newProject('No scope lock');
    const it = await iterations.createIteration(actor, p.id, 'Sprint 13');
    await iterations.commitIteration(actor, it.id);
    const late = await workItems.createWorkItem(actor, p.id, 'story', 'Late add');
    await workItems.updateWorkItem(actor, late.id, { iterationId: it.id });
    expect((await workItems.getWorkItem(actor.workspaceId, late.id)).iterationId).toBe(it.id);
  });
});
