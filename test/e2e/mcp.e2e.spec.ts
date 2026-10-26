import { setUserBanned, type Identity } from '@quynhonsemiconductor/identity';
import { AUTH } from '@quynhonsemiconductor/identity/nest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { DRIZZLE, type DrizzleDB } from '@platform';
import { AppModule } from '../../apps/api/src/app.module';
import { bootstrapApp } from '../../apps/api/src/bootstrap/app.bootstrap';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerMcpRoute } from '../../apps/api/src/mcp/index';
import type { McpAccessPrincipal, McpAccessVerifier } from '../../apps/api/src/mcp/index';
import { CSRF_HEADER, CSRF_SECRET_COOKIE } from '@platform';
import {
  NXP_FEATURE_3_ID,
  NXP_ITER_CURRENT_ID,
  NXP_MILESTONE_1_ID,
  NXP_RELEASE_1_ID,
  NXP_STORY_1_ID,
  PAY_PROJECT_ID,
  PAY_STORY_ID,
  SEED_PROJECTS,
  WORKSPACE_ID,
  PAY_ITER_ID,
} from '../../db/seeds/constants';
import { provisionUser, readCookie, signInAs } from './support/session';

// The seeded NXP project (db/seeds SEED_PROJECTS[0]) — the stranger holds no membership in
// it, so every project-scoped tool must be denied by its route.
const NXP_PROJECT_ID = SEED_PROJECTS[0].id;
const STRANGER_PROJECT = NXP_PROJECT_ID;
const STRANGER_ITEM = PAY_STORY_ID; // the stranger holds no membership in PAY either
// set by the happy-path test once the carryover fixture iterations exist (CASES is static)
const carryoverIteration = { id: NXP_ITER_CURRENT_ID };
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
      params: { name: 'rova_whoami', arguments: {} },
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
    opts: { skipInitialize?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    // The stateless route does not require a prior initialize (nothing in route.ts checks
    // for one); callers that loop over many tools skip it to stay under the per-person
    // MCP rate budget (26 tools x 2 POSTs would exceed the 60/min budget on its own).
    if (!opts.skipInitialize) await initialize(token);
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
      rova_whoami: {},
      rova_list_projects: {},
      rova_get_project: { projectId: STRANGER_PROJECT },
      rova_list_project_members: { projectId: STRANGER_PROJECT },
      rova_search_work_items: { projectId: STRANGER_PROJECT },
      rova_get_work_item: { workItemId: STRANGER_ITEM },
      rova_get_work_item_by_key: { itemKey: 'US-1' }, // the seeded NXP story — stranger has no access
      rova_my_work: {},
      rova_list_backlog: { projectId: STRANGER_PROJECT },
      rova_work_item_activity: { workItemId: STRANGER_ITEM },
      rova_list_iterations: { projectId: STRANGER_PROJECT },
      rova_iteration_options: { projectId: STRANGER_PROJECT },
      rova_iteration_status: { iterationId: STRANGER_ITERATION },
      rova_list_comments: { workItemId: STRANGER_ITEM },
      rova_list_releases: { projectId: STRANGER_PROJECT },
      rova_list_milestones: { projectId: STRANGER_PROJECT },
      rova_iteration_burndown: { projectId: STRANGER_PROJECT, iterationId: STRANGER_ITERATION },
      rova_velocity: { projectId: STRANGER_PROJECT },
      rova_team_capacity: { projectId: STRANGER_PROJECT, iterationId: STRANGER_ITERATION },
      rova_unread_notifications: {},
      // The six new tools: TC-1 is the seeded NXP test case (the stranger has no NXP
      // membership); the quality/team-status/report tools are project-scoped to PAY.
      rova_list_test_cases: { workItemId: PAY_STORY_ID },
      rova_get_test_case_by_key: { testCaseKey: 'TC-1' },
      rova_quality_defects: { projectId: PAY_PROJECT_ID },
      rova_team_status: { projectId: PAY_PROJECT_ID, iterationId: PAY_ITER_ID },
      rova_list_portfolio_items: { type: 'epic' },
      // NXP_FEATURE_3: the seeded Feature WITH children (2 stories linked, demo.ts)
      rova_get_portfolio_item: { portfolioItemId: NXP_FEATURE_3_ID },
      // The eight tools of PR B: the resource/report-scoped ones deny the stranger via
      // their route; the AccessService-scoped lists run EMPTY (see EMPTY_OK below).
      rova_carryover_report: { projectId: NXP_PROJECT_ID, iterationId: NXP_ITER_CURRENT_ID },
      rova_release_tracking: { projectId: NXP_PROJECT_ID, releaseId: NXP_RELEASE_1_ID },
      rova_get_release: { releaseId: NXP_RELEASE_1_ID },
      rova_get_milestone: { milestoneId: NXP_MILESTONE_1_ID },
      rova_project_health: {},
      rova_work_item_code_changes: { workItemId: PAY_STORY_ID },
      rova_list_teams: {},
      rova_list_notifications: {},
    };
    // SelfScoped: the caller's own data — must keep working for any member.
    const SELF_SCOPED = new Set([
      'rova_whoami',
      'rova_my_work',
      'rova_unread_notifications',
      'rova_list_notifications',
    ]);
    // ONLY list_projects is AccessService-scoped (the guard passes; listReadableProjectIds
    // returns zero rows for a no-role member): 200 with an EMPTY list. search_work_items,
    // list_backlog and list_iterations are PolicyGuard-gated (`work_item:view` /
    // `timebox:view` / `iteration:view` from the projectId) — a no-role member is denied 403.
    const EMPTY_OK = new Set([
      'rova_list_projects',
      'rova_list_portfolio_items',
      'rova_project_health',
      'rova_list_teams',
    ]);
    // the rows key is each of these tools' own list key (the rest use `projects`)
    const EMPTY_KEYS: Record<string, string> = {
      rova_list_portfolio_items: 'portfolioItems',
      rova_list_teams: 'teams',
    };
    // Explicitly PolicyGuard-gated tools (permission from the projectId query or the resource):
    // a no-role member is denied 403 per route.
    const POLICY_403 = new Set([
      'rova_search_work_items',
      'rova_list_backlog',
      'rova_list_iterations',
      'rova_quality_defects',
      'rova_team_status',
      'rova_get_test_case_by_key',
      'rova_list_test_cases',
      'rova_get_project',
      'rova_list_project_members',
      'rova_carryover_report',
      'rova_release_tracking',
      'rova_get_release',
      'rova_get_milestone',
      'rova_work_item_code_changes',
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
      // skipInitialize: 34 tools x 2 POSTs would blow the per-person 60/min MCP budget
      for (const [name, args] of Object.entries(TOOL_ARGS)) {
        const out = await callTool(token, name, args, { skipInitialize: true });
        if (SELF_SCOPED.has(name)) {
          expect(out.statusCode, `${name} (self-scoped) should have worked`).toBeUndefined();
        } else if (EMPTY_OK.has(name)) {
          // AccessService-scoped lists (the guard passes; listReadableProjectIds returns zero
          // rows for a no-role member): 200 with an EMPTY list under the tool's own list key
          const key = EMPTY_KEYS[name] ?? 'projects';
          const rows = out[key] as unknown[];
          expect(Array.isArray(rows), `${name} must return a list`).toBe(true);
          expect(rows.length, `${name} must be empty for a no-role member`).toBe(0);
        } else if (POLICY_403.has(name)) {
          expect(out.statusCode, `${name} must be denied by its route`).toBe(403);
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
      // get_project 403s on unknown ids on purpose: PolicyGuard denies before the project
      // lookup, so a non-member cannot probe which ids exist (no existence leak).
      for (const [name, args] of Object.entries({
        rova_get_work_item: { workItemId: UNKNOWN },
        rova_work_item_activity: { workItemId: UNKNOWN },
        rova_iteration_status: { iterationId: UNKNOWN },
      })) {
        const out = await callTool(token, name, args);
        expect(out.statusCode, `${name}: unknown id must be 404`).toBe(404);
      }
      const projectProbe = await callTool(token, 'rova_get_project', { projectId: UNKNOWN });
      expect(projectProbe.statusCode, 'get_project: unknown id must be 403 (no leak)').toBe(403);
    });

    it('unread_notifications counts ONLY the caller — exact +1 for their row, other users excluded', async () => {
      const { inAppNotifications } = await import('../../db/schema/notifications');
      const db = app.get<DrizzleDB>(DRIZZLE);

      const mine = await bindPerson('mcp-unread-mine');
      const other = await provisionUser(app, 'mcp-unread-other', 'E2E mcp unread other');

      // baseline: no unread rows for anyone
      const before = await callTool(mine.token, 'rova_unread_notifications', {});
      expect(Number(before.count)).toBe(0);

      // the caller's own row: exactly +1
      await db.insert(inAppNotifications).values({
        workspaceId: WORKSPACE_ID,
        recipientId: mine.userId,
        type: 'WORK_ITEM_ASSIGNED',
        title: 'for the mcp caller',
      });
      const withMine = await callTool(mine.token, 'rova_unread_notifications', {});
      expect(Number(withMine.count)).toBe(Number(before.count) + 1);

      // a second user's unread row must NOT move the caller's count
      await db.insert(inAppNotifications).values({
        workspaceId: WORKSPACE_ID,
        recipientId: other.userId,
        type: 'WORK_ITEM_ASSIGNED',
        title: 'for the other user only',
      });
      const again = await callTool(mine.token, 'rova_unread_notifications', {});
      expect(Number(again.count)).toBe(Number(before.count) + 1);
    });

    it('an OFFBOARDED principal is denied on EVERY tool — the routes refuse, the tools relay', async () => {
      const { token, userId } = await bindPerson('mcp-offboarded');
      const auth = app.get<Identity>(AUTH);
      try {
        await setUserBanned(auth, userId, true, 'e2e: offboard the mcp user');
        await initialize(token);
        // skipInitialize: 34 tools x 2 POSTs would blow the per-person 60/min MCP budget
        for (const [name, args] of Object.entries(TOOL_ARGS)) {
          const out = await callTool(token, name, args, { skipInitialize: true });
          expect(String(out.statusCode), `${name} must relay the ban denial`).toMatch(/401|403/);
        }
      } finally {
        await setUserBanned(auth, userId, false);
      }
      // reinstated: the same tool works again, as the person themselves
      const out = await callTool(token, 'rova_whoami', {});
      expect(out.statusCode).toBeUndefined();
      expect(out.id).toBe(userId);
    });
  });

  // HAPPY-PATH OUTPUT SHAPE (per tool): the documented output fields are present and
  // non-undefined, with the names the REST DTO uses. Args hit REAL seeded data, so a wrong
  // field mapping — the class of bug the delta review caught in get_portfolio_item /
  // team_status / quality_defects — fails here instead of at an agent's first question.
  describe('happy-path output shape, per tool', () => {
    const CASES: Array<{ name: string; args: Record<string, unknown>; fields: string[] }> = [
      { name: 'rova_whoami', args: {}, fields: ['id', 'email', 'displayName', 'memberships'] },
      { name: 'rova_list_projects', args: {}, fields: ['projects', 'pageInfo'] },
      {
        name: 'rova_get_project',
        args: { projectId: PAY_PROJECT_ID },
        fields: ['id', 'key', 'name', 'status'],
      },
      {
        name: 'rova_list_project_members',
        args: { projectId: PAY_PROJECT_ID },
        fields: ['members'],
      },
      {
        name: 'rova_search_work_items',
        args: { projectId: PAY_PROJECT_ID },
        fields: ['items', 'pageInfo'],
      },
      {
        name: 'rova_get_work_item',
        args: { workItemId: PAY_STORY_ID },
        fields: ['id', 'itemKey', 'title', 'scheduleState'],
      },
      {
        name: 'rova_get_work_item_by_key',
        args: { itemKey: 'US-1' },
        fields: ['id', 'itemKey', 'title'],
      },
      { name: 'rova_my_work', args: {}, fields: ['items'] },
      {
        name: 'rova_list_backlog',
        args: { projectId: PAY_PROJECT_ID },
        fields: ['items', 'pageInfo'],
      },
      {
        name: 'rova_work_item_activity',
        args: { workItemId: PAY_STORY_ID },
        fields: ['activity', 'total'],
      },
      {
        name: 'rova_list_iterations',
        args: { projectId: PAY_PROJECT_ID },
        fields: ['iterations'],
      },
      {
        name: 'rova_iteration_options',
        args: { projectId: PAY_PROJECT_ID },
        fields: ['iterations'],
      },
      {
        name: 'rova_iteration_status',
        args: { iterationId: PAY_ITER_ID },
        fields: ['iteration', 'metrics', 'items'],
      },
      { name: 'rova_list_comments', args: { workItemId: PAY_STORY_ID }, fields: ['comments'] },
      {
        name: 'rova_list_releases',
        args: { projectId: PAY_PROJECT_ID },
        fields: ['releases'],
      },
      {
        name: 'rova_list_milestones',
        args: { projectId: PAY_PROJECT_ID },
        fields: ['milestones'],
      },
      {
        name: 'rova_iteration_burndown',
        args: { projectId: PAY_PROJECT_ID, iterationId: PAY_ITER_ID },
        fields: [],
      },
      {
        name: 'rova_velocity',
        args: { projectId: PAY_PROJECT_ID, window: 5 },
        fields: [],
      },
      {
        name: 'rova_team_capacity',
        args: { projectId: PAY_PROJECT_ID, iterationId: PAY_ITER_ID },
        fields: [],
      },
      { name: 'rova_unread_notifications', args: {}, fields: ['count'] },
      {
        name: 'rova_list_test_cases',
        args: { workItemId: NXP_STORY_1_ID },
        fields: ['testCases', 'pageInfo'],
      },
      {
        name: 'rova_get_test_case_by_key',
        args: { testCaseKey: 'TC-1' },
        fields: ['id', 'testCaseKey', 'name'],
      },
      {
        name: 'rova_quality_defects',
        args: { projectId: PAY_PROJECT_ID },
        fields: ['defects', 'metrics'],
      },
      {
        name: 'rova_team_status',
        args: { projectId: PAY_PROJECT_ID, iterationId: PAY_ITER_ID },
        fields: ['members', 'iteration', 'totals'],
      },
      { name: 'rova_list_portfolio_items', args: { type: 'epic' }, fields: ['portfolioItems'] },
      {
        name: 'rova_get_portfolio_item',
        args: { portfolioItemId: NXP_FEATURE_3_ID },
        fields: ['id', 'itemKey', 'type', 'name', 'estimate', 'rollup', 'progress', 'children'],
      },
      // PR B's eight tools. The two reports relay the route payload as-is (fields []); the
      // seeded ids come from db/seeds/constants (NXP release 1, milestone 1, team Alpha).
      {
        name: 'rova_carryover_report',
        // CASES is built at describe time; the getter defers the fixture iteration id to
        // call time (the happy-path test sets it after creating the carryover fixture)
        args: {
          projectId: NXP_PROJECT_ID,
          get iterationId() {
            return carryoverIteration.id;
          },
        },
        fields: ['rows'],
      },
      {
        name: 'rova_release_tracking',
        args: { projectId: NXP_PROJECT_ID, releaseId: NXP_RELEASE_1_ID },
        fields: ['rows'],
      },
      {
        name: 'rova_get_release',
        args: { releaseId: NXP_RELEASE_1_ID },
        fields: ['id', 'releaseKey', 'name', 'status', 'taskEstimate', 'artifacts'],
      },
      {
        name: 'rova_get_milestone',
        args: { milestoneId: NXP_MILESTONE_1_ID },
        fields: ['id', 'milestoneKey', 'name', 'status', 'artifacts', 'releases', 'projects'],
      },
      { name: 'rova_project_health', args: {}, fields: ['projects'] },
      {
        name: 'rova_work_item_code_changes',
        args: { workItemId: NXP_STORY_1_ID },
        fields: ['connections', 'changesets'],
      },
      { name: 'rova_list_teams', args: {}, fields: ['teams'] },
      { name: 'rova_list_notifications', args: {}, fields: ['notifications'] },
    ];

    it('every tool appears exactly once in the happy-path matrix', () => {
      expect(CASES.length).toBe(34);
      const names = CASES.map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it('each tool answers with its documented fields on seeded data', async () => {
      // The happy-path caller must be able to READ everything the seed provides: the seeded
      // workspace admin. A plain member cannot read PAY/NXP (project:view is project-tier).
      const { userId: adminId, credential } = await signInAs(app, 'admin@qnsc.dev');
      const adminToken = `${VERIFIER_TOKEN_PREFIX}admin-${adminId.slice(0, 8)}`;
      people.set(adminToken, { userId: adminId, workspaceId: WORKSPACE_ID });

      // A THROWAWAY story, carried over through the REAL API: the carryover report computes
      // its rows from carryover EVENTS, and the seed alone creates none — so without this the
      // report would answer 200 with `rows: []` and a non-empty assert on seeded data would
      // be a lie. The iteration pair is dated AROUND THE DB CLOCK (the only clock, per the
      // Time rule) because carryover requires the SOURCE iteration to be current — the seeded
      // NXP sprints are dated 2026-06 and are not.
      const db = app.get<DrizzleDB>(DRIZZLE);
      const { iterations } = await import('../../db/schema/work');
      const day = (offset: number) => {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() + offset);
        return d.toISOString().slice(0, 10);
      };
      const itA = randomUUID();
      const itB = randomUUID();
      await db.insert(iterations).values([
        {
          id: itA,
          workspaceId: WORKSPACE_ID,
          projectId: NXP_PROJECT_ID,
          iterationKey: 'IT-MCP-A',
          name: 'MCP Carryover Source',
          state: 'committed',
          startDate: day(-1),
          endDate: day(1),
        },
        {
          id: itB,
          workspaceId: WORKSPACE_ID,
          projectId: NXP_PROJECT_ID,
          iterationKey: 'IT-MCP-B',
          name: 'MCP Carryover Target',
          state: 'planning',
          startDate: day(2),
          endDate: day(12),
        },
      ]);
      carryoverIteration.id = itA;
      // Session-cookie POSTs through the REAL bootstrap need the CSRF pair: the secret
      // cookie + the signed token /v1/auth/me hands out (see csrf-protection.e2e.spec.ts).
      const me = await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: { cookie: credential },
      });
      expect(me.statusCode, me.body).toBe(200);
      const auth = {
        cookie: `${credential}; ${readCookie(me.headers['set-cookie'], CSRF_SECRET_COOKIE)}`,
        [CSRF_HEADER]: me.json<{ csrfToken: string }>().csrfToken,
      };
      const fixture = await app.inject({
        method: 'POST',
        url: '/v1/work-items',
        headers: auth,
        payload: {
          projectId: NXP_PROJECT_ID,
          type: 'story',
          title: 'mcp carryover fixture',
        },
      });
      expect(fixture.statusCode, fixture.body).toBe(201);
      // Create takes no iterationId (Update does): schedule the fixture afterwards.
      const scheduled = await app.inject({
        method: 'PATCH',
        url: `/v1/work-items/${fixture.json<{ id: string }>().id}`,
        headers: auth,
        payload: { iterationId: itA },
      });
      expect(scheduled.statusCode, scheduled.body).toBe(200);
      expect(
        scheduled.json<{ iterationId?: string }>().iterationId,
        'fixture must be scheduled in the source iteration',
      ).toBe(itA);
      const carried = await app.inject({
        method: 'POST',
        url: `/v1/work-items/${fixture.json<{ id: string }>().id}/carryover`,
        headers: auth,
        payload: {
          expectedSourceIterationId: itA,
          targetIterationId: itB,
          targetEndDate: day(5),
        },
      });
      expect(carried.statusCode, carried.body).toBe(201);

      // fields that must hold SEEDED (or fixture) rows — a denial or an empty answer from a
      // wrong project/iteration pairing must fail here, not pass vacuously
      const NON_EMPTY: Record<string, string[]> = {
        rova_carryover_report: ['rows'],
        rova_release_tracking: ['rows'],
        rova_get_release: ['artifacts'],
        rova_get_milestone: ['artifacts', 'releases'],
        rova_work_item_code_changes: ['connections', 'changesets'],
        rova_project_health: ['projects'],
        rova_list_teams: ['teams'],
        rova_get_portfolio_item: ['children'],
      };

      for (const { name, args, fields } of CASES) {
        const out = await callTool(adminToken, name, args, { skipInitialize: true });
        // a denial relays { statusCode, error } — any case answering one fails HERE
        expect(out.statusCode, `${name} must succeed on seeded data`).toBeUndefined();
        for (const field of fields) {
          expect(
            out[field],
            `${name}: documented field '${field}' missing/undefined`,
          ).toBeDefined();
        }
        for (const key of NON_EMPTY[name] ?? []) {
          expect(
            (out[key] as unknown[]).length,
            `${name}: '${key}' must be non-empty on the seeded workspace`,
          ).toBeGreaterThan(0);
        }
      }
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
