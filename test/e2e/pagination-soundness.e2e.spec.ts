/**
 * Cursor-pagination soundness — walk every keyset-paginated list to the end and
 * assert the walk terminates, returns each row exactly once, and reaches the
 * whole set.
 *
 * The suite had no test that fetched a SECOND page, and that blind spot hid two
 * real defects at once:
 *
 *  - Six lists ordered ASC but sought with `lt(col, cursor)`, so page 2 re-served
 *    page 1 and nothing past the first page was reachable.
 *  - Every timestamp keyset lost precision. Postgres keeps `timestamptz` to
 *    microseconds; the pg driver hands JavaScript a millisecond `Date`. A cursor
 *    built from it is strictly smaller than the row it points at, so `>` repeats
 *    that row for ever and `<` skips every row inside the boundary millisecond.
 *
 * Both are the kind of bug that only exists on page 2, so this spec keeps a page
 * 2 permanently in the suite. Page sizes are deliberately tiny to force many
 * pages over small fixtures.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ProjectsService } from '@modules/projects';
import { WorkItemsService } from '@modules/work-items';
import { ReleasesService } from '@modules/releases';
import { IterationsService } from '@modules/iterations';
import { MilestonesService } from '@modules/milestones';
import { WorkspaceService } from '@modules/workspace';
import { decodeCursor, DRIZZLE as DRIZZLE_FOR_TEST } from '@platform';
import { sql } from 'drizzle-orm';

import { WORKSPACE_ID, adminActor, bootRovaApp, uniqueKey } from './support/flow-harness';

interface Page<T> {
  data: T[];
  pageInfo: { nextCursor: string | null; hasNextPage: boolean };
}

/** Walk a cursor-paginated endpoint to exhaustion, guarding against loops. */
async function walk<T extends { id: string }>(
  fetch: (cursor: string | null) => Promise<Page<T>>,
  label: string,
): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;

  for (;;) {
    const page: Page<T> = await fetch(cursor);
    pages++;
    ids.push(...page.data.map((r) => r.id));

    if (!page.pageInfo.hasNextPage || !page.pageInfo.nextCursor) break;
    cursor = page.pageInfo.nextCursor;
    if (seenCursors.has(cursor))
      throw new Error(`${label}: cursor repeated — walk does not advance`);
    seenCursors.add(cursor);
    if (pages > 200) throw new Error(`${label}: did not terminate after 200 pages`);
  }
  return { ids, pages };
}

function assertSound(label: string, ids: string[], expectedTotal: number) {
  const unique = new Set(ids);
  expect(unique.size, `${label}: pagination returned duplicate rows`).toBe(ids.length);
  expect(ids.length, `${label}: paginated walk lost or gained rows`).toBe(expectedTotal);
}

