import { setUserBanned, type Identity } from '@quynhonsemiconductor/identity';
import { AUTH } from '@quynhonsemiconductor/identity/nest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { AppModule } from '../../apps/api/src/app.module';
import { bootstrapApp } from '../../apps/api/src/bootstrap/app.bootstrap';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerMcpRoute } from '../../apps/api/src/mcp/index';
import type { McpAccessPrincipal, McpAccessVerifier } from '../../apps/api/src/mcp/index';
import { PAY_ITER_ID, PAY_STORY_ID, WORKSPACE_ID } from '../../db/seeds/constants';
import { provisionUser, readCookie } from './support/session';

// The seeded NXP project (db/seeds SEED_PROJECTS[0]) — the stranger holds no membership in
// it, so every project-scoped tool must be denied by its route.
const STRANGER_PROJECT = '00000000-0000-7000-8000-000000000010';
const STRANGER_ITEM = PAY_STORY_ID; // the stranger holds no membership in PAY either
const STRANGER_ITERATION = PAY_ITER_ID;

/**
 * `/mcp` through the REAL guard chain (real AppModule, real bootstrap, real Valkey, real
 * PolicyGuard), with only the Access-JWT verifier bound directly to fixture people — the one
 * piece that does not exist until the app-platform `identity/access-jwt` release. Pins what the
 * unit specs cannot:
 *
 *  - GUARD ORDER is real: a banned person's MCP call is refused by identity's SessionGuard ban
 *    check, through the bridge, on the injected call — only the live chain proves it.
 *  - the legacy credentials still behave with McpModule in the chain: session cookie and `rly_`
 *    token both reach /v1/auth/me as before.
 *  - BUCKETS, exactly: one MCP tool POST costs `mcp:uid:<person>` (the route), `PRE_AUTH:uid:<person>`
 *    (the pre-auth floor, peeked from the call token — never `PRE_AUTH:ip:127.0.0.1`) and
 *    `DEFAULT:uid:<person>` (the injected REST call) — and nothing else.
 */

const VERIFIER_TOKEN_PREFIX = 'e2e-access.';

