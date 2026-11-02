/**
 * BA business-flow E2E — backlog list keyset pagination correctness.
 *
 * Flow: none. This is a REGRESSION spec for BL-FR-007, finer-grained than any
 * numbered flow in E2E_BUSINESS_FLOW_COVERAGE.md. Recorded explicitly so the
 * traceability matrix can distinguish "deliberately not a flow" from
 * "untraced" — the previous silence read as the latter.
 *
 * The backlog (BL-FR-007) must page through the FULL result set with no gaps
 * and no duplicates for every sortable column, not just the default rank order.
 * A prior bug always seeked by `rank` regardless of the active sort, so page 2+
 * of any non-rank sort (and even the default order) returned wrong/overlapping
 * rows once the list exceeded one page. These specs drive the REAL service
 * against the seeded DB with a tiny page size to force multi-page paging.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ProjectsService } from '@modules/projects';
import { WorkItemsService } from '@modules/work-items';
import type { WorkItemFilters } from '@modules/work-items';
import { decodeCursor } from '@platform';
import type { CursorPayload } from '@platform';

import { adminActor, bootRovaApp, uniqueKey } from './support/flow-harness';

describe('BA flow: backlog keyset pagination (real AppModule + seeded DB)', () => {
  let app: NestFastifyApplication;
  let projects: ProjectsService;
  let workItems: WorkItemsService;
  const actor = adminActor();

  // Titles intentionally NOT in insertion order, so a title sort differs from
  // the rank/created order and can only be correct if paging seeks by title.
  const storySpecs = [
    { title: 'Gamma story', storyPoints: '3.00' },
    { title: 'Alpha story', storyPoints: '8.00' },
    { title: 'Echo story', storyPoints: undefined }, // null plan estimate
    { title: 'Bravo story', storyPoints: '1.00' },
    { title: 'Foxtrot story', storyPoints: '5.00' },
    { title: 'Delta story', storyPoints: undefined }, // null plan estimate
    { title: 'Charlie story', storyPoints: '2.00' },
  ];

  let projectId: string;
  /** Created stories in insertion order (== rank ascending order). */
  let created: { id: string; title: string; storyPoints?: string }[] = [];

  /** Page through the entire backlog with a tiny page size, in order. */
  async function collectOrdered(filters: WorkItemFilters): Promise<string[]> {
    const ids: string[] = [];
    let cursor: CursorPayload | null = null;
    // Bounded loop: a paging regression that keeps re-yielding rows would trip
    // the no-duplicates / exact-count assertions rather than spin forever.
    for (let guard = 0; guard < 50; guard++) {
      const page = await workItems.listBacklog(actor, projectId, filters, { limit: 2, cursor });
      ids.push(...page.data.map((w) => w.id));
      if (!page.pageInfo.hasNextPage || !page.pageInfo.nextCursor) break;
      cursor = decodeCursor(page.pageInfo.nextCursor);
    }
    return ids;
  }

  beforeAll(async () => {
    app = await bootRovaApp();
    projects = app.get(ProjectsService);
    workItems = app.get(WorkItemsService);

    const project = await projects.createProject(actor, {
      key: uniqueKey(),
      name: 'Backlog Pagination Project',
    });
    projectId = project.id;

    created = [];
    for (const spec of storySpecs) {
      const story = await workItems.createWorkItem(actor, projectId, 'story', spec.title, {
        storyPoints: spec.storyPoints,
      });
      created.push({ id: story.id, title: spec.title, storyPoints: spec.storyPoints });
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('pages the default rank order with no gaps or duplicates', async () => {
    const ids = await collectOrdered({});

    expect(ids).toHaveLength(created.length);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    // New items append to the end of the rank order → rank asc == insertion order.
    expect(ids).toEqual(created.map((c) => c.id));
  });

  it('reports the full filtered total on every page, independent of the cursor', async () => {
    // BL-FR-007 "total đúng": the footer count is the total matching the
    // filters, not the number of rows on the current page.
    const first = await workItems.listBacklog(actor, projectId, {}, { limit: 2, cursor: null });
    expect(first.data).toHaveLength(2); // page-sized
    expect(first.pageInfo.total).toBe(created.length); // but total is the full set

    const next = decodeCursor(first.pageInfo.nextCursor!);
    const second = await workItems.listBacklog(actor, projectId, {}, { limit: 2, cursor: next });
    expect(second.pageInfo.total).toBe(created.length); // stable across pages
  });

  it('pages a title:asc sort in fully sorted order across pages', async () => {
    const ids = await collectOrdered({ sortBy: 'title', sortDirection: 'asc' });

    const expected = [...created].sort((a, b) => a.title.localeCompare(b.title)).map((c) => c.id);
    expect(ids).toHaveLength(created.length);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expected);
  });

  it('pages a title:desc sort in fully sorted order across pages', async () => {
    const ids = await collectOrdered({ sortBy: 'title', sortDirection: 'desc' });

    const expected = [...created].sort((a, b) => b.title.localeCompare(a.title)).map((c) => c.id);
    expect(ids).toHaveLength(created.length);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expected);
  });

  it('pages a nullable planEstimate:asc sort with NULLS LAST across pages', async () => {
    const ids = await collectOrdered({ sortBy: 'planEstimate', sortDirection: 'asc' });

    expect(ids).toHaveLength(created.length);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates, no dropped null rows

    const withEstimate = created
      .filter((c) => c.storyPoints !== undefined)
      .sort((a, b) => Number(a.storyPoints) - Number(b.storyPoints));
    const nullIds = new Set(created.filter((c) => c.storyPoints === undefined).map((c) => c.id));

    // Non-null estimates come first, in ascending numeric order …
    expect(ids.slice(0, withEstimate.length)).toEqual(withEstimate.map((c) => c.id));
    // … and the null-estimate rows sort last (NULLS LAST), regardless of order.
    expect(new Set(ids.slice(withEstimate.length))).toEqual(nullIds);
  });
});
