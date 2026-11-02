/**
 * Quality/Defects list paging.
 *
 * This route had NO automated coverage of any kind, which is how it shipped silently truncated:
 * `DefectQuerySchema` extends `PageQuerySchema`, whose `limit` defaults to 50, the client never sent
 * an offset, and nothing returned a total — so a project with 60 defects served 50 rows that read as
 * the whole list. A grid that lies by omission passes every test that only checks the rows it
 * returned, which is exactly what happened.
 *
 * So these assert the three facts a pager depends on, at the service layer where the window is
 * applied:
 *
 *   1. `total` counts the rows matching the FILTERS, not the page — otherwise "of N" is a lie.
 *   2. `offset` genuinely skips, and page 2 is disjoint from page 1.
 *   3. `total` is invariant across pages, so the footer does not renumber itself as you walk.
 *
 * `metrics` is deliberately NOT asserted against `total`: it is computed over every defect in the
 * project regardless of filters, so the two answer different questions and must be allowed to
 * differ. Conflating them is the mistake this spec exists to prevent.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { QualityService } from '@modules/quality';
import { WorkItemsService } from '@modules/work-items';

import { SEEDED, adminActor, bootRovaApp, uniqueKey } from './support/flow-harness';

describe('Quality defects: server-side paging', () => {
  let app: NestFastifyApplication;
  let quality: QualityService;
  let workItems: WorkItemsService;

  const admin = adminActor();
  const projectId = SEEDED.nxp.projectId;
  /** Enough to page at 2 and still have a third page's worth of headroom. */
  const CREATED = 5;
  const marker = uniqueKey('PAGE');

  beforeAll(async () => {
    app = await bootRovaApp();
    quality = app.get(QualityService);
    workItems = app.get(WorkItemsService);

    // Own defects, titled with a unique marker, so `search` isolates this test from the seed's
    // defects and from anything another spec left behind.
    for (let i = 0; i < CREATED; i += 1) {
      await workItems.createWorkItem(admin, projectId, 'defect', `${marker} defect ${i + 1}`, {
        severity: 'minor',
      });
    }
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('reports the filtered total, not the page size', async () => {
    const page = await quality.getDefects(admin, projectId, { search: marker, limit: 2 });

    expect(page.data).toHaveLength(2);
    // The count must see past the window it was asked for.
    expect(page.total).toBe(CREATED);
  });

  it('skips rows with offset, and page 2 is disjoint from page 1', async () => {
    const first = await quality.getDefects(admin, projectId, {
      search: marker,
      limit: 2,
      offset: 0,
    });
    const second = await quality.getDefects(admin, projectId, {
      search: marker,
      limit: 2,
      offset: 2,
    });

    const firstIds = first.data.map((d) => d.id);
    const secondIds = second.data.map((d) => d.id);

    expect(secondIds).toHaveLength(2);
    // Disjoint, not merely different: a mis-applied offset (say, applied twice or ignored) would
    // still change the rows without partitioning them.
    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
    // And the total does not move as you walk, or the footer renumbers itself mid-read.
    expect(second.total).toBe(first.total);
  });

  it('returns a short last page without shrinking the total', async () => {
    const last = await quality.getDefects(admin, projectId, {
      search: marker,
      limit: 2,
      offset: 4,
    });

    expect(last.data).toHaveLength(CREATED - 4);
    expect(last.total).toBe(CREATED);
  });
});