describe('cursor pagination walks are sound', () => {
  let app: NestFastifyApplication;
  const admin = adminActor();

  beforeAll(async () => {
    app = await bootRovaApp();
  }, 60_000);
  afterAll(async () => {
    await app?.close();
  });

  it('projects.listByWorkspace — small pages cover every project exactly once', async () => {
    const projects = app.get(ProjectsService);
    // A single "big page" is still capped by MAX_LIMIT, so it is not a total.
    // Count straight from the database instead.
    const countRes = await app
      .get(DRIZZLE_FOR_TEST)
      .execute(
        sql`select count(*)::int as total from work.projects where workspace_id = ${WORKSPACE_ID} and deleted_at is null`,
      );
    const total = Number((countRes as unknown as { rows: { total: number }[] }).rows[0].total);
    // Projects are workspace-scoped, so this walks whatever the workspace holds —
    // 3 rows on a fresh database, thousands on a long-lived dev one. Derive the
    // page size from the count so the walk always spans several pages (which is
    // the point) without becoming thousands of pages on a big database.
    const pageSize = Math.max(1, Math.ceil(total / 4));
    const { ids, pages } = await walk(
      (cursor) =>
        projects.listProjects(admin, {
          limit: pageSize,
          cursor: cursor ? decodeCursor(cursor) : null,
        }) as Promise<Page<{ id: string }>>,
      'projects',
    );
    expect(pages, 'expected more than one page to actually exercise the cursor').toBeGreaterThan(1);
    assertSound('projects', ids, Number(total));
  }, 120_000);

  it('workItems.listBacklog — small pages cover every item exactly once', async () => {
    const projects = app.get(ProjectsService);
    const workItems = app.get(WorkItemsService);
    const project = await projects.createProject(admin, { key: uniqueKey(), name: 'Paging WI' });
    for (let i = 0; i < 7; i++) {
      await workItems.createWorkItem(admin, project.id, 'story', `paged ${i}`);
    }
    const all = await workItems.listWorkItems(
      admin,
      project.id,
      {},
      {
        limit: 500,
        cursor: null,
      },
    );
    const { ids, pages } = await walk(
      (cursor) =>
        workItems.listWorkItems(
          admin,
          project.id,
          {},
          {
            limit: 2,
            cursor: cursor ? decodeCursor(cursor) : null,
          },
        ) as Promise<Page<{ id: string }>>,
      'workItems',
    );
    expect(pages).toBeGreaterThan(1);
    assertSound('workItems', ids, all.data.length);
  }, 120_000);

  it('releases.listReleases — small pages cover every release exactly once', async () => {
    const projects = app.get(ProjectsService);
    const releases = app.get(ReleasesService);
    const project = await projects.createProject(admin, { key: uniqueKey(), name: 'Paging Rel' });
    for (let i = 0; i < 7; i++) {
      await releases.createRelease(admin, project.id, `rel ${i}`, {});
    }
    const all = await releases.listReleases(admin, project.id, { limit: 500, cursor: null });
    const { ids, pages } = await walk(
      (cursor) =>
        releases.listReleases(admin, project.id, {
          limit: 2,
          cursor: cursor ? decodeCursor(cursor) : null,
        }) as Promise<Page<{ id: string }>>,
      'releases',
    );
    expect(pages).toBeGreaterThan(1);
    assertSound('releases', ids, all.data.length);
  }, 120_000);

  it('iterations.listIterations — small pages cover every iteration exactly once', async () => {
    const projects = app.get(ProjectsService);
    const iterations = app.get(IterationsService);
    const project = await projects.createProject(admin, { key: uniqueKey(), name: 'Paging Iter' });
    for (let i = 0; i < 7; i++) {
      await iterations.createIteration(admin, project.id, `iter ${i}`, {});
    }
    const all = await iterations.listIterations(
      admin,
      project.id,
      {},
      {
        limit: 500,
        cursor: null,
      },
    );
    const { ids, pages } = await walk(
      (cursor) =>
        iterations.listIterations(
          admin,
          project.id,
          {},
          {
            limit: 2,
            cursor: cursor ? decodeCursor(cursor) : null,
          },
        ) as Promise<Page<{ id: string }>>,
      'iterations',
    );
    expect(pages).toBeGreaterThan(1);
    assertSound('iterations', ids, all.data.length);
  }, 120_000);

  it('milestones.listMilestones — small pages cover every milestone exactly once', async () => {
    const projects = app.get(ProjectsService);
    const milestones = app.get(MilestonesService);
    const project = await projects.createProject(admin, { key: uniqueKey(), name: 'Paging MS' });
    for (let i = 0; i < 7; i++) {
      await milestones.createMilestone(admin, project.id, `ms ${i}`, {});
    }
    const all = await milestones.listMilestones(admin, project.id, { limit: 500, cursor: null });
    const { ids, pages } = await walk(
      (cursor) =>
        milestones.listMilestones(admin, project.id, {
          limit: 2,
          cursor: cursor ? decodeCursor(cursor) : null,
        }) as Promise<Page<{ id: string }>>,
      'milestones',
    );
    expect(pages).toBeGreaterThan(1);
    assertSound('milestones', ids, all.data.length);
  }, 120_000);

  it('workspaces.listForUser — DESC walk covers every workspace exactly once', async () => {
    const workspace = app.get(WorkspaceService);
    const all = await workspace.listWorkspacesForUser(admin.sub, { limit: 500, cursor: null });
    const { ids } = await walk(
      (cursor) =>
        workspace.listWorkspacesForUser(admin.sub, {
          limit: 1,
          cursor: cursor ? decodeCursor(cursor) : null,
        }) as Promise<Page<{ id: string }>>,
      'workspaces',
    );
    assertSound('workspaces', ids, all.data.length);
    expect(WORKSPACE_ID).toBeTruthy();
  }, 120_000);
});
