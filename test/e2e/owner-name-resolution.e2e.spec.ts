/**
 * AN OWNER'S NAME IS A PROPERTY OF THE ROW, not of the picker feed the reader can see.
 *
 * Reported 2026-08-22: an Editor saw `No Entry` / `Unassigned` in the Owner and Dev Owner columns of
 * Iteration Status for items that WERE assigned — the detail page showed them, and a Workspace Admin
 * saw them everywhere. Not a permission fault: the grids held ids only and resolved the name client
 * side from a PICKER feed, and every picker feed narrows deliberately.
 *
 *   • `GET /projects/:id/member-options` excludes Workspace Admins — AC-16, they are not assignable
 *     owners — so it can never name one, for ANY role.
 *   • `GET /workspaces/:id/member-options` narrows a non-admin caller to the members and the
 *     `lead_id`s of their own readable projects.
 *
 * A Workspace Admin holds no `work.project_members` row at all (§2.1, migration 0118), so an item they
 * own had no name source in either feed, and an absent name is indistinguishable from an unset field.
 * A Workspace Admin reader never noticed because `listReadableProjectIds` returns `null` — unrestricted
 * — so their directory is the whole workspace.
 *
 * The read models now join the name (`ownerNameJoins`, and the iteration-status projection), which is
 * what Portfolio, Releases, Milestones and Quality already did. These tests assert it over real HTTP
 * for the EDITOR, because the fault only appeared for a narrowed principal — a service-level test with
 * the feeds mocked cannot see it at all.
 */
import 'reflect-metadata';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../apps/api/src/app.module';
import {
  ADMIN_USER_ID,
  TEAM_BETA_ID,
  NXP_ITER_CURRENT_ID,
  SEED_PROJECTS,
  TEAM_ALPHA_ID,
} from '../../db/seeds/constants';
import { signIn } from './support/session';

const NXP = SEED_PROJECTS[0].id;

/** `app.inject().json()` is `any`; a typed local keeps the assertions off an unsafe value. */
const userIdsOf = (body: unknown): string[] =>
  (body as Array<{ userId: string }>).map((m) => m.userId);

interface OwnedRow {
  id: string;
  itemKey: string;
  assigneeId: string | null;
  assigneeName: string | null;
  devOwnerId: string | null;
  devOwnerName: string | null;
}

