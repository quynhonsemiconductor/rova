/**
 * BA business-flow E2E — work-item hierarchy (parent_id) + relations (F6).
 *
 * Encodes the DB-design "Work item hierarchy" rules
 * (Initiative → Feature → Story → { Task, Defect }; a defect's parent is a user
 * story; a task's parent is a story or defect) and the §8.2 work_item_relations
 * rules (secondary links: blocks / duplicates / relates_to / depends_on — no
 * self-link, no duplicate in either direction, acyclic ordering, cleaned up on
 * delete). These guard the fixes from the parent/relation enforcement audit.
 *
 * Drives the REAL application services against the seeded DB.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ProjectsService } from '@modules/projects';
import { WorkItemsService } from '@modules/work-items';
import { QualityService } from '@modules/quality';

import { adminActor, bootRovaApp, uniqueKey } from './support/flow-harness';

describe('BA flows: work-item hierarchy + relations (real AppModule + seeded DB)', () => {
  let app: NestFastifyApplication;
  let projects: ProjectsService;
  let workItems: WorkItemsService;
  let quality: QualityService;
  const actor = adminActor();

  const newProject = (name: string) => projects.createProject(actor, { key: uniqueKey(), name });

  beforeAll(async () => {
    app = await bootRovaApp();
    projects = app.get(ProjectsService);
    workItems = app.get(WorkItemsService);
    quality = app.get(QualityService);
  });

  afterAll(async () => {
    await app?.close();
  });

  // ── Hierarchy: create ──────────────────────────────────────────────────────
  describe('parent hierarchy — create', () => {
    it('links a defect to its user story (parent_id) and surfaces it in the Quality grid', async () => {
      const project = await newProject('Defect Parent');
      const story = await workItems.createWorkItem(actor, project.id, 'story', 'Login story');
      const defect = await workItems.createWorkItem(actor, project.id, 'defect', 'Login bug', {
        parentId: story.id,
      });
      expect(defect.parentId).toBe(story.id);

      // The Quality grid's "User Story" column derives from parent_id.
      const { data } = await quality.getDefects(actor, project.id);
      const row = data.find((d) => d.id === defect.id);
      expect(row?.parentKey).toBe(story.itemKey);
    });

    it('rejects a defect under a non-story parent', async () => {
      const project = await newProject('Defect Bad Parent');
      // A defect's parent must be a STORY. Another defect is the available
      // non-story work item now that `feature` is not a work-item type — a Feature is
      // a portfolio item, and portfolio membership travels via feature_id, not parent_id.
      const otherDefect = await workItems.createWorkItem(actor, project.id, 'defect', 'Other bug');
      await expect(
        workItems.createWorkItem(actor, project.id, 'defect', 'Bug', { parentId: otherDefect.id }),
      ).rejects.toMatchObject({ code: 'WORK_ITEM_INVALID_PARENT_TYPE' });
    });

    it('creates a task under a story and under a defect, but not under another task', async () => {
      const project = await newProject('Task Parents');
      const story = await workItems.createWorkItem(actor, project.id, 'story', 'Story');
      const defect = await workItems.createWorkItem(actor, project.id, 'defect', 'Defect', {
        parentId: story.id,
      });

      const t1 = await workItems.createTask(actor, story.id, 'Task under story');
      const t2 = await workItems.createTask(actor, defect.id, 'Task under defect');
      expect(t1.parentId).toBe(story.id);
      expect(t2.parentId).toBe(defect.id);

      // Tasks are leaves. Previously this asserted "not under a feature"; a task is now
      // the available invalid parent, and it exercises the same rule through the
      // tasks-table fallback in findById.
      await expect(workItems.createTask(actor, t1.id, 'Bad task')).rejects.toMatchObject({
        code: 'WORK_ITEM_INVALID_PARENT_TYPE',
      });
    });

    it('rejects giving a story a parent (only tasks and defects have parents)', async () => {
      const project = await newProject('Story No Parent');
      // Any parent is invalid for a story, so the parent's own type is immaterial.
      const other = await workItems.createWorkItem(actor, project.id, 'story', 'Other story');
      await expect(
        workItems.createWorkItem(actor, project.id, 'story', 'Story', { parentId: other.id }),
      ).rejects.toMatchObject({ code: 'WORK_ITEM_INVALID_PARENT_TYPE' });
    });
  });

  // ── Hierarchy: update (audit GAP-2) ────────────────────────────────────────
  describe('parent hierarchy — update', () => {
    it('moves a defect between stories and allows clearing its parent', async () => {
      const project = await newProject('Defect Reparent');
      const storyA = await workItems.createWorkItem(actor, project.id, 'story', 'Story A');
      const storyB = await workItems.createWorkItem(actor, project.id, 'story', 'Story B');
      const defect = await workItems.createWorkItem(actor, project.id, 'defect', 'Bug', {
        parentId: storyA.id,
      });

      const moved = await workItems.updateWorkItem(actor, defect.id, { parentId: storyB.id });
      expect(moved.parentId).toBe(storyB.id);

      const cleared = await workItems.updateWorkItem(actor, defect.id, { parentId: null });
      expect(cleared.parentId ?? null).toBeNull();
    });

    it('rejects re-parenting a defect under a non-story item (update honours create rule)', async () => {
      const project = await newProject('Defect Reparent Bad');
      const story = await workItems.createWorkItem(actor, project.id, 'story', 'Story');
      const otherDefect = await workItems.createWorkItem(actor, project.id, 'defect', 'Other bug');
      const defect = await workItems.createWorkItem(actor, project.id, 'defect', 'Bug', {
        parentId: story.id,
      });
      await expect(
        workItems.updateWorkItem(actor, defect.id, { parentId: otherDefect.id }),
      ).rejects.toMatchObject({ code: 'WORK_ITEM_INVALID_PARENT_TYPE' });
    });

    it('rejects setting a parent on a story via update (portfolio hierarchy is out of Phase 1 scope)', async () => {
      const project = await newProject('Story Reparent Bad');
      const other = await workItems.createWorkItem(actor, project.id, 'story', 'Other story');
      const story = await workItems.createWorkItem(actor, project.id, 'story', 'Story');
      await expect(
        workItems.updateWorkItem(actor, story.id, { parentId: other.id }),
      ).rejects.toMatchObject({ code: 'WORK_ITEM_INVALID_PARENT_TYPE' });
    });
  });

  // ── Relations (F6) ─────────────────────────────────────────────────────────
  describe('work-item relations', () => {
    it('rejects self-links and duplicates in BOTH directions (audit GAP-7)', async () => {
      const project = await newProject('Relations Dup');
      const a = await workItems.createWorkItem(actor, project.id, 'story', 'A');
      const b = await workItems.createWorkItem(actor, project.id, 'story', 'B');

      await expect(workItems.linkWorkItem(actor, a.id, a.id, 'relates_to')).rejects.toMatchObject({
        code: 'WORK_ITEM_RELATION_SELF',
      });

      await workItems.linkWorkItem(actor, a.id, b.id, 'relates_to');
      // Exact duplicate.
      await expect(workItems.linkWorkItem(actor, a.id, b.id, 'relates_to')).rejects.toMatchObject({
        code: 'WORK_ITEM_RELATION_EXISTS',
      });
      // Reverse duplicate (B → A, same type) — now also rejected.
      await expect(workItems.linkWorkItem(actor, b.id, a.id, 'relates_to')).rejects.toMatchObject({
        code: 'WORK_ITEM_RELATION_EXISTS',
      });
    });

    it('rejects a dependency cycle that spans mixed ordering types (audit GAP-7)', async () => {
      const project = await newProject('Relations Cycle');
      const a = await workItems.createWorkItem(actor, project.id, 'story', 'A');
      const b = await workItems.createWorkItem(actor, project.id, 'story', 'B');

      await workItems.linkWorkItem(actor, a.id, b.id, 'blocks');
      // B depends_on A closes a cycle across the blocks+depends_on ordering graph.
      await expect(workItems.linkWorkItem(actor, b.id, a.id, 'depends_on')).rejects.toMatchObject({
        code: 'WORK_ITEM_RELATION_CYCLE',
      });
    });

    it('removes an item’s relations when it is deleted (audit GAP-8)', async () => {
      const project = await newProject('Relations Cleanup');
      const a = await workItems.createWorkItem(actor, project.id, 'story', 'Kept');
      const b = await workItems.createWorkItem(actor, project.id, 'story', 'Deleted');
      await workItems.linkWorkItem(actor, b.id, a.id, 'relates_to');
      expect(await workItems.listRelations(actor, a.id)).toHaveLength(1);

      await workItems.deleteWorkItem(actor, b.id);

      // The relation is gone — no dangling link surfaces on the surviving item.
      expect(await workItems.listRelations(actor, a.id)).toHaveLength(0);
    });

    it('allows a cross-project link the actor is authorized to view (audit GAP-6 — legit path preserved)', async () => {
      const projectA = await newProject('Link Src');
      const projectB = await newProject('Link Tgt');
      const src = await workItems.createWorkItem(actor, projectA.id, 'story', 'Source');
      const tgt = await workItems.createWorkItem(actor, projectB.id, 'story', 'Target');

      const rels = await workItems.linkWorkItem(actor, src.id, tgt.id, 'relates_to');
      expect(rels.some((r) => r.relatedItem.id === tgt.id)).toBe(true);
    });
  });

  // ── Task drag-to-rerank (Tasks tab) — tasks live in a separate table, so the
  //    rank endpoint must resolve task neighbours via findByIds too. ──
  describe('task reorder', () => {
    it('reranks a task between its neighbours and persists the new order', async () => {
      const project = await newProject('Task Rerank');
      const story = await workItems.createWorkItem(actor, project.id, 'story', 'Parent story');
      const t1 = await workItems.createTask(actor, story.id, 'Task 1');
      const t2 = await workItems.createTask(actor, story.id, 'Task 2');
      const t3 = await workItems.createTask(actor, story.id, 'Task 3');

      // Initial order is creation/rank order: t1, t2, t3.
      let order = (await workItems.listTasks(actor, story.id)).map((t) => t.id);
      expect(order).toEqual([t1.id, t2.id, t3.id]);

      // Drag t3 to the very top (before t1) — neighbour lookup must resolve tasks.
      await workItems.rankWorkItem(actor, t3.id, {
        projectId: project.id,
        beforeId: null,
        afterId: t1.id,
      });

      order = (await workItems.listTasks(actor, story.id)).map((t) => t.id);
      expect(order).toEqual([t3.id, t1.id, t2.id]);
    });
  });
});
