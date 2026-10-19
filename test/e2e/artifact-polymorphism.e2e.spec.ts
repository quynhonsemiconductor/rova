/**
 * Two P0s of one shape: a relationship whose two ends are written by different surfaces and read
 * back by only one of them, over REAL HTTP.
 *
 *   • `GAP-P3-REL-002` — a release's artifacts live in TWO tables. `work_items.release_id` was read;
 *     `portfolio_items.release_id`, which the Portfolio Feature detail writes, was not. So a Feature
 *     assigned to a release showed the release on the Feature, survived a reload, and the release's
 *     own Artifacts tab reported `0 items`.
 *   • `GAP-P3-MS-002` — `milestone_artifacts` has been polymorphic on `(entity_type, entity_id)`
 *     since migration 0084 and the Feature/Epic detail rail writes `'portfolio_item'` rows. The
 *     milestone feed hardcoded `'work_item'`: two writers, one reader. Its inherited half was missing
 *     as well — a Feature or Epic on a milestone brings its leaf Stories/Defects into the milestone's
 *     display scope, once, without duplicate counting.
 *
 * WHY THIS IS AN E2E AND NOT A SERVICE SPEC. Both faults are in SQL that a mocked `db` cannot
 * execute, and both routes are gated: `release:view` and `milestone:view` are codes an Editor
 * deliberately does not hold (§3.2 marks the whole Timeboxes surface Hidden for one), so the read now
 * discloses `portfolio_items` fields through routes whose audience has to be checked rather than
 * assumed. Every role holding either code also holds `portfolio:view` (`db/permissions.catalog.ts`),
 * which is what makes the widened read safe — and the negative case below is what proves the audience
 * did not widen with the population. `task-routes.e2e.spec.ts` and `report-authz.e2e.spec.ts` are the
 * same shape for the same reason.
 *
 * The release half needs NO fixture write: the seed has assigned `FE-1` to `RE-1` since it was
 * written, so every environment has been displaying the fault. The milestone half links `EP-1` to
 * `MS-1` through the real Portfolio write path and puts it back afterwards, so the spec creates no
 * project and leaves the fixture as it found it.
 */
import 'reflect-metadata';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../apps/api/src/app.module';
import {
  NXP_DEFECT_1_ID,
  NXP_EPIC_1_ID,
  NXP_FEATURE_1_ID,
  NXP_MILESTONE_1_ID,
  NXP_RELEASE_1_ID,
  NXP_STORY_1_ID,
} from '../../db/seeds/constants';
import { signIn } from './support/session';

