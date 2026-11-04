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
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../apps/api/src/app.module';
import { registerMcpRoute, type McpAccessVerifier } from '../../apps/api/src/mcp';
import { setMcpWritesEnabled } from '../../apps/api/src/mcp/write-policy';
import { bootstrapApp } from '../../apps/api/src/bootstrap/app.bootstrap';
import { CSRF_HEADER, CSRF_SECRET_COOKIE, DRIZZLE, type DrizzleDB } from '@platform';
import { users } from '../../db/schema/identity';
import { comments, timeLogs, workItems } from '../../db/schema/work';
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

  it('an idempotent replay returns the SAME time-log id, not a duplicate', async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    const args = {
      key: NXP_STORY_1_ID,
      hours: 1.5,
      date: '2026-06-20',
      description: `replay probe ${Date.now()}`,
    };
    const first = await tool('rova_log_time', args);
    const second = await tool('rova_log_time', args);
    expect(first.isError, JSON.stringify(first.body)).toBeFalsy();
    expect(second.isError, JSON.stringify(second.body)).toBeFalsy();
    expect(second.body.timeLog.id).toBe(first.body.timeLog.id);
    // ONE row, not merely one id in the response: the replay must not have written twice.
    const [{ rows }] = await db
      .select({ rows: sql<number>`count(*)::int` })
      .from(timeLogs)
      .where(eq(timeLogs.description, args.description));
    expect(Number(rows)).toBe(1);
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

  it('rova_add_comment replays to the SAME comment id on a work item and on a portfolio item', async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });

    const itemBody = `replay item comment ${Date.now()}`;
    const first = await tool('rova_add_comment', { workItemKey: NXP_STORY_1_ID, body: itemBody });
    const second = await tool('rova_add_comment', { workItemKey: NXP_STORY_1_ID, body: itemBody });
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
    const p1 = await tool('rova_add_comment', { portfolioItemKey: key, body: portfolioBody });
    const p2 = await tool('rova_add_comment', { portfolioItemKey: key, body: portfolioBody });
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

  it('rova_link_work_items creates one relation, and a duplicate is refused exactly as REST', async () => {
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
    expect((first.body.relations as unknown[]).length).toBeGreaterThan(0);

    const rest = await adminRest('POST', `/work-items/${from}/relations`, {
      targetId: to,
      relationType: 'relates_to',
    });
    expect(rest.statusCode, rest.body).toBe(412);
    const duplicate = await tool('rova_link_work_items', {
      fromKey: from,
      toKey: to,
      relationType: 'relates_to',
    });
    expect(duplicate.isError).toBe(true);
    expect(duplicate.body.statusCode).toBe(rest.statusCode);
    expect(duplicate.body.error).toMatchObject({
      error: { code: 'WORK_ITEM_RELATION_EXISTS' },
    });
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
});