describe('/mcp over the real guard chain (e2e)', () => {
  // CI runs the e2e suite with DISABLE_RATE_LIMIT=true and BOTH rate-limit guards read it at
  // construction — without this, the bucket test below would see only the route's own mcp:uid
  // key and the no-:ip: check would be vacuous. Same pattern as rate-limit-keying.e2e.spec.ts.
  const previous = process.env['DISABLE_RATE_LIMIT'];
  let app: NestFastifyApplication;
  let fastify: FastifyInstance;
  /** The Access adapter stand-in: each test binds its own fixture person to a bearer token. */
  const people = new Map<string, McpAccessPrincipal>();
  const verifier: McpAccessVerifier = {
    verify: async (bearer) => people.get(bearer) ?? null,
  };

  async function bindPerson(label: string): Promise<{ token: string; userId: string }> {
    const { userId } = await provisionUser(app, label, `E2E ${label}`);
    const token = `${VERIFIER_TOKEN_PREFIX}${label}-${userId.slice(0, 8)}`;
    people.set(token, { userId, workspaceId: WORKSPACE_ID });
    return { token, userId };
  }

  interface JsonRpcResponse {
    result?: { content?: { type: string; text: string }[] };
  }

  /** One JSON-RPC POST (accept header included: the transport refuses without both media types). */
  async function rpc(
    token: string,
    body: object,
  ): Promise<{ statusCode: number; json: JsonRpcResponse }> {
    const res = await fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      payload: body,
    });
    return { statusCode: res.statusCode, json: res.json<JsonRpcResponse>() };
  }

  async function toolsList(token: string): Promise<string[]> {
    await initialize(token);
    const list = await rpc(token, { jsonrpc: '2.0', id: 0, method: 'tools/list' });
    const r = list.json as { result?: { tools?: { name: string }[] } };
    return r.result!.tools!.map((t) => t.name).sort();
  }

  async function callWhoami(
    token: string,
  ): Promise<{ statusCode: number; out: Record<string, unknown> }> {
    const init = await rpc(token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'e2e', version: '0.0.0' },
      },
    });
    expect(init.statusCode, JSON.stringify(init.json)).toBe(200);
    const res = await rpc(token, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'whoami', arguments: {} },
    });
    expect(res.statusCode, JSON.stringify(res.json)).toBe(200);
    return {
      statusCode: res.statusCode,
      out: JSON.parse(res.json.result!.content![0].text) as Record<string, unknown>,
    };
  }

  async function initialize(token: string) {
    const init = await rpc(token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'e2e', version: '0.0.0' },
      },
    });
    expect(init.statusCode, JSON.stringify(init.json)).toBe(200);
  }

  async function callTool(
    token: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await initialize(token);
    const res = await rpc(token, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    expect(res.statusCode, JSON.stringify(res.json) || name).toBe(200);
    const text = res.json.result!.content![0].text;
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`tool ${name} returned non-JSON content: ${text.slice(0, 300)}`);
    }
  }

  beforeAll(async () => {
    process.env['DISABLE_RATE_LIMIT'] = 'false';
    // The production boot: real AppModule + bootstrapApp, with the /mcp route registered BEFORE
    // the server is ready (a Fastify instance refuses routes after `.ready()`). MCP_ENABLED stays
    // false for the bootstrap itself — the e2e pins the GUARDS, not the env flag.
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter({ logger: false, trustProxy: true }),
      { bufferLogs: true, logger: false, abortOnError: false },
    );
    await bootstrapApp(app);
    fastify = app.getHttpAdapter().getInstance();
    registerMcpRoute({
      app,
      fastify,
      verifier,
      cache: app.get(CacheService),
      serverVersion: 'e2e',
    });
    await app.init();
    await fastify.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (previous === undefined) delete process.env['DISABLE_RATE_LIMIT'];
    else process.env['DISABLE_RATE_LIMIT'] = previous;
  });

  it('a tool returns what the person themselves sees: whoami over the bridge', async () => {
    const { token, userId } = await bindPerson('mcp-whoami');
    const { out } = await callWhoami(token);
    // the profile id IS the identity user id; the bridge delivered exactly this principal
    expect(out.id).toBe(userId);
  });

  it('a banned person is refused through the bridge — SessionGuard’s ban check fires on the injected call', async () => {
    const { token } = await bindPerson('mcp-banned');
    expect((await callWhoami(token)).out.id).toBeTruthy();

    const auth = app.get<Identity>(AUTH);
    const { userId } = people.get(token)!;
    try {
      await setUserBanned(auth, userId, true, 'e2e: ban the mcp user');
      const { out } = await callWhoami(token);
      // the tool relayed the person's own 401, unchanged
      expect(out['statusCode']).toBe(401);
    } finally {
      await setUserBanned(auth, userId, false);
    }
    // reinstated: the same token works again
    expect((await callWhoami(token)).out.id).toBe(userId);
  });

  it('the legacy credentials still work with McpModule in the chain', async () => {
    // one bridged person in the map, one plain session user: the legacy paths ignore the map
    await bindPerson('mcp-legacy');
    const { credential, userId } = await provisionUser(
      app,
      'mcp-legacy-session',
      'E2E mcp legacy session',
    );

    // session cookie
    const session = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: credential },
    });
    expect(session.statusCode).toBe(200);

    // an API token, minted the normal way: the CSRF token comes from the session's own /auth/me,
    // and the secret cookie it is HMAC-bound to comes off the same response's set-cookie
    const csrf = session.json<{ csrfToken?: string }>().csrfToken;
    expect(csrf).toBeTruthy();
    const csrfSecret = readCookie(session.headers['set-cookie'], '__Host-rova_csrf');
    expect(csrfSecret).toBeTruthy();
    const mint = await app.inject({
      method: 'POST',
      url: '/v1/me/api-tokens',
      headers: { cookie: `${credential}; ${csrfSecret}`, 'x-csrf-token': csrf! },
      payload: { name: 'e2e mcp legacy' },
    });
    expect(mint.statusCode, mint.body).toBe(201);
    const created = JSON.parse(mint.body) as { token: string };
    const probe = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(probe.statusCode).toBe(200);
    expect(probe.json<{ id?: string }>().id).toBe(userId);
  });

  describe('per-tool principal denials (gate g, per tool — not just at the transport)', () => {
    // The denial matrix against REAL seeded fixtures (NXP/PAY from db/seeds): a stranger who
    // IS a workspace member but holds NO project roles — every project/resource-scoped tool
    // is refused BY ITS ROUTE (PolicyGuard 403 relayed). Tools whose route resolves the
    // resource first (by-key, activity, comments, :id/status) 404 on the unknown sentinel.
    // The three SelfScoped tools (whoami, my_work, unread_notifications) keep working:
    // self-scoped is subtract-only.
    const TOOL_ARGS: Record<string, Record<string, unknown>> = {
      whoami: {},
      list_projects: {},
      get_project: { projectId: STRANGER_PROJECT },
      list_project_members: { projectId: STRANGER_PROJECT },
      search_work_items: { projectId: STRANGER_PROJECT },
      get_work_item: { workItemId: STRANGER_ITEM },
      get_work_item_by_key: { itemKey: 'OBSE-1' },
      my_work: {},
      list_backlog: { projectId: STRANGER_PROJECT },
      work_item_activity: { workItemId: STRANGER_ITEM },
      list_iterations: { projectId: STRANGER_PROJECT },
      iteration_options: { projectId: STRANGER_PROJECT },
      iteration_status: { iterationId: STRANGER_ITERATION },
      list_comments: { workItemId: STRANGER_ITEM },
      list_releases: { projectId: STRANGER_PROJECT },
      list_milestones: { projectId: STRANGER_PROJECT },
      iteration_burndown: { projectId: STRANGER_PROJECT, iterationId: STRANGER_ITERATION },
      velocity: { projectId: STRANGER_PROJECT },
      team_capacity: { projectId: STRANGER_PROJECT, iterationId: STRANGER_ITERATION },
      unread_notifications: {},
    };
    // SelfScoped: the caller's own data — must keep working for any member.
    const SELF_SCOPED = new Set(['whoami', 'my_work', 'unread_notifications']);
    // @AuthorizedInService / AccessService-scoped lists: the guard passes, the result is
    // EMPTY (a no-membership principal can read nothing) — not a denial.
    const EMPTY_OK = new Set([
      'list_projects',
      'search_work_items',
      'list_backlog',
      'my_work',
      'list_iterations',
    ]);

    it('the denial matrix is derived from the live tools/list and covers every tool', async () => {
      const { token } = await bindPerson('mcp-matrix');
      const live = await toolsList(token);
      expect(live.sort()).toEqual(Object.keys(TOOL_ARGS).sort());
      const { TOOL_ROUTES } = await import('../../apps/api/src/mcp/tools/registry');
      expect(live.sort()).toEqual(Object.keys(TOOL_ROUTES).sort());
    });

    it('a no-membership principal: scoped tools 403 by their route, in-service lists run EMPTY, SelfScoped works', async () => {
      const stranger = await provisionUser(app, 'mcp-stranger', 'E2E mcp stranger');
      const token = `${VERIFIER_TOKEN_PREFIX}stranger-${stranger.userId.slice(0, 8)}`;
      people.set(token, { userId: stranger.userId, workspaceId: WORKSPACE_ID });
      // the stranger holds NO project roles in NXP/PAY

      await initialize(token);
      for (const [name, args] of Object.entries(TOOL_ARGS)) {
        const out = await callTool(token, name, args);
        if (SELF_SCOPED.has(name)) {
          expect(out.statusCode, `${name} (self-scoped) should have worked`).toBeUndefined();
        } else if (EMPTY_OK.has(name)) {
          // AccessService-scoped list: 200 with zero rows the person can read
          const rows =
            out[
              name
                .split('_')
                .map((w) => w[0])
                .join('')
            ] ??
            out['items'] ??
            out['projects'];
          expect(Array.isArray(rows) ? rows.length : 0, `${name}: must be empty`).toBe(0);
        } else {
          expect(out.statusCode, `${name} must be denied by its route`).toBe(403);
        }
      }
    });

    it('unknown ids answer 404 per route — separate from the denial', async () => {
      const token = `${VERIFIER_TOKEN_PREFIX}unknown-${randomUUID().slice(0, 8)}`;
      const { userId } = await provisionUser(app, 'mcp-unknown', 'E2E mcp unknown');
      people.set(token, { userId, workspaceId: WORKSPACE_ID });
      await initialize(token);
      const UNKNOWN = '00000000-0000-7000-8000-000000004044';
      for (const [name, args] of Object.entries({
        get_project: { projectId: UNKNOWN },
        get_work_item: { workItemId: UNKNOWN },
        work_item_activity: { workItemId: UNKNOWN },
        iteration_status: { iterationId: UNKNOWN },
      })) {
        const out = await callTool(token, name, args);
        expect(out.statusCode, `${name}: unknown id must be 404`).toBe(404);
      }
    });

    it('an OFFBOARDED principal is denied on EVERY tool — the routes refuse, the tools relay', async () => {
      const { token, userId } = await bindPerson('mcp-offboarded');
      const auth = app.get<Identity>(AUTH);
      try {
        await setUserBanned(auth, userId, true, 'e2e: offboard the mcp user');
        await initialize(token);
        for (const [name, args] of Object.entries(TOOL_ARGS)) {
          const out = await callTool(token, name, args);
          expect(String(out.statusCode), `${name} must relay the ban denial`).toMatch(/401|403/);
        }
      } finally {
        await setUserBanned(auth, userId, false);
      }
      // reinstated: the same tool works again, as the person themselves
      const out = await callTool(token, 'whoami', {});
      expect(out.statusCode).toBeUndefined();
      expect(out.id).toBe(userId);
    });
  });

  it('one tool POST touches exactly the per-person buckets — never the shared loopback bucket', async () => {
    const cache = app.get(CacheService);
    const redis = cache.instance; // throws if the cache is disabled: this test needs the real floor
    const { token, userId } = await bindPerson('mcp-buckets');

    const before = new Set(await redis.keys('*'));
    await callWhoami(token);
    const added = (await redis.keys('*')).filter((key) => !before.has(key)).sort();

    // the three rate-limit buckets, under the cache's key prefix (`rova:rl:`), all keyed by PERSON
    expect(added.filter((key) => key.includes(':rl:')).sort()).toEqual([
      `rova:rl:DEFAULT:uid:${userId}`, // RateLimitGuard, on the injected REST call
      `rova:rl:PRE_AUTH:uid:${userId}`, // PreAuthRateLimitGuard, keyed by the peeked call token
      `rova:rl:mcp:uid:${userId}`, // the /mcp route's own per-person budget
    ]);
    // belt: nothing address-keyed was created by this request at all (the permission cache also
    // writes a `rova:authz:` key while provisioning, so the filter above is not optional)
    expect(added.some((key) => key.includes(':ip:'))).toBe(false);
  });
});