// No `/v1` prefix: `Test.createTestingModule` builds the app without the bootstrap that sets the
// global prefix, so routes are mounted bare here.
describe('polymorphic artifact feeds (e2e)', () => {
  let app: NestFastifyApplication;
  let admin: string;
  let editor: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    // The session cookie from test-login; this app has no CSRF hook (that is `bootstrapApp`'s), so no CSRF dance.
    admin = await signIn(app, 'admin@qnsc.dev');
    editor = await signIn(app, 'dev@qnsc.dev');
  });

  afterAll(async () => {
    // Leave the fixture as it was found: this milestone owns no portfolio artifact in the seed.
    await patch(`/portfolio-items/${NXP_EPIC_1_ID}`, { milestoneIds: [] });
    await app?.close();
  });

  function get(url: string, token = admin) {
    return app.inject({ method: 'GET', url, headers: { cookie: token } });
  }

  function patch(url: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'PATCH',
      url,
      headers: { cookie: admin },
      payload,
    });
  }

  type ArtifactPage = {
    data: Array<{
      id: string;
      itemKey: string;
      type: string;
      scheduleState: string;
      priority: string;
      storyPoints: number | null;
      assigneeName: string | null;
    }>;
    pageInfo: { total?: number; hasNextPage: boolean; nextCursor: string | null };
  };

  // ── Release Artifacts (GAP-P3-REL-002) ──────────────────────────────────────

  it('serves a directly assigned FEATURE among a release’s artifacts', async () => {
    const res = await get(`/releases/${NXP_RELEASE_1_ID}/artifacts?limit=50`);
    expect(res.statusCode, res.body).toBe(200);

    const page = res.json<ArtifactPage>();
    const feature = page.data.find((r) => r.id === NXP_FEATURE_1_ID);
    expect(feature, 'FE-1 is seeded into RE-1 and was absent from this feed').toBeDefined();
    expect(feature!.type).toBe('feature');
    // The Story half is untouched: this is a widened population, not a replaced one.
    expect(page.data.map((r) => r.id)).toContain(NXP_STORY_1_ID);
    // The footer count is the UNION's, which is what read `0 items`.
    expect(page.pageInfo.total).toBe(page.data.length);
  });

  it('reports a Feature’s Schedule State, priority and points as ABSENT, never as a value', async () => {
    const page = (
      await get(`/releases/${NXP_RELEASE_1_ID}/artifacts?limit=50`)
    ).json<ArtifactPage>();
    const feature = page.data.find((r) => r.id === NXP_FEATURE_1_ID)!;
    // A Feature's `state` is a different axis from a Story's Schedule State and there is no priority
    // column at all, so `''` — not a member of either enum, so nothing can read it as a value. Points
    // are null because a portfolio forecast is a TIERED top-down estimate, not a leaf Plan Estimate.
    expect(feature.scheduleState).toBe('');
    expect(feature.priority).toBe('');
    expect(feature.storyPoints).toBeNull();
    // The Owner column is filled from `owner_id`, that table's name for the same column.
    expect(feature.assigneeName).not.toBeNull();
  });

  it('honours the toolbar’s search term on the portfolio branch too', async () => {
    const hit = (
      await get(`/releases/${NXP_RELEASE_1_ID}/artifacts?limit=50&q=FE-1`)
    ).json<ArtifactPage>();
    expect(hit.data.map((r) => r.id)).toEqual([NXP_FEATURE_1_ID]);
    expect(hit.pageInfo.total).toBe(1);
  });

  // ── Milestone Artifacts (GAP-P3-MS-002) ─────────────────────────────────────

  it('serves a directly assigned EPIC and its inherited descendants exactly once', async () => {
    // The real write path: the Feature/Epic detail rail's Milestone multi-select (P5 §5.1/§11.4),
    // which writes `entity_type = 'portfolio_item'` — the kind this feed could not see.
    const write = await patch(`/portfolio-items/${NXP_EPIC_1_ID}`, {
      milestoneIds: [NXP_MILESTONE_1_ID],
    });
    expect(write.statusCode, write.body).toBe(200);

    const page = (
      await get(`/milestones/${NXP_MILESTONE_1_ID}/artifacts/items?limit=50`)
    ).json<ArtifactPage>();
    const ids = page.data.map((r) => r.id);

    // Direct: the Epic itself.
    expect(ids).toContain(NXP_EPIC_1_ID);
    // Inherited, two levels: EP-1 → its child Features → their leaf Stories/Defects. A work item
    // never names an Epic, so the Epic is reached through its Features — the same predicate shape the
    // portfolio rollups use, which is what keeps the two describing the same children.
    expect(ids).toContain(NXP_DEFECT_1_ID);
    // ONCE, not twice: `US-1` is BOTH a direct work-item link (seeded) and a descendant of FE-1. The
    // work-item branch is one scan whose predicate is `direct OR inherited`, so a duplicate row — and
    // a double count — is structurally impossible rather than de-duplicated afterwards.
    expect(ids.filter((id) => id === NXP_STORY_1_ID)).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
    expect(page.pageInfo.total).toBe(page.data.length);
  });

  it('keeps the picker’s baseline to DIRECT work-item links, so no descendant is promoted', async () => {
    // `GET :id/artifacts` feeds the §5.2 replace-SET picker. If the polymorphic and inherited rows
    // reached it, the next save would post a Feature's id as a `workItemId` and turn an inherited
    // descendant into a direct assignment nobody made — which is the reason the inherited set is
    // computed on read and never materialised into link rows.
    const ids = (await get(`/milestones/${NXP_MILESTONE_1_ID}/artifacts`)).json<string[]>();
    expect(ids).toContain(NXP_STORY_1_ID);
    expect(ids).not.toContain(NXP_EPIC_1_ID);
    expect(ids).not.toContain(NXP_DEFECT_1_ID);
  });

  it('pages the UNION coherently — no row lost or repeated across a boundary', async () => {
    const all = (
      await get(`/milestones/${NXP_MILESTONE_1_ID}/artifacts/items?limit=50`)
    ).json<ArtifactPage>();
    expect(all.data.length).toBeGreaterThan(2);

    // A limit of 1 forces a cursor walk whose rows alternate between the two tables. The keyset
    // boundary is resolved IN the database from whichever table holds the cursor's row, because a
    // `timestamptz` is microseconds while the `Date` a driver hands back is milliseconds — a
    // round-tripped boundary would skip every row inside that millisecond.
    const walked: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < all.data.length + 2; i += 1) {
      const url = `/milestones/${NXP_MILESTONE_1_ID}/artifacts/items?limit=1${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      }`;
      const pageRes: ArtifactPage = (await get(url)).json<ArtifactPage>();
      walked.push(...pageRes.data.map((r) => r.id));
      if (!pageRes.pageInfo.hasNextPage || !pageRes.pageInfo.nextCursor) break;
      cursor = pageRes.pageInfo.nextCursor;
    }

    expect(walked).toEqual(all.data.map((r) => r.id));
    expect(new Set(walked).size).toBe(walked.length);
  });

  // ── The audience did not widen with the population ──────────────────────────

  it('still refuses both feeds to an Editor, who holds neither view code', async () => {
    // §3.2 marks `Plan > Timeboxes` — Iterations, Releases and Milestones alike — Hidden for an
    // Editor, so `PROJECT_MEMBER` holds neither `release:view` nor `milestone:view`. That matters
    // more now than it did: these feeds disclose `portfolio_items` fields, and `portfolio:view` is
    // the code an Editor is deliberately denied. Every role that CAN reach these routes holds it.
    const release = await get(`/releases/${NXP_RELEASE_1_ID}/artifacts?limit=50`, editor);
    expect(release.statusCode, release.body).toBe(403);
    const milestone = await get(
      `/milestones/${NXP_MILESTONE_1_ID}/artifacts/items?limit=50`,
      editor,
    );
    expect(milestone.statusCode, milestone.body).toBe(403);
  });
});
