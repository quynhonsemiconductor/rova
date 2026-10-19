/**
 * The two Artifacts tabs, over REAL HTTP.
 *
 * Both were filed as read-only viewers (`GAP-P3-MS-001`, `GAP-P3-REL-002`, still open P0s on the BA's
 * branch). Wiring the add/remove controls uncovered that neither tab could DISPLAY anything either,
 * and both faults are invisible from a service-level spec:
 *
 *   • `GET /releases/:id/artifacts` reused `ReleaseQueryDto`, so `projectId` was REQUIRED on a route
 *     whose release is already named by the path. The global `ZodValidationPipe` runs before the
 *     handler, so every request the SPA ever sent (`?limit=…&q=…`) came back 400 — and the tab's
 *     error branch is its empty state, which reads as "this release has no artifacts".
 *   • `GET /milestones/:id/artifacts` answered with link IDS while the tab read `{ data, pageInfo }`,
 *     so both were `undefined` and the seeded `MS-1` — which has had a linked story since the fixture
 *     was written — rendered "No artifacts linked to this milestone". The dashboard rows now come
 *     from `:id/artifacts/items`.
 *
 * A spec that calls `ReleasesService.listReleaseArtifacts` directly passes in both cases, because it
 * never builds a query DTO. This one drives `app.inject()`, for the same reason
 * `task-routes.e2e.spec.ts` and `report-authz.e2e.spec.ts` do.
 *
 * Read-only against the fixture: it creates nothing and writes nothing, so it adds no `createProject`
 * to the count `test/e2e-fixtures.ratchet.spec.ts` caps.
 */
import 'reflect-metadata';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../apps/api/src/app.module';
import { NXP_MILESTONE_1_ID, NXP_RELEASE_1_ID, NXP_STORY_1_ID } from '../../db/seeds/constants';
import { signIn } from './support/session';

// No `/v1` prefix: `Test.createTestingModule` builds the app without the bootstrap that sets the
// global prefix, so routes are mounted bare here.
describe('Release and Milestone Artifacts tabs (e2e)', () => {
  let app: NestFastifyApplication;
  let token: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    // The session cookie from test-login; this app has no CSRF hook (that is `bootstrapApp`'s), so no CSRF dance.
    token = await signIn(app, 'admin@qnsc.dev');
  });

  afterAll(async () => {
    await app?.close();
  });

  function get(url: string) {
    return app.inject({ method: 'GET', url, headers: { cookie: token } });
  }

  type ArtifactPage = {
    data: Array<{ id: string; itemKey: string; assigneeName: string | null }>;
    pageInfo: { total?: number };
  };

  it('serves Release artifacts for the query the SPA actually sends', async () => {
    // Exactly the SPA's shape: a limit and a search term, no projectId. This was a 400.
    const res = await get(`/releases/${NXP_RELEASE_1_ID}/artifacts?limit=50`);
    expect(res.statusCode).toBe(200);

    const page = res.json<ArtifactPage>();
    expect(page.data.length).toBeGreaterThan(0);
    // The shared table renders an Owner column; the feed has to fill it (P3-REL-FR-032, Backlog
    // presentation). It served `assigneeId` only, so the column was blank for every row.
    expect(page.data.some((r) => r.assigneeName !== null)).toBe(true);
  });

  it('filters Release artifacts by the search term the toolbar sends', async () => {
    const all = (
      await get(`/releases/${NXP_RELEASE_1_ID}/artifacts?limit=50`)
    ).json<ArtifactPage>();
    const first = all.data[0];

    const hit = (
      await get(`/releases/${NXP_RELEASE_1_ID}/artifacts?limit=50&q=${first.itemKey}`)
    ).json<ArtifactPage>();
    expect(hit.data.map((r) => r.id)).toContain(first.id);

    // `q` used to be accepted and dropped, so the search box moved nothing.
    const miss = (
      await get(`/releases/${NXP_RELEASE_1_ID}/artifacts?limit=50&q=zzz-no-such-artifact`)
    ).json<ArtifactPage>();
    expect(miss.data).toHaveLength(0);
  });

  it('serves Milestone artifacts as dashboard ROWS, and the link list as ids', async () => {
    const rows = await get(`/milestones/${NXP_MILESTONE_1_ID}/artifacts/items?limit=50`);
    expect(rows.statusCode).toBe(200);
    const page = rows.json<ArtifactPage>();
    // `MS-1` is seeded with `US-1` assigned; the tab showed its empty state regardless.
    expect(page.data.map((r) => r.id)).toContain(NXP_STORY_1_ID);
    expect(page.pageInfo.total).toBeGreaterThan(0);

    // The id list is the picker's baseline and the shape `PUT :id/artifacts` takes back — kept as a
    // separate resource precisely so one route never serves two shapes again.
    const ids = await get(`/milestones/${NXP_MILESTONE_1_ID}/artifacts`);
    expect(ids.statusCode).toBe(200);
    expect(ids.json<string[]>()).toContain(NXP_STORY_1_ID);
  });
});
