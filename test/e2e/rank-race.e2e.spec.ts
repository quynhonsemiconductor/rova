/**
 * Rank integrity E2E — a rank must be unique within its scope, always.
 *
 * `rank` is a LexoRank ordering items within ONE scope: the top-level items of a
 * project, or the children of one parent. The same value in two different scopes
 * is correct and expected. Two items sharing a rank inside one scope is not —
 * `between(low, high)` throws when low >= high, so drag-reorder fails outright,
 * and the visible order becomes arbitrary rather than meaningful.
 *
 * Two ways that invariant used to break, both covered here:
 *
 *  1. Concurrent creates. Rank was derived on the pool connection before the
 *     insert transaction opened, with no lock, so simultaneous creates in one
 *     scope read the same max and derived the same rank. Without the fix this
 *     spec sees 2 distinct ranks out of 12.
 *
 *  2. Re-parenting. Moving an item to another parent (or to top level) changes
 *     its scope, and the old rank travelled with it — landing on whatever the
 *     destination's first item already held.
 *
 * Prereqs: docker deps up + `pnpm db:migrate` (see flow-harness).
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ProjectsService } from '@modules/projects';
import { WorkItemsService } from '@modules/work-items';

import { adminActor, bootRovaApp, uniqueKey } from './support/flow-harness';

describe('rank integrity', () => {
  let app: NestFastifyApplication;
  let projects: ProjectsService;
  let workItems: WorkItemsService;
  const admin = adminActor();

  beforeAll(async () => {
    app = await bootRovaApp();
    projects = app.get(ProjectsService);
    workItems = app.get(WorkItemsService);
  });

  afterAll(async () => {
    await app?.close();
  });

  const newProject = (name: string) => projects.createProject(admin, { key: uniqueKey(), name });

  it('gives concurrent creates in one scope distinct ranks', async () => {
    const project = await newProject('Rank race');

    const created = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        workItems.createWorkItem(admin, project.id, i % 2 ? 'defect' : 'story', `concurrent ${i}`),
      ),
    );

    const ranks = created.map((w) => w.rank);
    expect(new Set(ranks).size, `ranks were not unique: ${ranks.join(', ')}`).toBe(ranks.length);
  });

  it('re-ranks an item into its destination scope when it is re-parented', async () => {
    const project = await newProject('Rank reparent');
    const storyA = await workItems.createWorkItem(admin, project.id, 'story', 'Story A');
    const storyB = await workItems.createWorkItem(admin, project.id, 'story', 'Story B');
    const defect = await workItems.createWorkItem(admin, project.id, 'defect', 'Bug', {
      parentId: storyA.id,
    });

    // First child of story A — the same rank story A itself holds at top level,
    // which is fine while the scopes differ.
    expect(defect.parentId).toBe(storyA.id);

    const movedToB = await workItems.updateWorkItem(admin, defect.id, { parentId: storyB.id });
    expect(movedToB.parentId).toBe(storyB.id);

    // Back to top level: the destination already contains storyA and storyB, so
    // keeping the old rank would collide with storyA's.
    const cleared = await workItems.updateWorkItem(admin, defect.id, { parentId: null });
    expect(cleared.parentId ?? null).toBeNull();

    const topLevel = [storyA.rank, storyB.rank, cleared.rank];
    expect(new Set(topLevel).size, `top-level ranks collided: ${topLevel.join(', ')}`).toBe(3);
  });
});
