/**
 * Story hours are DERIVED from child tasks (migration 0074).
 *
 * Real SQL because the thing that broke here is invisible to the type checker. The
 * `work_items` update branch used to spread `estimateHours`/`todoHours`/`actualHours` into
 * its SET clause; once the columns were dropped that emits `set estimate_hours = …` against
 * a column that no longer exists. Drizzle's `.set()` accepts the wider object, so `tsc`
 * stayed clean and only a real query fails.
 *
 * `WorkItem` is a UNION shape — the same interface describes a Story/Defect (from
 * `work_items`) and a Task (from `tasks`) — so these tests pin both halves:
 *   • a Story reports null hours and ignores any that are sent;
 *   • a Task still round-trips its own hours, which live on `tasks`;
 *   • the Story's totals come from SUM over its tasks and move when a task changes.
 *
 * Prereqs: docker deps up + `pnpm db:migrate` (see flow-harness).
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { WorkItemsService } from '@modules/work-items';
import { ProjectsService } from '@modules/projects';
import { DRIZZLE } from '@platform';
import type { DrizzleDB } from '@platform';
import { workflowStatuses } from '@db/schema/work';

import { adminActor, bootRovaApp, uniqueKey } from './support/flow-harness';

describe('story task hours are derived (e2e)', () => {
  let app: NestFastifyApplication;
  let workItems: WorkItemsService;
  let projects: ProjectsService;
  let db: DrizzleDB;

  const admin = adminActor();
  let projectId: string;
  let statusId: string;

  beforeAll(async () => {
    app = await bootRovaApp();
    workItems = app.get(WorkItemsService);
    projects = app.get(ProjectsService);
    db = app.get<DrizzleDB>(DRIZZLE);

    const p = await projects.createProject(admin, { key: uniqueKey(), name: 'Hours Project' });
    projectId = p.id;
    const rows = await db
      .select({ id: workflowStatuses.id })
      .from(workflowStatuses)
      .where(eq(workflowStatuses.projectId, projectId))
      .limit(1);
    statusId = rows[0].id;
  });

  afterAll(async () => {
    await app?.close();
  });

  async function newStory(title = `Story ${uniqueKey()}`) {
    // Positional: (actor, projectId, type, title, opts).
    return workItems.createWorkItem(admin, projectId, 'story', title, { statusId });
  }

  /** Positional too: (actor, parentId, title, opts). */
  function newTask(
    parentId: string,
    title: string,
    hours: { estimateHours?: string; todoHours?: string; actualHours?: string },
  ) {
    return workItems.createTask(admin, parentId, title, hours);
  }

  it('the work_items table no longer carries hours columns', async () => {
    const res = await db.execute(sql`
      select count(*)::int as n
      from information_schema.columns
      where table_schema = 'work' and table_name = 'work_items'
        and column_name in ('estimate_hours', 'todo_hours', 'actual_hours')
    `);
    expect(Number(res.rows[0].n)).toBe(0);
  });

  it('a Story reports NULL hours of its own', async () => {
    const story = await newStory();
    expect(story.estimateHours).toBeNull();
    expect(story.todoHours).toBeNull();
    expect(story.actualHours).toBeNull();
  });

  it('updating a Story that carries hours does NOT hit a dropped column', async () => {
    // The regression this file exists for. Before the fix this emitted
    // `set estimate_hours = …` and failed at runtime while `tsc` stayed clean.
    const story = await newStory();
    const updated = await workItems.updateWorkItem(admin, story.id, {
      title: 'Renamed with hours attached',
      estimateHours: '5',
      todoHours: '3',
      actualHours: '1',
    });

    expect(updated.title).toBe('Renamed with hours attached');
    // Silently ignored rather than stored: a Story has nowhere to put them.
    expect(updated.estimateHours).toBeNull();
    expect(updated.todoHours).toBeNull();
  });

  it('a TASK still round-trips its own hours, which live on `tasks`', async () => {
    const story = await newStory();
    const task = await newTask(story.id, 'A task with hours', {
      estimateHours: '8',
      todoHours: '6',
      actualHours: '2',
    });

    expect(Number(task.estimateHours)).toBe(8);
    expect(Number(task.todoHours)).toBe(6);

    const edited = await workItems.updateWorkItem(admin, task.id, { todoHours: '4' });
    expect(Number(edited.todoHours)).toBe(4);
    // Untouched by an update that only mentioned To Do.
    expect(Number(edited.estimateHours)).toBe(8);
  });

  it('the Story total is the SUM of its tasks, and moves when a task changes', async () => {
    const story = await newStory();
    await newTask(story.id, 'T1', { estimateHours: '5', todoHours: '5', actualHours: '0' });
    const second = await newTask(story.id, 'T2', {
      estimateHours: '3',
      todoHours: '2',
      actualHours: '1',
    });

    let totals = await workItems.getTaskTotals(admin, story.id);
    expect(totals.taskCount).toBe(2);
    expect(totals.estimateHours).toBe(8);
    expect(totals.todoHours).toBe(7);
    expect(totals.actualHours).toBe(1);

    // Editing a task moves the Story's number — the whole point of deriving rather than
    // storing a copy that drifts.
    await workItems.updateWorkItem(admin, second.id, { todoHours: '0', actualHours: '3' });
    totals = await workItems.getTaskTotals(admin, story.id);
    expect(totals.todoHours).toBe(5);
    expect(totals.actualHours).toBe(3);
  });

  it('a Story with no tasks totals ZERO rather than null', async () => {
    // The totals row always renders, so the aggregate coalesces — distinct from a Story's
    // OWN hours, which are null because it has none.
    const story = await newStory();
    const totals = await workItems.getTaskTotals(admin, story.id);
    expect(totals.taskCount).toBe(0);
    expect(totals.estimateHours).toBe(0);
    expect(totals.todoHours).toBe(0);
  });

  it('Iteration Status and the task totals agree — one source, not two', async () => {
    // The original defect: the detail sidebar wrote stored columns while Iteration Status
    // summed the tasks, so the same Story showed two different numbers.
    const story = await newStory();
    await newTask(story.id, 'Agreeing task', {
      estimateHours: '4',
      todoHours: '4',
      actualHours: '0',
    });

    const totals = await workItems.getTaskTotals(admin, story.id);
    const res = await db.execute(sql`
      select coalesce(sum(t.todo_hours), 0)::float8 as todo
      from work.tasks t
      where t.parent_id = ${story.id} and t.deleted_at is null
    `);
    expect(totals.todoHours).toBe(Number(res.rows[0].todo));
  });
});
