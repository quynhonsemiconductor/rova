/**
 * PR2's write tools through the REAL MCP route and the real guard chain: the refusal a
 * non-member gets is the REST refusal (same status and body), an archived project refuses, and
 * an idempotent replay returns the same row instead of a duplicate.
 */
import 'reflect-metadata';
import './support/enable-mcp-writes';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../apps/api/src/app.module';
import { registerMcpRoute, type McpAccessVerifier } from '../../apps/api/src/mcp';
import { setMcpWritesEnabled } from '../../apps/api/src/mcp/write-policy';
import { bootstrapApp } from '../../apps/api/src/bootstrap/app.bootstrap';
import { CSRF_HEADER, CSRF_SECRET_COOKIE, DRIZZLE, type DrizzleDB } from '@platform';
import { users } from '../../db/schema/identity';
import {
  comments,
  testCases,
  testResults,
  timeLogs,
  workItemLabels,
  workItemRelations,
  workItems,
} from '../../db/schema/work';
import { inAppNotifications } from '../../db/schema/notifications';
import {
  NXP_DEFECT_1_ID,
  TEAM_ALPHA_ID,
  NXP_FEATURE_3_ID,
  NXP_ITER_CURRENT_ID,
  NXP_RELEASE_1_ID,
  TEAM_BETA_ID,
  NXP_STORY_1_ID,
  PAY_STORY_ID,
  SEED_PROJECTS,
  WORKSPACE_ID,
} from '../../db/seeds/constants';
import { readCookie, signIn } from './support/session';

const TOKEN = 'e2e.access.writes';
const NXP = SEED_PROJECTS[0].id;

