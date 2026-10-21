/**
 * Deleting a timebox UNSCHEDULES its work. It does not orphan it, and it does not delete it.
 *
 * The 2026-08-04 full-stack audit called this its highest-value fix (§1.1) and it was still open on
 * 2026-08-14: `work_items.iteration_id`, `work.tasks.iteration_id`, `work_items.release_id` and
 * `portfolio_items.release_id` carried NO foreign key, and the iteration and release delete services
 * are each a bare `repo.delete(id)` that unschedules nothing. So every scheduled item was left
 * pointing at a row that no longer existed — reachable in normal use, because an iteration in
 * `planning` legally holds items and `planning` is exactly the state the delete gate permits.
 *
 * The milestone case is included but is NOT evidence of the same bug: the repository already deletes
 * its four junction tables in code, so that test passes with or without the new constraint. It is
 * here because the association rule is worth pinning either way, and because those five statements
 * share no transaction — the CASCADE is what makes a partial failure survivable.
 *
 * Rally documents the target behaviour rather than refusing: "If you delete an iteration that
 * stories and defects are scheduled in, **they will all be updated to unscheduled**", and deleting a
 * milestone "removes the association from each work item… The work item itself is not deleted."
 * Broadcom KB 143097 exists *because* the reference is gone afterwards — you have to reconstruct the
 * affected set from Lookback `_PreviousValues`.
 *
 * WHY THIS FILE EXISTS AT ALL. The fix is a set of `ON DELETE SET NULL` / `CASCADE` keys (migration
 * 0114), which means there is no application code to unit-test: the behaviour is entirely in the
 * database, and a service spec calling `deleteIteration` against a mock would prove nothing. These
 * assertions run against the real schema, which is the only place the invariant lives.
 *
 * Driven through the SERVICES rather than raw SQL, because the point is that an ordinary delete —
 * the one a Workspace Admin performs — leaves the data in the documented state.
 */
import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { IterationsService } from '@modules/iterations';
import { MilestonesService } from '@modules/milestones';
import { PortfolioItemsService } from '@modules/portfolio';
import { ReleasesService } from '@modules/releases';
import { WorkItemsService } from '@modules/work-items';
import { DRIZZLE, type DrizzleDB } from '@platform';

import { milestoneArtifacts, tasks, workItems } from '@db/schema/work';
import { adminActor, bootRovaApp, uniqueKey } from './support/flow-harness';
import { SEED_PROJECTS } from '../../db/seeds/constants';

const NXP = SEED_PROJECTS[0].id;

