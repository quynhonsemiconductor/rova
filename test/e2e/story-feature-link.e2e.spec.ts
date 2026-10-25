/**
 * Linking a Story to a Feature — real SQL.
 *
 * `work_items.feature_id` is what EVERY portfolio rollup and capacity metric aggregates by, and
 * until this slice only the demo seed could set it: readable through the Iteration Status read
 * model, writable nowhere. Real rollups were therefore only ever demonstrable on seeded data.
 *
 * Real SQL because the point is that the rollups MOVE. A mocked repository can prove the column
 * was written; only the database can prove that writing it changes what the Portfolio page reports.
 *
 * Prereqs: docker deps up + `pnpm db:migrate` (see flow-harness).
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { PortfolioItemsService } from '@modules/portfolio';
import { ProjectsService } from '@modules/projects';
import { WorkItemsService } from '@modules/work-items';
import { DRIZZLE } from '@platform';
import type { DrizzleDB } from '@platform';
import { workflowStatuses } from '@db/schema/work';

import { adminActor, bootRovaApp, uniqueKey } from './support/flow-harness';

describe('story → feature link (e2e)', () => {
  let app: NestFastifyApplication;
  let workItems: WorkItemsService;
  let portfolio: PortfolioItemsService;
  let projects: ProjectsService;
  let db: DrizzleDB;

  const admin = adminActor();
  let projectId: string;
  let otherProjectId: string;
  let statusId: string;

  async function newStory(points = '5') {
    return workItems.createWorkItem(admin, projectId, 'story', `S ${uniqueKey()}`, {
      statusId,
      storyPoints: points,
    });
  }

  async function newFeature(project = projectId) {
    return portfolio.createItem(admin, {
      projectId: project,
      type: 'feature',
      name: `FE ${uniqueKey()}`,
      preliminaryEstimate: 'm',
    });
  }

  beforeAll(async () => {
    app = await bootRovaApp();
    workItems = app.get(WorkItemsService);
    portfolio = app.get(PortfolioItemsService);
    projects = app.get(ProjectsService);
    db = app.get<DrizzleDB>(DRIZZLE);

    const project = await projects.createProject(admin, { key: uniqueKey(), name: 'Link Project' });
    projectId = project.id;
    const other = await projects.createProject(admin, { key: uniqueKey(), name: 'Link Portfolio' });
    otherProjectId = other.id;

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

  it('links, reports the link back, and unlinks', async () => {
    const feature = await newFeature();
    const story = await newStory();
    expect(story.featureId).toBeNull();

    const linked = await workItems.updateWorkItem(admin, story.id, { featureId: feature.id });
    expect(linked.featureId).toBe(feature.id);

    const unlinked = await workItems.updateWorkItem(admin, story.id, { featureId: null });
    expect(unlinked.featureId).toBeNull();
  });

  it('MOVES the portfolio rollup — the reason this field exists', async () => {
    // The whole point. Before this slice the only way to make a Feature report a rollup was to
    // seed one.
    const feature = await newFeature();
    const before = await portfolio.getItem(admin, feature.id);
    expect(before.rollup.rollupPoints).toBe(0);
    expect(before.progress.percentDoneByPlanEstimate).toBeNull();

    const story = await newStory('8');
    await workItems.updateWorkItem(admin, story.id, { featureId: feature.id });

    const after = await portfolio.getItem(admin, feature.id);
    expect(after.rollup.rollupPoints).toBe(8);
    expect(after.rollup.rollupCount).toBe(1);
    // Nothing accepted yet, so Percent Done is a real 0 rather than "not measurable".
    expect(after.progress.percentDoneByPlanEstimate).toBe(0);
  });

  it('counts an ACCEPTED story toward Percent Done', async () => {
    const feature = await newFeature();
    const story = await newStory('10');
    await workItems.updateWorkItem(admin, story.id, {
      featureId: feature.id,
      scheduleState: 'accepted',
    });

    const item = await portfolio.getItem(admin, feature.id);
    expect(item.rollup.acceptedPoints).toBe(10);
    expect(item.progress.percentDoneByPlanEstimate).toBe(1);
  });

  it('rolls a linked Feature up to its EPIC', async () => {
    // Rally attaches stories to the lowest level and the Epic counts them through its Features —
    // which is exactly why linking a story straight to an Epic is refused.
    const epic = await portfolio.createItem(admin, {
      projectId,
      type: 'epic',
      name: `EP ${uniqueKey()}`,
      preliminaryEstimate: 'l',
    });
    const feature = await portfolio.createItem(admin, {
      projectId,
      type: 'feature',
      name: `FE ${uniqueKey()}`,
      preliminaryEstimate: 'm',
      parentId: epic.id,
    });
    const story = await newStory('13');
    await workItems.updateWorkItem(admin, story.id, { featureId: feature.id });

    const rolled = await portfolio.getItem(admin, epic.id);
    expect(rolled.rollup.rollupPoints).toBe(13);
  });

  it('shows the story on the Feature’s Children tab', async () => {
    const feature = await newFeature();
    const story = await newStory('3');
    await workItems.updateWorkItem(admin, story.id, { featureId: feature.id });

    const children = await portfolio.listChildren(admin, feature.id, { limit: 20, cursor: null });
    expect(children.data.map((c) => c.itemKey)).toContain(story.itemKey);
  });

  it('allows a Feature in ANOTHER project', async () => {
    // Rally lets a team project's Story roll up to a portfolio project's Feature, and the portfolio
    // rollup matches on `feature_id` alone — the project+release filter is Rally's CAPACITY rule.
    const feature = await newFeature(otherProjectId);
    const story = await newStory('5');

    await workItems.updateWorkItem(admin, story.id, { featureId: feature.id });

    expect((await portfolio.getItem(admin, feature.id)).rollup.rollupPoints).toBe(5);
  });

  it('refuses an EPIC, an ARCHIVED Feature, and an unknown id', async () => {
    const story = await newStory();
    const epic = await portfolio.createItem(admin, {
      projectId,
      type: 'epic',
      name: `EP ${uniqueKey()}`,
      preliminaryEstimate: 'l',
    });
    await expect(
      workItems.updateWorkItem(admin, story.id, { featureId: epic.id }),
    ).rejects.toMatchObject({ code: 'WORK_ITEM_FEATURE_LINK_NOT_FEATURE' });

    const archived = await newFeature();
    await portfolio.setArchived(admin, archived.id, true);
    await expect(
      workItems.updateWorkItem(admin, story.id, { featureId: archived.id }),
    ).rejects.toMatchObject({ code: 'WORK_ITEM_FEATURE_LINK_ARCHIVED' });

    await expect(
      workItems.updateWorkItem(admin, story.id, {
        featureId: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toMatchObject({ code: 'PORTFOLIO_ITEM_NOT_FOUND' });
  });

  it('refuses a TASK, which inherits the link from its work product', async () => {
    const feature = await newFeature();
    const story = await newStory();
    const task = await workItems.createTask(admin, story.id, `T ${uniqueKey()}`, {});

    await expect(
      workItems.updateWorkItem(admin, task.id, { featureId: feature.id }),
    ).rejects.toMatchObject({ code: 'WORK_ITEM_FEATURE_LINK_NOT_ALLOWED' });
  });

  it('records the link in the activity log', async () => {
    const feature = await newFeature();
    const story = await newStory();
    await workItems.updateWorkItem(admin, story.id, { featureId: feature.id });

    const activity = await workItems.getActivity(admin, story.id, { limit: 50, offset: 0 });
    expect(activity.items.map((entry) => entry.changes?.field)).toContain('featureId');
  });
});