describe('/mcp write tools (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DrizzleDB;
  let people = new Map<string, { userId: string; workspaceId: string }>();
  let adminCookie: string;
  let viewerCookie: string;
  let devCookie: string;
  let adminCsrf: { cookie: string; token: string };
  let viewerCsrf: { cookie: string; token: string };
  let devCsrf: { cookie: string; token: string };
  let adminId: string;
  let viewerId: string;
  let devId: string;

  const verifier: McpAccessVerifier = { verify: async (bearer) => people.get(bearer) ?? null };

  async function userId(email: string): Promise<string> {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    return String(row?.id);
  }

  async function mcp(
    method: string,
    params?: object,
  ): Promise<{
    statusCode: number;
    body: { result?: { isError?: boolean; content?: { text?: string }[] } };
  }> {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${TOKEN}`,
      },
      payload: { jsonrpc: '2.0', id: 1, method, params },
    });
    return { statusCode: res.statusCode, body: res.json() };
  }

  async function tool(name: string, args: Record<string, unknown>) {
    const { body } = await mcp('tools/call', { name, arguments: args });
    const text = body.result?.content?.[0]?.text;
    return { isError: Boolean(body.result?.isError), body: text ? JSON.parse(text) : undefined };
  }

  /** Admin REST call with the CSRF pair the bootstrap requires. */
  async function adminRest(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) {
    return app.inject({
      method,
      url: `/v1${url}`,
      headers: { cookie: adminCsrf.cookie, [CSRF_HEADER]: adminCsrf.token },
      payload,
    });
  }

  /**
   * The seeded NXP project predates the Type backfill (the fixtures are written straight to the
   * tables, not through `createProject`), so it has no selectable Test Case Type — and a create is
   * refused without one. Give it one, tolerating a re-run that already did.
   */
  async function ensureTestCaseType(): Promise<void> {
    const res = await adminRest('POST', `/projects/${NXP}/test-case-types`, {
      name: 'Functional',
    });
    if (res.statusCode >= 300) {
      expect(res.json()).toMatchObject({ error: { code: 'TEST_CASE_TYPE_NAME_TAKEN' } });
    }
  }

  /**
   * A story of this test's OWN. Test cases hung off the seeded story change fixtures other specs
   * assert (its Test Case list is exactly TC-1, TC-2), so every case here gets its own parent.
   */
  async function freshStory(): Promise<string> {
    const story = await adminRest('POST', '/work-items', {
      projectId: NXP,
      type: 'story',
      title: `qa story ${Date.now()}-${Math.round(Math.random() * 1e6)}`,
      teamId: TEAM_ALPHA_ID,
    });
    expect(story.statusCode, story.body).toBe(201);
    return story.json().id as string;
  }

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter({ logger: false, trustProxy: true }),
      { bufferLogs: true, logger: false, abortOnError: false },
    );
    await bootstrapApp(app);
    const fastify = app.getHttpAdapter().getInstance();
    db = app.get(DRIZZLE);

    adminId = await userId('admin@qnsc.dev');
    viewerId = await userId('viewer@qnsc.dev');
    devId = await userId('dev@qnsc.dev');
    people = new Map([[TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID }]]);

    setMcpWritesEnabled(true);
    registerMcpRoute({
      app,
      fastify,
      verifier,
      cache: app.get(CacheService),
      serverVersion: 'e2e',
      writesEnabled: true,
      idempotencySecret: 'x'.repeat(32),
      // This file exercises write behaviour, not the /mcp POST budget; the suite's many calls from
      // one admin would otherwise cross 60/min and answer a body-less 429.
      rateLimitDisabled: true,
    });
    await app.init();
    await fastify.ready();

    adminCookie = await signIn(app, 'admin@qnsc.dev');
    viewerCookie = await signIn(app, 'viewer@qnsc.dev');
    devCookie = await signIn(app, 'dev@qnsc.dev');
    // CSRF, exactly as the SPA obtains it: /v1/auth/me plants the secret cookie + token.
    const csrfFor = async (cookie: string) => {
      const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });
      return {
        cookie: `${cookie}; ${readCookie(me.headers['set-cookie'], CSRF_SECRET_COOKIE)}`,
        token: me.json().csrfToken as string,
      };
    };
    adminCsrf = await csrfFor(adminCookie);
    viewerCsrf = await csrfFor(viewerCookie);
    devCsrf = await csrfFor(devCookie);
    await mcp('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '0' },
    });
  }, 90_000);

  afterAll(async () => {
    setMcpWritesEnabled(false);
    // A later e2e file may share this worker: leave the gate as the environment had it.
    process.env['MCP_WRITES_ENABLED'] = 'false';
    await app?.close();
  });

  it('a non-member gets exactly the REST refusal (403, same body)', async () => {
    // As the viewer, the item lookup itself is refused; compare with the viewer's REST read.
    people.set(TOKEN, { userId: viewerId, workspaceId: WORKSPACE_ID });
    const rest = await app.inject({
      method: 'GET',
      url: '/v1/work-items/by-key',
      query: { itemKey: 'OBSE-42' },
      headers: { cookie: viewerCookie },
    });
    const viaMcp = await tool('rova_log_time', {
      key: 'OBSE-42',
      hours: 1,
      date: '2026-06-20',
    });
    expect(viaMcp.isError).toBe(true);

    // The REAL write route refuses the same caller too (403/404 — policy hides existence from a
    // non-member). The byte-for-byte refusal comparison is the GET the resolver performs here; the
    // POST-route equality is asserted in the archived-project and mark-read cases, where the
    // caller can resolve the subject first.
    const restPost = await app.inject({
      method: 'POST',
      url: `/v1/work-items/${NXP_STORY_1_ID}/time-logs`,
      headers: { cookie: viewerCsrf.cookie, [CSRF_HEADER]: viewerCsrf.token },
      payload: { loggedDate: '2026-06-20', hours: 1 },
    });
    expect([403, 404]).toContain(restPost.statusCode);
    expect([403, 404]).toContain(viaMcp.body.statusCode);
    expect(viaMcp.body.statusCode, `rest=${rest.body} mcp=${JSON.stringify(viaMcp.body)}`).toBe(
      rest.statusCode,
    );

    // The envelope carries a per-request correlationId; compare the refusal itself.
    const strip = (body: unknown): unknown => {
      const copy = JSON.parse(JSON.stringify(body)) as { error?: { correlationId?: string } };
      if (copy.error) delete copy.error.correlationId;
      return copy;
    };
    expect(strip(viaMcp.body.error)).toEqual(strip(rest.json()));
  });

  it('an archived project is refused, with the REST body', async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    const admin = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
      app.inject({
        method,
        url: `/v1${url}`,
        headers: { cookie: adminCsrf.cookie, [CSRF_HEADER]: adminCsrf.token },
        payload,
      });

    const project = await admin('POST', '/projects', {
      key: `ARC${Date.now() % 10000}`,
      name: 'Archived probe',
    });
    expect(project.statusCode, project.body).toBe(201);
    const projectId = project.json().id as string;
    const item = await admin('POST', '/work-items', {
      projectId,
      type: 'story',
      title: 'Archived item',
    });
    expect(item.statusCode, item.body).toBe(201);
    const itemId = item.json().id as string;
    expect((await admin('POST', `/projects/${projectId}/archive`)).statusCode).toBeLessThan(300);

    const rest = await admin('POST', `/work-items/${itemId}/time-logs`, {
      loggedDate: '2026-06-20',
      hours: 1,
    });
    const viaMcp = await tool('rova_log_time', { key: itemId, hours: 1, date: '2026-06-20' });
    expect(viaMcp.isError, JSON.stringify(viaMcp.body)).toBe(true);
    expect(viaMcp.body.statusCode, `rest=${rest.body} mcp=${JSON.stringify(viaMcp.body)}`).toBe(
      rest.statusCode,
    );

    // The envelope carries a per-request correlationId; compare the refusal itself.
    const strip = (body: unknown): unknown => {
      const copy = JSON.parse(JSON.stringify(body)) as { error?: { correlationId?: string } };
      if (copy.error) delete copy.error.correlationId;
      return copy;
    };
    expect(strip(viaMcp.body.error)).toEqual(strip(rest.json()));

    // UPDATE and ADD_TASK are refused by the same archived-project rule on their own routes.
    const restUpdate = await admin('PATCH', `/work-items/${itemId}`, { title: 'archived edit' });
    expect(restUpdate.statusCode, restUpdate.body).toBeGreaterThanOrEqual(400);
    const viaMcpUpdate = await tool('rova_update_work_item', {
      key: itemId,
      ifMatch: '0',
      title: 'archived edit',
    });
    expect(viaMcpUpdate.isError).toBe(true);
    expect(viaMcpUpdate.body.statusCode).toBe(restUpdate.statusCode);
    expect(viaMcpUpdate.body.error).toMatchObject({
      error: { code: restUpdate.json().error.code },
    });

    const restTask = await admin('POST', `/work-items/${itemId}/tasks`, { title: 'archived task' });
    expect(restTask.statusCode, restTask.body).toBeGreaterThanOrEqual(400);
    const viaMcpTask = await tool('rova_add_task', { parentKey: itemId, title: 'archived task' });
    expect(viaMcpTask.isError).toBe(true);
    expect(viaMcpTask.body.statusCode).toBe(restTask.statusCode);
    expect(viaMcpTask.body.error).toMatchObject({ error: { code: restTask.json().error.code } });
  });

  it('a genuine repeat WITHOUT requestId is a second time log — a 2 h entry logged twice is two entries', async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    const args = {
      key: NXP_STORY_1_ID,
      hours: 1.5,
      date: '2026-06-20',
      description: `no-request-id ${Date.now()}`,
    };
    const first = await tool('rova_log_time', args);
    const second = await tool('rova_log_time', args);
    expect(first.isError, JSON.stringify(first.body)).toBeFalsy();
    expect(second.isError, JSON.stringify(second.body)).toBeFalsy();
    expect(second.body.timeLog.id).not.toBe(first.body.timeLog.id);
    expect(second.body.replayed).toBe(false);
    const [{ rows }] = await db
      .select({ rows: sql<number>`count(*)::int` })
      .from(timeLogs)
      .where(eq(timeLogs.description, args.description));
    expect(Number(rows)).toBe(2);
  });

  it('the SAME requestId replays the first time log: one row, same id, replayed', async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    const args = {
      key: NXP_STORY_1_ID,
      hours: 1.5,
      date: '2026-06-20',
      description: `request-id ${Date.now()}`,
      requestId: `log-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    };
    const first = await tool('rova_log_time', args);
    const second = await tool('rova_log_time', args);
    expect(first.isError, JSON.stringify(first.body)).toBeFalsy();
    expect(second.isError, JSON.stringify(second.body)).toBeFalsy();
    expect(second.body.timeLog.id).toBe(first.body.timeLog.id);
    expect(second.body.replayed).toBe(true);
    const [{ rows }] = await db
      .select({ rows: sql<number>`count(*)::int` })
      .from(timeLogs)
      .where(eq(timeLogs.description, args.description));
    expect(Number(rows)).toBe(1);
  });

  it('comments follow the same rule: no requestId is two comments, one requestId is one + replay', async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    const plainBody = `repeat comment ${Date.now()}`;
    const a = await tool('rova_add_comment', { workItemKey: NXP_STORY_1_ID, body: plainBody });
    const b = await tool('rova_add_comment', { workItemKey: NXP_STORY_1_ID, body: plainBody });
    expect(a.isError, JSON.stringify(a.body)).toBeFalsy();
    expect(b.isError, JSON.stringify(b.body)).toBeFalsy();
    expect(b.body.comment.id).not.toBe(a.body.comment.id);
    expect(b.body.replayed).toBe(false);
    const [{ rows: plainRows }] = await db
      .select({ rows: sql<number>`count(*)::int` })
      .from(comments)
      .where(eq(comments.body, plainBody));
    expect(Number(plainRows)).toBe(2);

    const keyedBody = `request-id comment ${Date.now()}`;
    const requestId = `comment-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const c = await tool('rova_add_comment', {
      workItemKey: NXP_STORY_1_ID,
      body: keyedBody,
      requestId,
    });
    const d = await tool('rova_add_comment', {
      workItemKey: NXP_STORY_1_ID,
      body: keyedBody,
      requestId,
    });
    expect(c.isError, JSON.stringify(c.body)).toBeFalsy();
    expect(d.isError, JSON.stringify(d.body)).toBeFalsy();
    expect(d.body.comment.id).toBe(c.body.comment.id);
    expect(d.body.replayed).toBe(true);
    const [{ rows: keyedRows }] = await db
      .select({ rows: sql<number>`count(*)::int` })
      .from(comments)
      .where(eq(comments.body, keyedBody));
    expect(Number(keyedRows)).toBe(1);
  });

  it('rova_add_comment refuses a replyTo from ANOTHER item (and REST refuses it too)', async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    const other = await adminRest('POST', '/work-items', {
      projectId: NXP,
      type: 'story',
      title: 'Reply target twin',
    });
    expect(other.statusCode, other.body).toBe(201);
    const otherId = other.json().id as string;

    const parent = await adminRest('POST', `/work-items/${NXP_STORY_1_ID}/comments`, {
      body: 'parent on story 1',
    });
    expect(parent.statusCode, parent.body).toBe(201);
    const parentId = parent.json().id as string;

    const rest = await adminRest('POST', `/work-items/${otherId}/comments`, {
      body: 'cross-item reply',
      parentId,
    });
    expect(rest.statusCode, rest.body).toBe(412);
    expect(rest.json()).toMatchObject({ error: { code: 'COMMENT_PARENT_MISMATCH' } });

    const viaMcp = await tool('rova_add_comment', {
      workItemKey: otherId,
      body: 'cross-item reply',
      replyTo: parentId,
    });
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.body.statusCode).toBe(412);
    expect(viaMcp.body.error).toMatchObject({ error: { code: 'COMMENT_PARENT_MISMATCH' } });
  });

  it('mentions are PROJECT-scoped: an outsider cannot be mentioned, candidates do not leak them', async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    const rest = await adminRest('POST', `/work-items/${NXP_STORY_1_ID}/comments`, {
      body: 'mention an outsider',
      mentionedUserIds: [viewerId],
    });
    expect(rest.statusCode, rest.body).toBe(412);
    expect(rest.json()).toMatchObject({ error: { code: 'COMMENT_MENTION_NOT_IN_PROJECT' } });

    const viaMcp = await tool('rova_add_comment', {
      workItemKey: NXP_STORY_1_ID,
      body: 'mention an outsider',
      mention: ['viewer@qnsc.dev'],
    });
    expect(viaMcp.isError).toBe(true);
    // The refusal quotes the caller's own input, but the CANDIDATE list is the project's only:
    // no one outside the subject's project is disclosed.
    const candidates = String(viaMcp.body.error).split('Candidates:')[1] ?? '';
    expect(candidates).not.toContain('viewer@qnsc.dev');

    const ok = await tool('rova_add_comment', {
      workItemKey: NXP_STORY_1_ID,
      body: 'mention a member',
      mention: ['admin@qnsc.dev'],
    });
    expect(ok.isError, JSON.stringify(ok.body)).toBeFalsy();
  });

  it('rova_add_comment replays the SAME comment id for the same requestId, on a work item and a portfolio item', async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });

    const itemBody = `replay item comment ${Date.now()}`;
    const itemRequest = `item-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const first = await tool('rova_add_comment', {
      workItemKey: NXP_STORY_1_ID,
      body: itemBody,
      requestId: itemRequest,
    });
    const second = await tool('rova_add_comment', {
      workItemKey: NXP_STORY_1_ID,
      body: itemBody,
      requestId: itemRequest,
    });
    expect(first.isError, JSON.stringify(first.body)).toBeFalsy();
    expect(second.body.comment.id).toBe(first.body.comment.id);
    const [{ n: itemRows }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(comments)
      .where(eq(comments.body, itemBody));
    expect(Number(itemRows)).toBe(1);

    // The portfolio route is the second subject: resolve its key through the same list the tool uses.
    const features = await app.inject({
      method: 'GET',
      url: '/v1/portfolio-items',
      query: { type: 'feature', projectId: NXP, limit: '100' },
      headers: { cookie: adminCookie },
    });
    expect(features.statusCode, features.body).toBe(200);
    const key = (features.json().data as { id: string; itemKey: string }[]).find(
      (f) => f.id === NXP_FEATURE_3_ID,
    )?.itemKey as string;
    expect(key).toBeTruthy();

    const portfolioBody = `replay portfolio comment ${Date.now()}`;
    const portfolioRequest = `portfolio-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const p1 = await tool('rova_add_comment', {
      portfolioItemKey: key,
      body: portfolioBody,
      requestId: portfolioRequest,
    });
    const p2 = await tool('rova_add_comment', {
      portfolioItemKey: key,
      body: portfolioBody,
      requestId: portfolioRequest,
    });
    expect(p1.isError, JSON.stringify(p1.body)).toBeFalsy();
    expect(p2.body.comment.id).toBe(p1.body.comment.id);
    const [{ n: portfolioRows }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(comments)
      .where(eq(comments.body, portfolioBody));
    expect(Number(portfolioRows)).toBe(1);
  });

  it("mark_notifications_read refuses another user's notification", async () => {
    people.set(TOKEN, { userId: viewerId, workspaceId: WORKSPACE_ID });
    const [notification] = await db
      .insert(inAppNotifications)
      .values({
        workspaceId: WORKSPACE_ID,
        recipientId: adminId,
        type: 'WORK_ITEM_ASSIGNED',
        title: 'probe for another user',
        body: null,
        metadata: {},
      })
      .returning({ id: inAppNotifications.id });
    const notificationId = String(notification.id);

    const rest = await app.inject({
      method: 'POST',
      url: `/v1/notifications/${notificationId}/read`,
      headers: { cookie: viewerCsrf.cookie, [CSRF_HEADER]: viewerCsrf.token },
    });
    const viaMcp = await tool('rova_mark_notifications_read', { notificationId });
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.body.statusCode, `rest=${rest.body} mcp=${JSON.stringify(viaMcp.body)}`).toBe(
      rest.statusCode,
    );
    const strip = (body: unknown): unknown => {
      const copy = JSON.parse(JSON.stringify(body)) as { error?: { correlationId?: string } };
      if (copy.error) delete copy.error.correlationId;
      return copy;
    };
    expect(strip(viaMcp.body.error)).toEqual(strip(rest.json()));
  });

  it('rova_create_work_item seeds iteration and release atomically, and a replay returns the SAME row', async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });

    // Names, resolved from the same feeds the tool uses — never a guess at the seed.
    const iterations = await app.inject({
      method: 'GET',
      url: '/v1/iterations/options',
      query: { projectId: NXP },
      headers: { cookie: adminCookie },
    });
    const iterationName = iterations
      .json<{ id: string; name: string }[]>()
      .find((i) => i.id === NXP_ITER_CURRENT_ID)?.name;
    const releases = await app.inject({
      method: 'GET',
      url: '/v1/releases/options',
      query: { projectId: NXP },
      headers: { cookie: adminCookie },
    });
    const releaseName = releases
      .json<{ id: string; name: string }[]>()
      .find((r) => r.id === NXP_RELEASE_1_ID)?.name;
    expect(iterationName, iterations.body).toBeTruthy();
    expect(releaseName, releases.body).toBeTruthy();

    const args = {
      project: 'NXP',
      type: 'story',
      title: `mcp create probe ${Date.now()}`,
      iteration: iterationName as string,
      release: releaseName as string,
      requestId: `create-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    };
    const first = await tool('rova_create_work_item', args);
    const second = await tool('rova_create_work_item', args);
    expect(first.isError, JSON.stringify(first.body)).toBeFalsy();
    expect(second.body.workItem.id).toBe(first.body.workItem.id);
    // The REST idempotency layer says which call actually wrote the row.
    expect(first.body.replayed).toBe(false);
    expect(second.body.replayed).toBe(true);
    // ONE row: the replay replayed the idempotent response, it did not create twice.
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(workItems)
      .where(eq(workItems.title, args.title));
    expect(Number(n)).toBe(1);

    // The create SEEDED both timeboxes in the same write, not via a follow-up PATCH.
    const row = await app.inject({
      method: 'GET',
      url: `/v1/work-items/${first.body.workItem.id}`,
      headers: { cookie: adminCookie },
    });
    expect(row.statusCode).toBe(200);
    const detail = row.json<{ item?: Record<string, unknown> }>();
    expect(detail.item ?? detail).toMatchObject({
      iterationId: NXP_ITER_CURRENT_ID,
      releaseId: NXP_RELEASE_1_ID,
    });
  });

  it('a non-member updating a work item gets the resolver refusal, exactly as REST does', async () => {
    people.set(TOKEN, { userId: viewerId, workspaceId: WORKSPACE_ID });
    const rest = await app.inject({
      method: 'GET',
      url: '/v1/work-items/by-key',
      query: { itemKey: 'OBSE-42' },
      headers: { cookie: viewerCookie },
    });
    const viaMcp = await tool('rova_update_work_item', {
      key: 'OBSE-42',
      ifMatch: '0',
      title: 'nope',
    });
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.body.statusCode, JSON.stringify(viaMcp.body)).toBe(rest.statusCode);
    const strip = (body: unknown): unknown => {
      const copy = JSON.parse(JSON.stringify(body)) as { error?: { correlationId?: string } };
      if (copy.error) delete copy.error.correlationId;
      return copy;
    };
    expect(strip(viaMcp.body.error)).toEqual(strip(rest.json()));
  });

  it('creating in an archived project is refused with the REST body', async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    const key = `ARCW${Date.now() % 100000}`;
    const project = await adminRest('POST', '/projects', { key, name: 'Archived write probe' });
    expect(project.statusCode, project.body).toBe(201);
    const projectId = project.json().id as string;
    expect((await adminRest('POST', `/projects/${projectId}/archive`)).statusCode).toBeLessThan(
      300,
    );

    const rest = await adminRest('POST', '/work-items', {
      projectId,
      type: 'story',
      title: 'archived create',
    });
    const viaMcp = await tool('rova_create_work_item', {
      project: key,
      type: 'story',
      title: 'archived create',
    });
    expect(viaMcp.isError, JSON.stringify(viaMcp.body)).toBe(true);
    expect(viaMcp.body.statusCode, `rest=${rest.body} mcp=${JSON.stringify(viaMcp.body)}`).toBe(
      rest.statusCode,
    );
    const strip = (body: unknown): unknown => {
      const copy = JSON.parse(JSON.stringify(body)) as { error?: { correlationId?: string } };
      if (copy.error) delete copy.error.correlationId;
      return copy;
    };
    expect(strip(viaMcp.body.error)).toEqual(strip(rest.json()));
  });

  it('a stale If-Match answers 412 WORK_ITEM_STALE with the FRESH item and its new version', async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    const created = await adminRest('POST', '/work-items', {
      projectId: NXP,
      type: 'story',
      title: `stale probe ${Date.now()}`,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;

    // Someone else's write wins first: the version moves from "0" to "1".
    const bump = await adminRest('PATCH', `/work-items/${id}`, { title: 'theirs' });
    expect(bump.statusCode, bump.body).toBe(200);
    const rest = await app.inject({
      method: 'PATCH',
      url: `/v1/work-items/${id}`,
      headers: {
        cookie: adminCsrf.cookie,
        [CSRF_HEADER]: adminCsrf.token,
        'if-match': '"0"',
      },
      payload: { title: 'mine' },
    });
    expect(rest.statusCode, rest.body).toBe(412);

    const viaMcp = await tool('rova_update_work_item', {
      key: id,
      title: 'mine',
      ifMatch: '0',
    });
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.body.statusCode).toBe(412);
    // The refusal is REST's, and the tool adds the row as it stands — re-apply without re-reading.
    expect(viaMcp.body.error).toMatchObject({ error: { code: 'WORK_ITEM_STALE' } });
    expect(viaMcp.body.version).toBe(1);
    expect(viaMcp.body.current).toMatchObject({ id, title: 'theirs' });
  });

  it("a task's iteration is refused through MCP exactly as it is through REST", async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    const task = await tool('rova_add_task', {
      parentKey: NXP_STORY_1_ID,
      title: `task probe ${Date.now()}`,
    });
    expect(task.isError, JSON.stringify(task.body)).toBeFalsy();
    const taskId = task.body.workItem.id as string;

    const iterations = await app.inject({
      method: 'GET',
      url: '/v1/iterations/options',
      query: { projectId: NXP },
      headers: { cookie: adminCookie },
    });
    const iterationName = iterations
      .json<{ id: string; name: string }[]>()
      .find((i) => i.id === NXP_ITER_CURRENT_ID)?.name;

    const rest = await adminRest('PATCH', `/work-items/${taskId}`, {
      iterationId: NXP_ITER_CURRENT_ID,
    });
    expect(rest.statusCode, rest.body).toBe(412);
    const viaMcp = await tool('rova_update_work_item', {
      key: taskId,
      ifMatch: String(task.body.version),
      iteration: iterationName,
    });
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.body.statusCode).toBe(rest.statusCode);
    expect(viaMcp.body.error).toMatchObject({ error: { code: 'TASK_ITERATION_DERIVED' } });
  });

  it('an Editor cannot set a release — on create AND update — and the refusal equals REST', async () => {
    people.set(TOKEN, { userId: devId, workspaceId: WORKSPACE_ID });
    const devRest = (method: 'POST' | 'PATCH', url: string, payload: object) =>
      app.inject({
        method,
        url: `/v1${url}`,
        headers: { cookie: devCsrf.cookie, [CSRF_HEADER]: devCsrf.token },
        payload,
      });
    const releases = await app.inject({
      method: 'GET',
      url: '/v1/releases/options',
      query: { projectId: NXP },
      headers: { cookie: devCookie },
    });
    const releaseName = releases
      .json<{ id: string; name: string }[]>()
      .find((r) => r.id === NXP_RELEASE_1_ID)?.name as string;

    // CREATE: assertMayAssignRelease (release:view) is an Editor's refusal on the REST route.
    const restCreate = await devRest('POST', '/work-items', {
      projectId: NXP,
      type: 'story',
      title: `editor release create ${Date.now()}`,
      teamId: TEAM_ALPHA_ID,
      releaseId: NXP_RELEASE_1_ID,
    });
    expect(restCreate.statusCode, restCreate.body).toBe(403);
    const viaMcpCreate = await tool('rova_create_work_item', {
      project: 'NXP',
      type: 'story',
      title: `editor release create mcp ${Date.now()}`,
      team: 'Alpha',
      release: releaseName,
    });
    expect(viaMcpCreate.isError).toBe(true);
    expect(viaMcpCreate.body.statusCode).toBe(restCreate.statusCode);
    expect(viaMcpCreate.body.error).toMatchObject({
      error: { code: restCreate.json().error.code },
    });

    // UPDATE: the same field-level rule on PATCH /work-items/:id.
    const read = await app.inject({
      method: 'GET',
      url: '/v1/work-items/by-key',
      query: { itemKey: 'DE-1' },
      headers: { cookie: devCookie },
    });
    expect(read.statusCode, read.body).toBe(200);
    const version = String(read.headers.etag).replaceAll('"', '');
    const restUpdate = await devRest('PATCH', `/work-items/${NXP_DEFECT_1_ID}`, {
      releaseId: NXP_RELEASE_1_ID,
    });
    expect(restUpdate.statusCode, restUpdate.body).toBe(403);
    const viaMcpUpdate = await tool('rova_update_work_item', {
      key: NXP_DEFECT_1_ID,
      ifMatch: version,
      release: releaseName,
    });
    expect(viaMcpUpdate.isError).toBe(true);
    expect(viaMcpUpdate.body.statusCode).toBe(restUpdate.statusCode);
    expect(viaMcpUpdate.body.error).toMatchObject({
      error: { code: restUpdate.json().error.code },
    });
  });

  it("an Editor outside the item's Team is refused on update and add_task, exactly as REST is", async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    const beta = await adminRest('POST', '/work-items', {
      projectId: NXP,
      type: 'story',
      title: `team beta probe ${Date.now()}`,
      teamId: TEAM_BETA_ID,
    });
    expect(beta.statusCode, beta.body).toBe(201);
    const betaId = beta.json().id as string;

    // The Editor (dev) is scoped to Team Alpha, and team scope reaches the READ as well.
    people.set(TOKEN, { userId: devId, workspaceId: WORKSPACE_ID });
    const devRest = (method: 'POST' | 'PATCH', url: string, payload: object) =>
      app.inject({
        method,
        url: `/v1${url}`,
        headers: { cookie: devCsrf.cookie, [CSRF_HEADER]: devCsrf.token },
        payload,
      });

    const restPatch = await devRest('PATCH', `/work-items/${betaId}`, { title: 'nope' });
    expect(restPatch.statusCode, restPatch.body).toBe(403);
    const viaMcpUpdate = await tool('rova_update_work_item', {
      key: betaId,
      ifMatch: '0',
      title: 'nope',
    });
    expect(viaMcpUpdate.isError).toBe(true);
    expect(viaMcpUpdate.body.statusCode).toBe(restPatch.statusCode);
    expect(viaMcpUpdate.body.error).toMatchObject({ error: { code: restPatch.json().error.code } });

    const restTask = await devRest('POST', `/work-items/${betaId}/tasks`, { title: 'nope' });
    expect(restTask.statusCode, restTask.body).toBe(403);
    const viaMcpTask = await tool('rova_add_task', { parentKey: betaId, title: 'nope' });
    expect(viaMcpTask.isError).toBe(true);
    expect(viaMcpTask.body.statusCode).toBe(restTask.statusCode);
    expect(viaMcpTask.body.error).toMatchObject({
      error: { code: restTask.json().error.code },
    });
  });

  it('rova_plan_work_items DRY RUN writes nothing; dryRun:false moves the item once', async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    const created = await adminRest('POST', '/work-items', {
      projectId: NXP,
      type: 'story',
      title: `plan probe ${Date.now()}`,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;

    const iterations = await app.inject({
      method: 'GET',
      url: '/v1/iterations/options',
      query: { projectId: NXP },
      headers: { cookie: adminCookie },
    });
    const iterationName = iterations
      .json<{ id: string; name: string }[]>()
      .find((i) => i.id === NXP_ITER_CURRENT_ID)?.name as string;

    const before = await db
      .select({ iterationId: workItems.iterationId })
      .from(workItems)
      .where(eq(workItems.id, id));
    expect(before[0].iterationId).toBeNull();

    // Default is a dry run: a preview, and NOTHING written.
    const preview = await tool('rova_plan_work_items', {
      project: 'NXP',
      itemKeys: [id],
      iteration: iterationName,
    });
    expect(preview.isError, JSON.stringify(preview.body)).toBeFalsy();
    expect(preview.body).toMatchObject({ dryRun: true, wouldChange: 1 });
    const afterPreview = await db
      .select({ iterationId: workItems.iterationId })
      .from(workItems)
      .where(eq(workItems.id, id));
    expect(afterPreview[0].iterationId, 'the dry run wrote nothing').toBeNull();

    // The user agreed: the real call is ONE bulk PATCH.
    const moved = await tool('rova_plan_work_items', {
      project: 'NXP',
      itemKeys: [id],
      iteration: iterationName,
      dryRun: false,
    });
    expect(moved.isError, JSON.stringify(moved.body)).toBeFalsy();
    expect(moved.body).toMatchObject({ dryRun: false, updated: 1, changed: ['iterationId'] });
    const afterMove = await db
      .select({ iterationId: workItems.iterationId })
      .from(workItems)
      .where(eq(workItems.id, id));
    expect(afterMove[0].iterationId).toBe(NXP_ITER_CURRENT_ID);
  });

  it('rova_plan_work_items refuses 26 items at the schema and a mixed-project selection at the tool', async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    const tooMany = await mcp('tools/call', {
      name: 'rova_plan_work_items',
      arguments: {
        project: 'NXP',
        itemKeys: Array.from({ length: 26 }, (_, i) => `US-${900 + i}`),
        release: null,
      },
    });
    expect(tooMany.body.result?.isError).toBe(true);
    expect(JSON.stringify(tooMany.body)).toContain('25');

    const mixed = await tool('rova_plan_work_items', {
      project: 'NXP',
      itemKeys: [NXP_STORY_1_ID, PAY_STORY_ID],
      release: null,
    });
    expect(mixed.isError).toBe(true);
    expect(JSON.stringify(mixed.body)).toContain('another project');
  });

  it('an Editor is refused a bulk RELEASE by MCP exactly as by REST', async () => {
    people.set(TOKEN, { userId: devId, workspaceId: WORKSPACE_ID });
    const releases = await app.inject({
      method: 'GET',
      url: '/v1/releases/options',
      query: { projectId: NXP },
      headers: { cookie: devCookie },
    });
    const releaseName = releases
      .json<{ id: string; name: string }[]>()
      .find((r) => r.id === NXP_RELEASE_1_ID)?.name as string;

    const rest = await app.inject({
      method: 'PATCH',
      url: '/v1/work-items/bulk-release',
      headers: { cookie: devCsrf.cookie, [CSRF_HEADER]: devCsrf.token },
      payload: { projectId: NXP, itemIds: [NXP_STORY_1_ID], releaseId: NXP_RELEASE_1_ID },
    });
    expect(rest.statusCode, rest.body).toBe(403);

    const viaMcp = await tool('rova_plan_work_items', {
      project: 'NXP',
      itemKeys: [NXP_STORY_1_ID],
      release: releaseName,
      dryRun: false,
    });
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.body.statusCode).toBe(rest.statusCode);
    expect(viaMcp.body.error).toMatchObject({ error: { code: rest.json().error.code } });
  });

  it('rova_link_work_items is naturally idempotent: a re-link is alreadyLinked success, one row', async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    const mk = async (label: string) => {
      const res = await adminRest('POST', '/work-items', {
        projectId: NXP,
        type: 'story',
        title: `${label} ${Date.now()}`,
      });
      return res.json().id as string;
    };
    const from = await mk('link from');
    const to = await mk('link to');

    const first = await tool('rova_link_work_items', {
      fromKey: from,
      toKey: to,
      relationType: 'relates_to',
    });
    expect(first.isError, JSON.stringify(first.body)).toBeFalsy();
    expect(first.body).toMatchObject({ relationType: 'relates_to', changed: ['relation'] });

    // A legitimate REPEAT (no time-bucket key) reaches the server, which answers
    // WORK_ITEM_RELATION_EXISTS — reported as the outcome the caller asked for.
    const again = await tool('rova_link_work_items', {
      fromKey: from,
      toKey: to,
      relationType: 'relates_to',
    });
    expect(again.isError, JSON.stringify(again.body)).toBeFalsy();
    expect(again.body).toMatchObject({ alreadyLinked: true, changed: [] });
    const [{ rows }] = await db
      .select({ rows: sql<number>`count(*)::int` })
      .from(workItemRelations)
      .where(eq(workItemRelations.sourceItemId, from));
    expect(Number(rows)).toBe(1);

    // A link created on ANOTHER surface is refused by REST as well; the tool reports success.
    const otherFrom = await mk('link from 2');
    const otherTo = await mk('link to 2');
    const rest = await adminRest('POST', `/work-items/${otherFrom}/relations`, {
      targetId: otherTo,
      relationType: 'relates_to',
    });
    expect(rest.statusCode, rest.body).toBe(201);
    const sameLink = await tool('rova_link_work_items', {
      fromKey: otherFrom,
      toKey: otherTo,
      relationType: 'relates_to',
    });
    expect(sameLink.isError, JSON.stringify(sameLink.body)).toBeFalsy();
    expect(sameLink.body).toMatchObject({ alreadyLinked: true, changed: [] });
  });

  it('label and plan are naturally idempotent: a repeat is a no-op, not a replay', async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    const labelName = `mcp-replay-${Date.now()}`;
    const label = await adminRest('POST', `/projects/${NXP}/labels`, {
      name: labelName,
      color: '#445566',
    });
    expect(label.statusCode, label.body).toBeLessThan(300);
    const created = await adminRest('POST', '/work-items', {
      projectId: NXP,
      type: 'story',
      title: `replay probe ${Date.now()}`,
    });
    const itemId = created.json().id as string;

    const add = () => tool('rova_label_work_item', { key: itemId, add: [labelName] });
    expect((await add()).isError).toBeFalsy();
    expect((await add()).isError).toBeFalsy();
    const labels = await app.inject({
      method: 'GET',
      url: `/v1/work-items/${itemId}/labels`,
      headers: { cookie: adminCookie },
    });
    expect(labels.json<{ name: string }[]>().filter((l) => l.name === labelName)).toHaveLength(1);

    // Duplicate add is a server-side NO-OP (204), which is why this route needs no idempotency.
    const labelId = label.json<{ id?: string }>().id;
    if (typeof labelId === 'string') {
      const duplicate = await adminRest('POST', `/work-items/${itemId}/labels`, { labelId });
      expect(duplicate.statusCode, duplicate.body).toBe(204);
    }

    const iterations = await app.inject({
      method: 'GET',
      url: '/v1/iterations/options',
      query: { projectId: NXP },
      headers: { cookie: adminCookie },
    });
    const iterationName = iterations
      .json<{ id: string; name: string }[]>()
      .find((i) => i.id === NXP_ITER_CURRENT_ID)?.name as string;
    const plan = () =>
      tool('rova_plan_work_items', {
        project: 'NXP',
        itemKeys: [itemId],
        iteration: iterationName,
        dryRun: false,
      });
    const moved = await plan();
    const again = await plan();
    expect(moved.isError, JSON.stringify(moved.body)).toBeFalsy();
    // The REAL second call runs (no time-bucket replay): it re-assigns the same value.
    expect(again.isError, JSON.stringify(again.body)).toBeFalsy();
    expect(again.body).toMatchObject({ dryRun: false, updated: 1 });
    const [row] = await db
      .select({ iterationId: workItems.iterationId })
      .from(workItems)
      .where(eq(workItems.id, itemId));
    expect(row.iterationId).toBe(NXP_ITER_CURRENT_ID);
  });

  it('link, label and plan are refused for a caller without access, exactly as REST is', async () => {
    const count = async (table: typeof workItemRelations | typeof workItemLabels) => {
      const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(table);
      return Number(row.n);
    };
    const relationsBefore = await count(workItemRelations);
    const labelsBefore = await count(workItemLabels);

    // No Access principal: the RESOLVER read is the refusal both surfaces get.
    people.set(TOKEN, { userId: viewerId, workspaceId: WORKSPACE_ID });
    const restRead = await app.inject({
      method: 'GET',
      url: '/v1/work-items/by-key',
      query: { itemKey: 'OBSE-42' },
      headers: { cookie: viewerCookie },
    });
    for (const [registerTool, args] of [
      [
        'rova_link_work_items',
        { fromKey: 'OBSE-42', toKey: 'OBSE-42', relationType: 'relates_to' },
      ],
      ['rova_label_work_item', { key: 'OBSE-42', add: ['api'] }],
    ] as const) {
      const viaMcp = await tool(registerTool, args);
      expect(viaMcp.isError, `${registerTool}: ${JSON.stringify(viaMcp.body)}`).toBe(true);
      expect(viaMcp.body.statusCode).toBe(restRead.statusCode);
    }
    // Nothing was written by either refusal.
    expect(await count(workItemRelations)).toBe(relationsBefore);
    expect(await count(workItemLabels)).toBe(labelsBefore);

    // An Editor OUTSIDE the item's Team: the bulk route refuses it, and the tool's item read
    // refuses it with the same status/code.
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    const beta = await adminRest('POST', '/work-items', {
      projectId: NXP,
      type: 'story',
      title: `plan authz probe ${Date.now()}`,
      teamId: TEAM_BETA_ID,
    });
    const betaId = beta.json().id as string;
    const iterations = await app.inject({
      method: 'GET',
      url: '/v1/iterations/options',
      query: { projectId: NXP },
      headers: { cookie: adminCookie },
    });
    const iterationName = iterations
      .json<{ id: string; name: string }[]>()
      .find((i) => i.id === NXP_ITER_CURRENT_ID)?.name as string;

    people.set(TOKEN, { userId: devId, workspaceId: WORKSPACE_ID });
    const restBulk = await app.inject({
      method: 'PATCH',
      url: '/v1/work-items/bulk-iteration',
      headers: { cookie: devCsrf.cookie, [CSRF_HEADER]: devCsrf.token },
      payload: { projectId: NXP, itemIds: [betaId], iterationId: NXP_ITER_CURRENT_ID },
    });
    expect(restBulk.statusCode, restBulk.body).toBe(403);
    const viaMcp = await tool('rova_plan_work_items', {
      project: 'NXP',
      itemKeys: [betaId],
      iteration: iterationName,
      dryRun: false,
    });
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.body.statusCode).toBe(restBulk.statusCode);
    expect(viaMcp.body.error).toMatchObject({ error: { code: restBulk.json().error.code } });
    // The refused batch moved NOTHING.
    const [betaRow] = await db
      .select({ iterationId: workItems.iterationId })
      .from(workItems)
      .where(eq(workItems.id, betaId));
    expect(betaRow.iterationId).toBeNull();
  });

  it('rova_label_work_item adds and removes an existing project label by name', async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    const labelName = `mcp-label-${Date.now()}`;
    const label = await adminRest('POST', `/projects/${NXP}/labels`, {
      name: labelName,
      color: '#336699',
    });
    expect(label.statusCode, label.body).toBeLessThan(300);

    const created = await adminRest('POST', '/work-items', {
      projectId: NXP,
      type: 'story',
      title: `label probe ${Date.now()}`,
    });
    const itemId = created.json().id as string;

    const added = await tool('rova_label_work_item', { key: itemId, add: [labelName] });
    expect(added.isError, JSON.stringify(added.body)).toBeFalsy();
    expect(added.body.added).toEqual([labelName]);
    const afterAdd = await app.inject({
      method: 'GET',
      url: `/v1/work-items/${itemId}/labels`,
      headers: { cookie: adminCookie },
    });
    expect(afterAdd.json<{ name: string }[]>().map((l) => l.name)).toContain(labelName);

    const removed = await tool('rova_label_work_item', { key: itemId, remove: [labelName] });
    expect(removed.isError, JSON.stringify(removed.body)).toBeFalsy();
    expect(removed.body.removed).toEqual([labelName]);
    const afterRemove = await app.inject({
      method: 'GET',
      url: `/v1/work-items/${itemId}/labels`,
      headers: { cookie: adminCookie },
    });
    expect(afterRemove.json<{ name: string }[]>().map((l) => l.name)).not.toContain(labelName);

    const unknown = await tool('rova_label_work_item', {
      key: itemId,
      add: ['no-such-label'],
    });
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown.body)).toContain('Candidates');
  });

  it('rova_log_time refuses 2026-02-30 at the tool schema, before any write', async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    const before = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(timeLogs)
      .where(eq(timeLogs.workItemId, NXP_STORY_1_ID));
    const res = await mcp('tools/call', {
      name: 'rova_log_time',
      arguments: { key: NXP_STORY_1_ID, hours: 1, date: '2026-02-30' },
    });
    expect(res.body.result?.isError).toBe(true);
    expect(JSON.stringify(res.body)).toContain('real calendar date');
    const after = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(timeLogs)
      .where(eq(timeLogs.workItemId, NXP_STORY_1_ID));
    expect(after[0].n).toBe(before[0].n);
  });

  it('rova_save_test_case creates once and REPLAYS the same row when the request id is reused', async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    await ensureTestCaseType();
    // A fresh request id per run: a stale idempotency entry from an earlier run (different
    // database, same Valkey) would replay a row that no longer exists.
    const requestId = `req-${Date.now()}`;
    const name = `mcp test case ${Date.now()}`;
    const parentId = await freshStory();
    const args = {
      workItemKey: parentId,
      name,
      type: 'Functional',
      priority: 'high',
      requestId,
    };

    const first = await tool('rova_save_test_case', args);
    expect(first.isError, JSON.stringify(first.body)).toBeFalsy();
    const created = first.body.testCase as { id: string; testCaseKey: string };
    expect(created.testCaseKey).toMatch(/^TC-\d+$/);
    expect(first.body.replayed).toBe(false);

    const second = await tool('rova_save_test_case', args);
    expect(second.isError, JSON.stringify(second.body)).toBeFalsy();
    expect(second.body.replayed).toBe(true);
    expect((second.body.testCase as { id: string }).id).toBe(created.id);

    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(testCases)
      .where(and(eq(testCases.workItemId, parentId), eq(testCases.name, name)));
    expect(rows[0].n, 'a retried create must not add a second test case').toBe(1);
  });

  it('rova_save_test_case applies content on create and edits by key', async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    await ensureTestCaseType();
    const name = `mcp content ${Date.now()}`;
    const parentId = await freshStory();
    const created = await tool('rova_save_test_case', {
      workItemKey: parentId,
      name,
      objective: 'Verify the voltage rail holds',
      validationInput: '3.3V',
    });
    expect(created.isError, JSON.stringify(created.body)).toBeFalsy();
    const testCase = created.body.testCase as {
      id: string;
      testCaseKey: string;
      objective: string | null;
    };
    // The content fields are update-only in the API, so the create applies them with one edit —
    // and answers the record AS EDITED, not the blank one the create itself returned.
    expect(created.body.content).toEqual({ applied: true });
    expect(testCase.objective).toBe('Verify the voltage rail holds');

    const stored = await app.inject({
      method: 'GET',
      url: `/v1/test-cases/by-key/${encodeURIComponent(testCase.testCaseKey)}`,
      headers: { cookie: adminCookie },
    });
    expect(stored.statusCode, stored.body).toBe(200);
    expect(stored.json()).toMatchObject({
      objective: 'Verify the voltage rail holds',
      validationInput: '3.3V',
    });

    const updated = await tool('rova_save_test_case', {
      testCaseKey: testCase.testCaseKey,
      priority: 'urgent',
      notes: 'verified on rev A',
    });
    expect(updated.isError, JSON.stringify(updated.body)).toBeFalsy();
    expect([...(updated.body.changed as string[])].sort()).toEqual(['notes', 'priority']);
    expect(updated.body.testCase).toMatchObject({
      priority: 'urgent',
      notes: 'verified on rev A',
    });
  });

  it('rova_record_test_results refuses a tester the row-scoped feed does not offer, and REST refuses the same id', async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    await ensureTestCaseType();
    const beta = await adminRest('POST', '/work-items', {
      projectId: NXP,
      type: 'story',
      title: `qa beta probe ${Date.now()}`,
      teamId: TEAM_BETA_ID,
    });
    expect(beta.statusCode, beta.body).toBe(201);
    const testCase = await adminRest('POST', `/work-items/${beta.json().id}/test-cases`, {
      name: `qa beta case ${Date.now()}`,
    });
    expect(testCase.statusCode, testCase.body).toBe(201);
    const testCaseId = testCase.json().id as string;
    const testCaseKey = testCase.json().testCaseKey as string;

    // The REST write refuses the id: the dev is an Editor on Alpha, not an eligible tester here.
    const [devRow] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'dev@qnsc.dev'))
      .limit(1);
    const rest = await adminRest('POST', `/test-cases/${testCaseId}/test-results`, {
      build: '1.4.2',
      runDate: '2026-11-04',
      verdict: 'pass',
      testerId: String(devRow?.id),
    });
    expect(rest.statusCode, rest.body).toBe(412);
    expect(rest.json()).toMatchObject({ error: { code: 'WORK_ITEM_ASSIGNEE_NOT_ELIGIBLE' } });

    // MCP narrows EARLIER and for the same reason: the candidate feed is scoped to the row's Team,
    // so the same person is not offered at all — the write would refuse them, which is the point.
    const viaMcp = await tool('rova_record_test_results', {
      build: '1.4.2',
      runDate: '2026-11-04',
      tester: 'dev@qnsc.dev',
      results: [{ testCaseKey, verdict: 'pass' }],
    });
    expect(viaMcp.isError, 'every entry failed, so the call is an error').toBe(true);
    expect(viaMcp.body.created).toBe(0);
    const item = (viaMcp.body.results as Array<Record<string, unknown>>)[0];
    expect(item.ok).toBe(false);
    expect(String(item.error)).toContain('Candidates:');
    expect(String(item.error)).not.toContain('Alice Developer');
  });

  it('rova_record_test_results records the good entries and reports the unknown key per item', async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    await ensureTestCaseType();
    // A test case of its OWN: recording against a seeded one would move its trigger-maintained
    // Last Run and break other specs that assert the fixture's stored value.
    const contextStory = await freshStory();
    const ownCase = await adminRest('POST', `/work-items/${contextStory}/test-cases`, {
      name: `record probe ${Date.now()}`,
    });
    expect(ownCase.statusCode, ownCase.body).toBe(201);
    const ownKey = ownCase.json().testCaseKey as string;

    const build = `mcp-build-${Date.now()}`;
    const requestId = `req-${build}`;
    const recorded = await tool('rova_record_test_results', {
      build,
      runDate: '2026-11-04',
      requestId,
      results: [
        { testCaseKey: ownKey, verdict: 'pass', durationMinutes: 2 },
        { testCaseKey: 'TC-999999', verdict: 'fail' },
      ],
    });
    expect(recorded.isError, JSON.stringify(recorded.body)).toBeFalsy();
    expect(recorded.body.created).toBe(1);
    expect(recorded.body.failed).toBe(1);
    const [good, bad] = recorded.body.results as Array<Record<string, unknown>>;
    expect(good).toMatchObject({ testCaseKey: ownKey, ok: true, verdict: 'pass' });
    expect(bad).toMatchObject({ testCaseKey: 'TC-999999', ok: false });

    // A retry of the SAME request id replays the row that landed instead of recording it twice.
    const retried = await tool('rova_record_test_results', {
      build,
      runDate: '2026-11-04',
      requestId,
      results: [
        { testCaseKey: ownKey, verdict: 'pass', durationMinutes: 2 },
        { testCaseKey: 'TC-999999', verdict: 'fail' },
      ],
    });
    expect(retried.body.created).toBe(0);
    expect(retried.body.replayed).toBe(1);
    expect(retried.body.failed).toBe(1);
    expect((retried.body.results as Array<Record<string, unknown>>)[0]).toMatchObject({
      ok: true,
      replayed: true,
    });
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(testResults)
      .where(eq(testResults.build, build));
    expect(rows[0].n, 'one result for the build, not two').toBe(1);
  });

  it("save_test_case and record_test_results reach the REST refusal for an Editor outside the item's Team", async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    await ensureTestCaseType();
    const beta = await adminRest('POST', '/work-items', {
      projectId: NXP,
      type: 'story',
      title: `scope probe ${Date.now()}`,
      teamId: TEAM_BETA_ID,
    });
    expect(beta.statusCode, beta.body).toBe(201);
    const betaId = beta.json().id as string;
    const testCase = await adminRest('POST', `/work-items/${betaId}/test-cases`, {
      name: `scope case ${Date.now()}`,
    });
    expect(testCase.statusCode, testCase.body).toBe(201);
    const testCaseKey = testCase.json().testCaseKey as string;

    // The dev is an Editor on Team Alpha only; both routes authorise the parent work item.
    people.set(TOKEN, { userId: devId, workspaceId: WORKSPACE_ID });
    const restItem = await app.inject({
      method: 'GET',
      url: `/v1/work-items/${betaId}`,
      headers: { cookie: devCookie },
    });
    expect(restItem.statusCode, restItem.body).toBe(403);
    const deniedName = `nope ${Date.now()}`;
    const viaMcpCreate = await tool('rova_save_test_case', {
      workItemKey: betaId,
      name: deniedName,
    });
    expect(viaMcpCreate.isError).toBe(true);
    expect(viaMcpCreate.body.statusCode).toBe(restItem.statusCode);
    expect(viaMcpCreate.body.error).toMatchObject({ error: { code: restItem.json().error.code } });
    // A refused create writes NOTHING.
    const deniedRows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(testCases)
      .where(eq(testCases.name, deniedName));
    expect(deniedRows[0].n, 'a refused create must not leave a row').toBe(0);

    const restCase = await app.inject({
      method: 'GET',
      url: `/v1/test-cases/by-key/${encodeURIComponent(testCaseKey)}`,
      headers: { cookie: devCookie },
    });
    expect(restCase.statusCode, restCase.body).toBe(403);
    const deniedBuild = `denied-${Date.now()}`;
    const viaMcpResult = await tool('rova_record_test_results', {
      build: deniedBuild,
      runDate: '2026-11-04',
      results: [{ testCaseKey, verdict: 'pass' }],
    });
    expect(viaMcpResult.isError).toBe(true);
    const item = (viaMcpResult.body.results as Array<Record<string, unknown>>)[0];
    expect(item.statusCode).toBe(restCase.statusCode);
    expect((item.error as { error: { code: string } }).error.code).toBe(
      restCase.json<{ error: { code: string } }>().error.code,
    );
    // A refused record writes NOTHING.
    const deniedResults = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(testResults)
      .where(eq(testResults.build, deniedBuild));
    expect(deniedResults[0].n, 'a refused record must not leave a row').toBe(0);
  });
  // ── PR6: portfolio item and iteration saves ─────────────────────────────────

  it('rova_save_portfolio_item and rova_save_iteration: admin happy path, Editor 403 equals REST', async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });

    const epicName = `mcp epic ${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const epic = await tool('rova_save_portfolio_item', {
      project: 'NXP',
      type: 'epic',
      name: epicName,
    });
    expect(epic.isError, JSON.stringify(epic.body)).toBeFalsy();
    const epicKey = (epic.body.portfolioItem as Record<string, unknown>)['itemKey'] as string;
    expect(epicKey).toMatch(/^EP-/);

    const edited = await tool('rova_save_portfolio_item', {
      key: epicKey,
      description: 'edited by mcp',
    });
    expect(edited.isError, JSON.stringify(edited.body)).toBeFalsy();
    expect(edited.body.changed).toEqual(['description']);

    const iterationName = `mcp iter ${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const iteration = await tool('rova_save_iteration', {
      project: 'NXP',
      name: iterationName,
    });
    expect(iteration.isError, JSON.stringify(iteration.body)).toBeFalsy();
    const iterationId = (iteration.body.iteration as Record<string, unknown>)['id'] as string;

    const goal = await tool('rova_save_iteration', { iteration: iterationId, goal: 'ship it' });
    expect(goal.isError, JSON.stringify(goal.body)).toBeFalsy();
    expect(goal.body.changed).toEqual(['goal']);

    // An Editor (dev) holds neither portfolio:create nor iteration:create. MCP relays the REST
    // refusal byte for byte — same status and body.
    people.set(TOKEN, { userId: devId, workspaceId: WORKSPACE_ID });
    const restPortfolio = await app.inject({
      method: 'POST',
      url: '/v1/portfolio-items',
      headers: { cookie: devCsrf.cookie, [CSRF_HEADER]: devCsrf.token },
      payload: { projectId: NXP, type: 'epic', name: `${epicName} rest` },
    });
    const mcpPortfolio = await tool('rova_save_portfolio_item', {
      project: 'NXP',
      type: 'epic',
      name: `${epicName} mcp`,
    });
    expect(restPortfolio.statusCode, restPortfolio.body).toBe(403);
    expect(mcpPortfolio.isError).toBe(true);
    expect(mcpPortfolio.body.statusCode).toBe(restPortfolio.statusCode);
    expect(mcpPortfolio.body.error.error.code).toBe(restPortfolio.json().error.code);

    const restIteration = await app.inject({
      method: 'POST',
      url: '/v1/iterations',
      headers: { cookie: devCsrf.cookie, [CSRF_HEADER]: devCsrf.token },
      payload: { projectId: NXP, name: `${iterationName} rest` },
    });
    const mcpIteration = await tool('rova_save_iteration', {
      project: 'NXP',
      name: `${iterationName} mcp`,
    });
    expect(restIteration.statusCode, restIteration.body).toBe(403);
    expect(mcpIteration.isError).toBe(true);
    expect(mcpIteration.body.statusCode).toBe(restIteration.statusCode);
    expect(mcpIteration.body.error.error.code).toBe(restIteration.json().error.code);
  });

  // ── PR7: rova_delete, per kind ─────────────────────────────────────────────

  it('rova_delete: own comment and time log delete; a repeat is the generic refusal, another person’s is refused', async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    const commentBody = `delete me ${Date.now()}`;
    const comment = await adminRest('POST', `/work-items/${NXP_STORY_1_ID}/comments`, {
      body: commentBody,
    });
    expect(comment.statusCode, comment.body).toBe(201);
    const commentId = comment.json().id as string;

    const deleted = await tool('rova_delete', {
      kind: 'comment',
      key: NXP_STORY_1_ID,
      id: commentId,
    });
    expect(deleted.isError, JSON.stringify(deleted.body)).toBeFalsy();
    expect(deleted.body.deleted).toMatchObject({ kind: 'comment', id: commentId });

    const retried = await tool('rova_delete', {
      kind: 'comment',
      key: NXP_STORY_1_ID,
      id: commentId,
    });
    // A retry of a delete that already landed is the same generic refusal any missing id gets;
    // #918 deliberately does not distinguish "already deleted" from "not yours".
    expect(retried.isError).toBe(true);
    expect(retried.body.error).toMatch(/not found, or it is not yours/);

    // Someone else's comment: the guard narrows below the API (both people can edit the item).
    const theirComment = await app.inject({
      method: 'POST',
      url: `/v1/work-items/${NXP_STORY_1_ID}/comments`,
      headers: { cookie: devCsrf.cookie, [CSRF_HEADER]: devCsrf.token },
      payload: { body: `not yours ${Date.now()}` },
    });
    expect(theirComment.statusCode, theirComment.body).toBe(201);
    const refused = await tool('rova_delete', {
      kind: 'comment',
      key: NXP_STORY_1_ID,
      id: theirComment.json().id as string,
    });
    expect(refused.isError).toBe(true);
    expect(refused.body.error).toMatch(/your own comment/);

    // A time log follows the same rule.
    const story = await freshStory();
    const logged = await tool('rova_log_time', {
      key: story,
      hours: 1,
      date: '2026-11-05',
      description: `delete log ${Date.now()}`,
    });
    expect(logged.isError, JSON.stringify(logged.body)).toBeFalsy();
    const logId = (logged.body.timeLog as Record<string, unknown>)['id'] as string;
    const logDeleted = await tool('rova_delete', { kind: 'time_log', key: story, id: logId });
    expect(logDeleted.isError, JSON.stringify(logDeleted.body)).toBeFalsy();
    const logRetry = await tool('rova_delete', { kind: 'time_log', key: story, id: logId });
    expect(logRetry.isError).toBe(true);
    expect(logRetry.body.error).toMatch(/not found, or it is not yours/);
  });

  it('rova_delete: a relation you did not create is refused; a repeat is the generic refusal', async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    const target = await freshStory();
    const relation = await adminRest('POST', `/work-items/${NXP_STORY_1_ID}/relations`, {
      targetId: target,
      relationType: 'relates_to',
    });
    expect(relation.statusCode, relation.body).toBe(201);
    const relations = await adminRest('GET', `/work-items/${NXP_STORY_1_ID}/relations`);
    const rows = relations.json<{ id: string; relatedItem: { id: string } }[]>();
    const created = rows.find((row) => row.relatedItem?.id === target);
    expect(created, 'the new relation is in the list').toBeTruthy();

    // dev can EDIT the item but did not create this link.
    people.set(TOKEN, { userId: devId, workspaceId: WORKSPACE_ID });
    const refused = await tool('rova_delete', {
      kind: 'relation',
      key: NXP_STORY_1_ID,
      id: created!.id,
    });
    expect(refused.isError).toBe(true);
    expect(refused.body.error).toMatch(/relation you created/);

    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    const deleted = await tool('rova_delete', {
      kind: 'relation',
      key: NXP_STORY_1_ID,
      id: created!.id,
    });
    expect(deleted.isError, JSON.stringify(deleted.body)).toBeFalsy();

    const retry = await tool('rova_delete', {
      kind: 'relation',
      key: NXP_STORY_1_ID,
      id: created!.id,
    });
    expect(retry.isError).toBe(true);
    expect(retry.body.error).toMatch(/not found, or it is not yours/);
  });

  it('rova_delete: a test result recorded by someone else is refused; your own deletes, a repeat is the generic refusal', async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    await ensureTestCaseType();
    const story = await freshStory();
    const testCase = await adminRest('POST', `/work-items/${story}/test-cases`, {
      name: `delete result case ${Date.now()}`,
    });
    expect(testCase.statusCode, testCase.body).toBe(201);
    const testCaseKey = testCase.json().testCaseKey as string;
    const build = `delete-result-${Date.now()}`;
    const recorded = await tool('rova_record_test_results', {
      build,
      runDate: '2026-11-05',
      results: [{ testCaseKey, verdict: 'pass' }],
    });
    expect(recorded.isError, JSON.stringify(recorded.body)).toBeFalsy();
    const resultId = (recorded.body.results as Array<Record<string, unknown>>)[0]['id'] as string;
    expect(resultId).toBeTruthy();

    people.set(TOKEN, { userId: devId, workspaceId: WORKSPACE_ID });
    const refused = await tool('rova_delete', {
      kind: 'test_result',
      key: testCaseKey,
      id: resultId,
    });
    expect(refused.isError).toBe(true);
    expect(refused.body.error).toMatch(/recorded/);

    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    const deleted = await tool('rova_delete', {
      kind: 'test_result',
      key: testCaseKey,
      id: resultId,
    });
    expect(deleted.isError, JSON.stringify(deleted.body)).toBeFalsy();
    const retry = await tool('rova_delete', {
      kind: 'test_result',
      key: testCaseKey,
      id: resultId,
    });
    expect(retry.isError).toBe(true);
    expect(retry.body.error).toMatch(/not found, or it is not yours/);
  });

  it("rova_delete: someone else's time log is refused, even on an item you can edit", async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    const story = await freshStory();
    const logged = await tool('rova_log_time', {
      key: story,
      hours: 2,
      date: '2026-11-05',
      description: `their log ${Date.now()}`,
    });
    expect(logged.isError, JSON.stringify(logged.body)).toBeFalsy();
    const logId = (logged.body.timeLog as Record<string, unknown>)['id'] as string;

    people.set(TOKEN, { userId: devId, workspaceId: WORKSPACE_ID });
    const refused = await tool('rova_delete', { kind: 'time_log', key: story, id: logId });
    expect(refused.isError).toBe(true);
    expect(refused.body.error).toMatch(/your own time log/);
  });

  it('rova_delete: a task deletes', async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    const title = `delete story ${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const created = await adminRest('POST', '/work-items', {
      projectId: NXP,
      type: 'story',
      title,
      teamId: TEAM_ALPHA_ID,
    });
    expect(created.statusCode, created.body).toBe(201);
    const story = created.json().id as string;
    const task = await tool('rova_add_task', {
      parentKey: story,
      title: `doomed task ${Date.now()}`,
    });
    expect(task.isError, JSON.stringify(task.body)).toBeFalsy();
    const taskItem = task.body.workItem as Record<string, unknown>;
    const taskKey = taskItem['itemKey'] as string;
    const taskId = taskItem['id'] as string;

    const taskDeleted = await tool('rova_delete', { kind: 'task', key: taskKey });
    expect(taskDeleted.isError, JSON.stringify(taskDeleted.body)).toBeFalsy();
    expect(taskDeleted.body.deleted).toMatchObject({ kind: 'task', id: taskId });

    const taskRetry = await tool('rova_delete', { kind: 'task', key: taskKey });
    expect(taskRetry.isError).toBe(true);
    expect(taskRetry.body.error).toMatch(/not found, or it is not yours/);
  });
});