describe('deleting a timebox unschedules its work (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DrizzleDB;
  let iterations: IterationsService;
  let releases: ReleasesService;
  let milestones: MilestonesService;
  let items: WorkItemsService;
  let portfolio: PortfolioItemsService;
  const admin = adminActor();

  beforeAll(async () => {
    app = await bootRovaApp();
    db = app.get<DrizzleDB>(DRIZZLE);
    iterations = app.get(IterationsService);
    releases = app.get(ReleasesService);
    milestones = app.get(MilestonesService);
    items = app.get(WorkItemsService);
    portfolio = app.get(PortfolioItemsService);
  });

  afterAll(async () => {
    await app?.close();
  });

  const rowById = async (id: string) =>
    (await db.select().from(workItems).where(eq(workItems.id, id)))[0];

  it('unschedules a Story and its Tasks when the iteration is deleted', async () => {
    // `planning` is both the state the delete gate requires AND a state that legally holds work —
    // which is precisely why the orphan was reachable rather than theoretical.
    const iteration = await iterations.createIteration(admin, NXP, `Del ${uniqueKey()}`, {
      state: 'planning',
      startDate: '2026-09-01',
      endDate: '2026-09-14',
    });
    const story = await items.createWorkItem(admin, NXP, 'story', 'Scheduled story', {
      iterationId: iteration.id,
    });
    const task = await items.createTask(admin, story.id, 'Scheduled task', {});

    // The task's iteration is a mirror of its parent's, so it starts populated too.
    expect((await rowById(story.id))?.iterationId).toBe(iteration.id);
    const taskBefore = (await db.select().from(tasks).where(eq(tasks.id, task.id)))[0];
    expect(taskBefore?.iterationId).toBe(iteration.id);

    await iterations.deleteIteration(admin, iteration.id);

    // The story SURVIVES and is unscheduled — not deleted, and not pointing at a missing row.
    const storyAfter = await rowById(story.id);
    expect(storyAfter, 'the story must survive its iteration').toBeDefined();
    expect(storyAfter?.iterationId).toBeNull();
    expect(storyAfter?.deletedAt).toBeNull();

    const taskAfter = (await db.select().from(tasks).where(eq(tasks.id, task.id)))[0];
    expect(taskAfter, 'the task must survive too').toBeDefined();
    expect(taskAfter?.iterationId).toBeNull();
  });

  it('unschedules a Story and a Feature when the release is deleted', async () => {
    const release = await releases.createRelease(admin, NXP, `Del ${uniqueKey()}`, {
      startDate: '2026-09-01',
      releaseDate: '2026-09-30',
    });
    const story = await items.createWorkItem(admin, NXP, 'story', 'Released story', {});
    await items.updateWorkItem(admin, story.id, { releaseId: release.id });

    const feature = await portfolio.createItem(admin, {
      projectId: NXP,
      type: 'feature',
      name: `Del feature ${uniqueKey()}`,
      releaseId: release.id,
    });

    expect((await rowById(story.id))?.releaseId).toBe(release.id);

    await releases.deleteRelease(admin, release.id);

    const storyAfter = await rowById(story.id);
    expect(storyAfter, 'the story must survive its release').toBeDefined();
    expect(storyAfter?.releaseId).toBeNull();

    // Portfolio items are scheduled into a release too, and were orphaned by the same gap.
    const featureAfter = await portfolio.getItem(admin, feature.id);
    expect(featureAfter.releaseId).toBeNull();
  });

  it('removes a Milestone’s artifact links without deleting the artifacts', async () => {
    const milestone = await milestones.createMilestone(admin, NXP, `Del ms ${uniqueKey()}`, {
      targetEndDate: '2026-09-30',
    });
    const story = await items.createWorkItem(admin, NXP, 'story', 'Milestone story', {});
    await items.setWorkItemMilestones(admin, story.id, [milestone.id]);

    expect(
      await db
        .select()
        .from(milestoneArtifacts)
        .where(eq(milestoneArtifacts.milestoneId, milestone.id)),
    ).toHaveLength(1);

    await milestones.deleteMilestone(admin, milestone.id);

    // The ASSOCIATION goes — cascade, because `milestone_id` is part of the link table's primary key
    // and a row with no milestone cannot exist.
    expect(
      await db
        .select()
        .from(milestoneArtifacts)
        .where(eq(milestoneArtifacts.milestoneId, milestone.id)),
    ).toHaveLength(0);

    // …and the artifact does NOT.
    const storyAfter = await rowById(story.id);
    expect(storyAfter, 'the story must survive its milestone').toBeDefined();
    expect(storyAfter?.deletedAt).toBeNull();
  });

  it('leaves no dangling scheduling reference anywhere in the workspace', async () => {
    /**
     * The invariant itself, asserted over the whole table rather than over rows this file created.
     *
     * Worth having in addition to the cases above: those prove the three delete paths, while this
     * would also catch a NEW writer — a seed, a migration, a raw `UPDATE` — introducing a reference
     * the keys were supposed to make impossible. It is cheap, and it is the assertion that fails if
     * someone drops a constraint to "fix" a deadlock.
     */
    // Counted in SQL, because the join is the question: an item whose iteration_id does not resolve.
    const orphans = await db.execute<{ what: string; n: number }>(`
      select 'work_items.iteration_id' as what, count(*)::int as n
        from work.work_items w
       where w.iteration_id is not null
         and not exists (select 1 from work.iterations i where i.id = w.iteration_id)
      union all
      select 'tasks.iteration_id', count(*)::int
        from work.tasks t
       where t.iteration_id is not null
         and not exists (select 1 from work.iterations i where i.id = t.iteration_id)
      union all
      select 'work_items.release_id', count(*)::int
        from work.work_items w
       where w.release_id is not null
         and not exists (select 1 from work.releases r where r.id = w.release_id)
      union all
      select 'portfolio_items.release_id', count(*)::int
        from work.portfolio_items p
       where p.release_id is not null
         and not exists (select 1 from work.releases r where r.id = p.release_id)
      union all
      select 'milestone_artifacts.milestone_id', count(*)::int
        from work.milestone_artifacts m
       where not exists (select 1 from work.milestones x where x.id = m.milestone_id)
    `);

    const rows = (Array.isArray(orphans) ? orphans : (orphans as { rows?: unknown[] }).rows) as
      Array<{ what: string; n: number }> | undefined;
    for (const row of rows ?? []) {
      expect(row.n, `${row.what} has ${row.n} dangling reference(s)`).toBe(0);
    }
    expect(rows?.length, 'the orphan query returned nothing — it is broken, not clean').toBe(5);
  });
});
