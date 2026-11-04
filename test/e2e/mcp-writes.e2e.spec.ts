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
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../apps/api/src/app.module';
import { registerMcpRoute, type McpAccessVerifier } from '../../apps/api/src/mcp';
import { setMcpWritesEnabled } from '../../apps/api/src/mcp/write-policy';
import { bootstrapApp } from '../../apps/api/src/bootstrap/app.bootstrap';
import { CSRF_HEADER, CSRF_SECRET_COOKIE, DRIZZLE, type DrizzleDB } from '@platform';
import { users } from '../../db/schema/identity';
import { NXP_STORY_1_ID, WORKSPACE_ID } from '../../db/seeds/constants';
import { readCookie, signIn } from './support/session';

const TOKEN = 'e2e.access.writes';

describe('/mcp write tools (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DrizzleDB;
  let people = new Map<string, { userId: string; workspaceId: string }>();
  let adminCookie: string;
  let viewerCookie: string;
  let adminCsrf: { cookie: string; token: string };
  let adminId: string;
  let viewerId: string;

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
    // CSRF, exactly as the SPA obtains it: /v1/auth/me plants the secret cookie + token.
    const me = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: adminCookie },
    });
    // readCookie returns the `name=value` pair, so these compose directly.
    adminCsrf = {
      cookie: `${adminCookie}; ${readCookie(me.headers['set-cookie'], CSRF_SECRET_COOKIE)}`,
      token: me.json().csrfToken as string,
    };
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
    expect(viaMcp.body.statusCode).toBe(rest.statusCode);
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
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.body.statusCode).toBe(rest.statusCode);
    // The envelope carries a per-request correlationId; compare the refusal itself.
    const strip = (body: unknown): unknown => {
      const copy = JSON.parse(JSON.stringify(body)) as { error?: { correlationId?: string } };
      if (copy.error) delete copy.error.correlationId;
      return copy;
    };
    expect(strip(viaMcp.body.error)).toEqual(strip(rest.json()));
  });

  it('an idempotent replay returns the SAME time-log id, not a duplicate', async () => {
    people.set(TOKEN, { userId: adminId, workspaceId: WORKSPACE_ID });
    const args = {
      key: NXP_STORY_1_ID,
      hours: 1.5,
      date: '2026-06-20',
      description: 'replay probe',
    };
    const first = await tool('rova_log_time', args);
    const second = await tool('rova_log_time', args);
    expect(first.isError, JSON.stringify(first.body)).toBeFalsy();
    expect(second.isError, JSON.stringify(second.body)).toBeFalsy();
    expect(second.body.timeLog.id).toBe(first.body.timeLog.id);
  });
});