describe('owner names come from the row, not from a picker feed', () => {
  let app: NestFastifyApplication;
  let adminToken: string;
  let editorToken: string;
  let storyKey: string;
  let storyId: string;

  const as = (
    token: string,
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: Record<string, unknown>,
  ) => app.inject({ method, url, headers: { cookie: token }, payload });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    adminToken = await signIn(app, 'admin@qnsc.dev');
    editorToken = await signIn(app, 'dev@qnsc.dev');

    // A story owned — Owner AND Dev Owner — by the WORKSPACE ADMIN, who by §2.1 appears in no
    // project roster. This is the row the report is about.
    const created = await as(adminToken, 'POST', '/work-items', {
      projectId: NXP,
      type: 'story',
      title: `Owner-name probe ${Date.now()}`,
      assigneeId: ADMIN_USER_ID,
      devOwnerId: ADMIN_USER_ID,
      // Team Alpha, which the seeded Editor belongs to: a team-LESS row is the Project Backlog and
      // admin-only (`PROJECT_BACKLOG_ADMIN_ONLY`), so without this the Editor cannot read the row at
      // all and the test would be measuring the team-scope rule instead of the name.
      teamId: TEAM_ALPHA_ID,
    });
    expect(created.statusCode, created.body).toBe(201);
    storyKey = created.json().itemKey;
    storyId = created.json().id;
    // Into the committed iteration, so the Iteration Status read model returns it.
    const scheduled = await as(adminToken, 'PATCH', `/work-items/${storyId}`, {
      iterationId: NXP_ITER_CURRENT_ID,
    });
    expect(scheduled.statusCode, scheduled.body).toBe(200);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('the TEAM-scoped picker feed cannot name this owner — the premise', async () => {
    // The premise, stated against the branch the grids actually use. `WID-FR-017` (BA `c42df59`)
    // scopes a team-selected feed to project Admins, Editors on THAT team, and a WA on its roster —
    // so a WA who is not on the selected team is absent, and a name resolved from this feed would be
    // missing. (The no-team branch does now include Workspace Admins, which is why this case names
    // the team explicitly rather than asserting the feed can never carry them.)
    const teamFeed = await as(
      editorToken,
      'GET',
      `/projects/${NXP}/member-options?teamId=${TEAM_BETA_ID}`,
    );
    expect(teamFeed.statusCode, teamFeed.body).toBe(200);
    expect(userIdsOf(teamFeed.json())).not.toContain(ADMIN_USER_ID);
  });

  it('Iteration Status names the Owner and the Dev Owner for an EDITOR', async () => {
    const res = await as(editorToken, 'GET', `/iterations/${NXP_ITER_CURRENT_ID}/status?limit=100`);

    expect(res.statusCode, res.body).toBe(200);
    const row = (res.json().items as OwnedRow[]).find((i) => i.itemKey === storyKey);
    expect(row, 'the probe story must be in the iteration').toBeDefined();
    expect(row?.assigneeId).toBe(ADMIN_USER_ID);
    // The assertion the report is: an id with no name reads as unassigned on screen.
    expect(row?.assigneeName).toBeTruthy();
    expect(row?.devOwnerName).toBeTruthy();
  });

  it('carries the row TEAM, which is what scopes its Owner offer list', async () => {
    /**
     * `WID-FR-017` scopes Owner and Dev Owner candidates to the record's Team. The Iteration Status
     * projection did not select `team_id`, so the grid had no team to ask with and fetched the
     * PROJECT-WIDE feed instead — the no-Team branch of the rule, which offers Project Admins and no
     * Editors at all. Both dropdowns then showed nothing but `No Entry` on a project staffed by
     * Editors, and no active Team member could be assigned inline (Production, 2026-08-21).
     *
     * Asserted on the read model rather than through the picker, because the picker is the client:
     * without this field there is nothing for it to pass.
     */
    const res = await as(editorToken, 'GET', `/iterations/${NXP_ITER_CURRENT_ID}/status?limit=100`);
    expect(res.statusCode, res.body).toBe(200);
    const row = (res.json().items as Array<OwnedRow & { teamId: string | null }>).find(
      (i) => i.itemKey === storyKey,
    );
    expect(row?.teamId, 'the probe story was created on Team Alpha').toBe(TEAM_ALPHA_ID);
  });

  it('the Backlog list names them too, and so does the same row for an ADMIN', async () => {
    // Backlog is the surface that was broken for EVERY role, because it consults only the project
    // feed — so the admin direction is the sharper assertion here.
    for (const token of [editorToken, adminToken]) {
      const res = await as(token, 'GET', `/work-items?projectId=${NXP}&limit=100`);
      expect(res.statusCode, res.body).toBe(200);
      const row = (res.json().data as OwnedRow[]).find((i) => i.itemKey === storyKey);
      expect(
        row?.assigneeName,
        `named for ${token === adminToken ? 'admin' : 'editor'}`,
      ).toBeTruthy();
    }
  });

  it('names the owner on the item the Tasks tab reads', async () => {
    const task = await as(adminToken, 'POST', `/work-items/${storyId}/tasks`, {
      title: 'Owner-name probe task',
      assigneeId: ADMIN_USER_ID,
    });
    expect(task.statusCode, task.body).toBe(201);

    const tasks = await as(editorToken, 'GET', `/work-items/${storyId}/tasks`);

    expect(tasks.statusCode, tasks.body).toBe(200);
    const taskRows: OwnedRow[] = tasks.json();
    const row = taskRows.find((t) => t.assigneeId === ADMIN_USER_ID);
    expect(row?.assigneeName).toBeTruthy();
  });

  it('sorts the Backlog by owner NAME, and pages that sort without repeating a row', async () => {
    /**
     * Phase 2/01 §167 lists `assignee` and `devOwner` among the accepted `sortBy` values. They were
     * withheld while the grids resolved a name on the client, because the only thing the server
     * could order by was the uuid — arbitrary to every reader. Now that the name is joined, the sort
     * seeks on the SAME `coalesce(display_name, email)` expression the cell renders, which is what
     * keeps the order and the keyset cursor from disagreeing on a user with no display name.
     *
     * The paging half is the part a unit test cannot see: a keyset over a non-unique, nullable,
     * JOINED expression is exactly where an off-by-one repeats or skips a row.
     */
    const first = await as(
      adminToken,
      'GET',
      `/work-items?projectId=${NXP}&sort=assignee:asc&limit=3`,
    );
    expect(first.statusCode, first.body).toBe(200);
    const page1 = first.json().data as OwnedRow[];
    const names = (rows: OwnedRow[]) => rows.map((r) => r.assigneeName ?? null);

    // Non-null names ascend, and the nulls come last (ASC → NULLS LAST, the shared keyset rule).
    const named = names(page1).filter((n): n is string => n !== null);
    expect([...named]).toEqual([...named].sort((a, b) => a.localeCompare(b)));
    if (names(page1).some((n) => n === null)) {
      expect(names(page1).indexOf(null)).toBeGreaterThanOrEqual(named.length);
    }

    const cursor = first.json().pageInfo?.nextCursor as string | undefined;
    if (cursor) {
      const second = await as(
        adminToken,
        'GET',
        `/work-items?projectId=${NXP}&sort=assignee:asc&limit=3&cursor=${encodeURIComponent(cursor)}`,
      );
      expect(second.statusCode, second.body).toBe(200);
      const page2 = second.json().data as OwnedRow[];
      const ids = new Set(page1.map((r) => r.itemKey));
      for (const row of page2) {
        expect(ids.has(row.itemKey), `${row.itemKey} appeared on both pages`).toBe(false);
      }
    }
  });

  it('sorts by Dev Owner too — the second field is not half-wired', async () => {
    const res = await as(
      adminToken,
      'GET',
      `/work-items?projectId=${NXP}&sort=devOwner:desc&limit=5`,
    );
    expect(res.statusCode, res.body).toBe(200);
    // DESC → NULLS FIRST: unset Dev Owners lead, then names descend.
    const values = (res.json().data as OwnedRow[]).map((r) => r.devOwnerName ?? null);
    const firstNamed = values.findIndex((v) => v !== null);
    if (firstNamed > 0) expect(values.slice(0, firstNamed).every((v) => v === null)).toBe(true);
    const named = values.filter((v): v is string => v !== null);
    expect([...named]).toEqual([...named].sort((a, b) => b.localeCompare(a)));
  });

  it('does NOT widen the owner OFFER feed (WID-FR-016)', async () => {
    // Naming and offering stay separate questions, and the name fix moved only the first. Asserted on
    // the team branch: a Workspace Admin who is not on the selected team is still not offered there,
    // however the row names them.
    const feed = await as(
      adminToken,
      'GET',
      `/projects/${NXP}/member-options?teamId=${TEAM_BETA_ID}`,
    );
    expect(userIdsOf(feed.json())).not.toContain(ADMIN_USER_ID);
  });
});
