import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  clientIdempotencyKeyFor,
  type McpRestCall,
  type McpRestResult,
  type ToolContext,
  type WriteAudit,
} from './rest';
import {
  CreateTestCaseSchema,
  UpdateTestCaseSchema,
} from '@modules/test-cases/interface/http/dto/test-case-request.dto';
import { CreateTestResultSchema } from '@modules/test-cases/interface/http/dto/test-result-request.dto';
import { registerSaveTestCase } from './save_test_case';
import { registerRecordTestResults } from './record_test_results';

const U = (n: number) => `0194a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const PROJECT = U(10);
const WORK_ITEM = U(20);
const ME = U(1);
const SECRET = 'x'.repeat(32);
const PERSON = { userId: U(70), displayName: 'Alice', email: 'alice@qnsc.dev' };

const WORK_ITEM_ROW = {
  id: WORK_ITEM,
  itemKey: 'US-412',
  title: 'Story',
  type: 'story',
  projectId: PROJECT,
  teamId: U(30),
};

function testCaseRow(n: number, key: string) {
  return {
    id: U(n),
    testCaseKey: key,
    name: `Case ${key}`,
    projectId: PROJECT,
    workItemId: WORK_ITEM,
    teamId: U(30),
    type: 'Functional',
    method: 'manual',
    priority: 'normal',
    ownerId: null,
    ownerName: null,
    assigneeId: null,
    assigneeName: null,
    description: null,
    objective: null,
    preconditions: null,
    validationInput: null,
    validationExpectedResult: null,
    postconditions: null,
    notes: null,
    lastVerdict: null,
    lastRun: null,
    updatedAt: '2026-11-04T09:00:00.000Z',
  };
}

const TC1 = testCaseRow(100, 'TC-1');
const TC2 = testCaseRow(101, 'TC-2');

function resultRow(n: number, key: string, verdict: string) {
  return {
    id: U(n),
    testResultKey: key,
    testCaseId: TC1.id,
    build: '1.4.2',
    runDate: '2026-11-04',
    verdict,
    durationMinutes: 0,
    testerId: ME,
    testerName: 'Admin User',
    notes: null,
  };
}

/**
 * The REAL client-key builder, so the spec exercises the mechanism the route wires: the key is a
 * function of the caller's `requestId` (and, per row, the test case) — never the content or the
 * clock.
 */
function context(route: (call: McpRestCall) => McpRestResult) {
  const calls: McpRestCall[] = [];
  const notes: WriteAudit[] = [];
  const clientKey = vi.fn((tool: string, args: unknown) =>
    clientIdempotencyKeyFor(SECRET, ME, tool, args),
  );
  const ctx: ToolContext = {
    principal: { userId: ME, workspaceId: U(2), sessionId: 'mcp:pr5' },
    callRest: async (_p, call) => {
      calls.push(call);
      return route(call);
    },
    clientIdempotencyKey: clientKey,
    noteWrite: (meta) => notes.push(meta),
  };
  return { ctx, calls, clientKey, notes };
}

async function call(
  register: (server: McpServer, ctx: ToolContext) => unknown,
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; body: Record<string, unknown> }> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const tool = register(server, ctx) as {
    handler: (
      a: unknown,
      e: unknown,
    ) => Promise<{ isError?: boolean; content: { text: string }[] }>;
  };
  const res = await tool.handler(args, {});
  return { isError: res.isError, body: JSON.parse(res.content[0].text) as Record<string, unknown> };
}

/** The reference feeds both tools read: the work item, two test cases and the caller's profile. */
const feeds = (call: McpRestCall): McpRestResult | null => {
  if (call.method === 'GET' && call.url === '/v1/auth/me') {
    return { statusCode: 200, json: { id: ME, timezone: 'Asia/Ho_Chi_Minh' } };
  }
  if (call.method === 'GET' && call.url === '/v1/work-items/by-key') {
    return String(call.query?.['itemKey']) === 'US-412'
      ? { statusCode: 200, json: { item: WORK_ITEM_ROW }, headers: { ETag: '"0"' } }
      : { statusCode: 404, json: { error: { code: 'WORK_ITEM_NOT_FOUND' } } };
  }
  if (call.method === 'GET' && call.url.startsWith('/v1/test-cases/by-key/')) {
    const key = call.url.slice('/v1/test-cases/by-key/'.length);
    const row = [TC1, TC2].find((tc) => tc.testCaseKey === key);
    return row
      ? { statusCode: 200, json: row }
      : { statusCode: 404, json: { error: { code: 'TEST_CASE_NOT_FOUND' } } };
  }
  if (call.method === 'GET' && call.url.endsWith('/member-options')) {
    return { statusCode: 200, json: [PERSON] };
  }
  return null;
};

afterEach(() => {
  vi.useRealTimers();
});

describe('rova_save_test_case', () => {
  it('creates under the parent work item with a body the real DTO accepts, and names the assignee', async () => {
    const { ctx, calls } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      if (call.method === 'POST' && call.url === `/v1/work-items/${WORK_ITEM}/test-cases`) {
        return {
          statusCode: 201,
          json: { ...testCaseRow(110, 'TC-9'), assigneeId: PERSON.userId, assigneeName: 'Alice' },
        };
      }
      return { statusCode: 500, json: { error: 'unexpected' } };
    });

    const { isError, body } = await call(registerSaveTestCase, ctx, {
      workItemKey: 'US-412',
      name: 'Verify voltage on rev A',
      type: 'Functional',
      method: 'manual',
      priority: 'high',
      assignee: 'alice@qnsc.dev',
    });
    expect(isError, JSON.stringify(body)).toBeFalsy();

    const post = calls.find((c) => c.method === 'POST')!;
    // The body is the CREATE contract: no content fields, and the person resolved to an id.
    expect(CreateTestCaseSchema.safeParse(post.body).success).toBe(true);
    expect(post.body).toEqual({
      name: 'Verify voltage on rev A',
      type: 'Functional',
      method: 'manual',
      priority: 'high',
      assigneeId: PERSON.userId,
    });
    // NO requestId -> NO key: content is not an identity, so nothing may be deduplicated.
    expect(post.idempotencyKey).toBeUndefined();
    // The candidate feed is scoped to the ROW's Team, exactly as the web's pickers are.
    expect(calls.find((c) => c.url.endsWith('/member-options'))?.query).toEqual({ teamId: U(30) });
    expect(body).toMatchObject({
      testCase: { testCaseKey: 'TC-9', assignee: { id: PERSON.userId, name: 'Alice' } },
      changed: ['created'],
      replayed: false,
    });
  });

  it("keys a create by the caller's requestId, never by the clock or the content", async () => {
    const { ctx, calls } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      return { statusCode: 201, json: testCaseRow(110, 'TC-9') };
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T10:00:00Z'));
    await call(registerSaveTestCase, ctx, {
      workItemKey: 'US-412',
      name: 'Verify voltage',
      requestId: 'req-1',
    });
    // 25 minutes later: a bucketed key would have changed bucket by now.
    vi.setSystemTime(new Date('2026-11-04T10:25:00Z'));
    await call(registerSaveTestCase, ctx, {
      workItemKey: 'US-412',
      name: 'Verify voltage',
      requestId: 'req-1',
    });
    // A DIFFERENT request id is a different request.
    await call(registerSaveTestCase, ctx, {
      workItemKey: 'US-412',
      name: 'Verify voltage',
      requestId: 'req-2',
    });

    const keys = calls.filter((c) => c.method === 'POST').map((c) => c.idempotencyKey);
    expect(keys).toHaveLength(3);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('applies content fields the CREATE contract cannot carry with one follow-up edit', async () => {
    const { ctx, calls } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      if (call.method === 'POST') return { statusCode: 201, json: testCaseRow(110, 'TC-9') };
      if (call.method === 'PATCH') {
        return {
          statusCode: 200,
          json: { ...testCaseRow(110, 'TC-9'), objective: 'o', validationInput: '3.3V' },
        };
      }
      return { statusCode: 500, json: {} };
    });

    const { isError, body } = await call(registerSaveTestCase, ctx, {
      workItemKey: 'US-412',
      name: 'Verify voltage',
      objective: 'o',
      validationInput: '3.3V',
    });
    expect(isError, JSON.stringify(body)).toBeFalsy();

    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({ name: 'Verify voltage' });
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe(`/v1/test-cases/${U(110)}`);
    expect(UpdateTestCaseSchema.safeParse(patch.body).success).toBe(true);
    expect(patch.body).toEqual({ objective: 'o', validationInput: '3.3V' });
    // The edit is a SET, so it carries no key.
    expect(patch.idempotencyKey).toBeUndefined();
    expect(body['content']).toEqual({ applied: true });
    // `changed` names what WAS applied, and the record answered is the post-edit one.
    expect(body['changed']).toEqual(['created', 'objective', 'validationInput']);
    expect((body['testCase'] as Record<string, unknown>)['objective']).toBe('o');
  });

  it('on a REPLAY it still re-sends the content edit: a failed first edit lands on the retry', async () => {
    let patchCount = 0;
    const { ctx, calls } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      if (call.method === 'POST') {
        // The second call is a replay of the id the first call was keyed with.
        return patchCount === 0
          ? { statusCode: 201, json: testCaseRow(110, 'TC-9') }
          : {
              statusCode: 201,
              json: testCaseRow(110, 'TC-9'),
              headers: { 'idempotency-replayed': 'true' },
            };
      }
      patchCount += 1;
      // The FIRST edit fails; the retry's edit succeeds.
      return patchCount === 1
        ? { statusCode: 500, json: { error: { code: 'BOOM' } } }
        : { statusCode: 200, json: { ...testCaseRow(110, 'TC-9'), objective: 'o' } };
    });

    const args = { workItemKey: 'US-412', name: 'Verify voltage', objective: 'o', requestId: 'r' };
    const first = await call(registerSaveTestCase, ctx, args);
    expect(first.isError, JSON.stringify(first.body)).toBeFalsy();
    expect(first.body['replayed']).toBe(false);
    expect(first.body['content']).toEqual({ applied: false, error: { error: { code: 'BOOM' } } });
    // Only what actually landed is claimed.
    expect(first.body['changed']).toEqual(['created']);

    const retry = await call(registerSaveTestCase, ctx, args);
    expect(retry.body['replayed']).toBe(true);
    expect(retry.body['content']).toEqual({ applied: true });
    // The row was NOT created by this call; only the edit that landed is claimed.
    expect(retry.body['changed']).toEqual(['objective']);
    expect((retry.body['testCase'] as Record<string, unknown>)['objective']).toBe('o');

    // Two PATCHes: the replay did NOT skip the edit because the cached POST body is blank.
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(2);
  });

  it('updates by key with only the fields given, and null clears a person field', async () => {
    const { ctx, calls } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      if (call.method === 'PATCH') {
        return {
          statusCode: 200,
          json: { ...TC1, ownerId: null, ownerName: null, priority: 'high' },
        };
      }
      return { statusCode: 500, json: {} };
    });

    const { isError, body } = await call(registerSaveTestCase, ctx, {
      testCaseKey: 'TC-1',
      priority: 'high',
      owner: null,
      requestId: 'not-used-on-update',
    });
    expect(isError, JSON.stringify(body)).toBeFalsy();
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe(`/v1/test-cases/${TC1.id}`);
    expect(patch.body).toEqual({ priority: 'high', ownerId: null });
    // A PATCH is a SET: no Idempotency-Key is sent, even with a requestId in the args.
    expect(patch.idempotencyKey).toBeUndefined();
    expect(body['changed']).toEqual(['priority', 'ownerId']);
  });

  it('refuses an update with nothing to change, before any write', async () => {
    const { ctx, calls } = context((call) => feeds(call) ?? { statusCode: 500, json: {} });
    const { isError, body } = await call(registerSaveTestCase, ctx, { testCaseKey: 'TC-1' });
    expect(isError).toBe(true);
    expect(body['error']).toMatch(/at least one field/);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('refuses both subjects at once, and a create without a name', async () => {
    const { ctx } = context((call) => feeds(call) ?? { statusCode: 500, json: {} });
    const both = await call(registerSaveTestCase, ctx, {
      testCaseKey: 'TC-1',
      workItemKey: 'US-412',
      name: 'x',
    });
    expect(both.isError).toBe(true);
    const noName = await call(registerSaveTestCase, ctx, { workItemKey: 'US-412' });
    expect(noName.isError).toBe(true);
    expect(noName.body['error']).toMatch(/name is required/);
  });

  it('relays the REST refusal of a create unchanged', async () => {
    const restBody = { error: { code: 'WORK_ITEM_ASSIGNEE_NOT_ELIGIBLE', message: 'nope' } };
    const { ctx } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      return { statusCode: 412, json: restBody };
    });
    const { isError, body } = await call(registerSaveTestCase, ctx, {
      workItemKey: 'US-412',
      name: 'Verify voltage',
    });
    expect(isError).toBe(true);
    expect(body).toEqual({ statusCode: 412, error: restBody });
  });
});

describe('rova_record_test_results', () => {
  it('records each entry independently: one failure does not stop the rest', async () => {
    const refusal = { error: { code: 'WORK_ITEM_ASSIGNEE_NOT_ELIGIBLE', message: 'nope' } };
    const { ctx, calls, notes } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      if (call.method === 'POST' && call.url === `/v1/test-cases/${TC1.id}/test-results`) {
        return { statusCode: 201, json: resultRow(120, 'TR-9', 'pass') };
      }
      if (call.method === 'POST' && call.url === `/v1/test-cases/${TC2.id}/test-results`) {
        return { statusCode: 412, json: refusal };
      }
      return { statusCode: 500, json: {} };
    });

    const { isError, body } = await call(registerRecordTestResults, ctx, {
      build: '1.4.2',
      runDate: '2026-11-04',
      tester: 'alice@qnsc.dev',
      requestId: 'req-batch',
      results: [
        { testCaseKey: 'TC-1', verdict: 'pass', durationMinutes: 3 },
        { testCaseKey: 'TC-404', verdict: 'fail' },
        { testCaseKey: 'TC-2', verdict: 'fail', notes: 'crashed' },
      ],
    });
    // One row landed, so the call is a partial success — and says so per item.
    expect(isError, JSON.stringify(body)).toBeFalsy();
    expect(body['created']).toBe(1);
    expect(body['replayed']).toBe(0);
    expect(body['failed']).toBe(2);
    expect(body['results']).toEqual([
      {
        testCaseKey: 'TC-1',
        ok: true,
        id: U(120),
        testResultKey: 'TR-9',
        verdict: 'pass',
        replayed: false,
      },
      {
        testCaseKey: 'TC-404',
        ok: false,
        statusCode: 404,
        error: { error: { code: 'TEST_CASE_NOT_FOUND' } },
      },
      { testCaseKey: 'TC-2', ok: false, statusCode: 412, error: refusal },
    ]);

    // The body is the REAL create contract, with the tester resolved and the date carried.
    for (const post of calls.filter((c) => c.method === 'POST')) {
      expect(CreateTestResultSchema.safeParse(post.body).success).toBe(true);
      expect(post.body).toMatchObject({ testerId: PERSON.userId, runDate: '2026-11-04' });
      // One key per ROW, from the caller's request id plus that row's test case — no content hash.
      expect(post.idempotencyKey).toBe(
        clientIdempotencyKeyFor(SECRET, ME, 'rova_record_test_results', {
          requestId: 'req-batch',
          testCaseId: post.url.includes(TC1.id) ? TC1.id : TC2.id,
        }),
      );
    }
    // Only the NEW row is an audit target.
    expect(notes).toEqual([
      { targets: [U(120)], fields: ['verdict', 'build', 'runDate'], count: 1 },
    ]);
    // The tester feed is scoped to the test CASE's Team, not just its project.
    expect(calls.find((c) => c.url.endsWith('/member-options'))?.query).toEqual({ teamId: U(30) });
  });

  it('counts a replayed row separately from a created one, and targets only the new row', async () => {
    const { ctx, notes } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      if (call.method === 'POST' && call.url === `/v1/test-cases/${TC1.id}/test-results`) {
        return {
          statusCode: 201,
          json: resultRow(120, 'TR-9', 'pass'),
          headers: { 'idempotency-replayed': 'true' },
        };
      }
      return { statusCode: 201, json: resultRow(121, 'TR-10', 'fail') };
    });

    const { isError, body } = await call(registerRecordTestResults, ctx, {
      build: '1.4.2',
      runDate: '2026-11-04',
      requestId: 'req-batch',
      results: [
        { testCaseKey: 'TC-1', verdict: 'pass' },
        { testCaseKey: 'TC-2', verdict: 'fail' },
      ],
    });
    expect(isError, JSON.stringify(body)).toBeFalsy();
    expect(body['created']).toBe(1);
    expect(body['replayed']).toBe(1);
    expect(body['failed']).toBe(0);
    expect(notes).toEqual([
      { targets: [U(121)], fields: ['verdict', 'build', 'runDate'], count: 1 },
    ]);
  });

  it('a batch that ONLY replayed is still a success: the rows exist', async () => {
    const { ctx } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      return {
        statusCode: 201,
        json: resultRow(120, 'TR-9', 'pass'),
        headers: { 'idempotency-replayed': 'true' },
      };
    });
    const { isError, body } = await call(registerRecordTestResults, ctx, {
      build: '1.4.2',
      runDate: '2026-11-04',
      requestId: 'req-batch',
      results: [{ testCaseKey: 'TC-1', verdict: 'pass' }],
    });
    expect(isError, JSON.stringify(body)).toBeFalsy();
    expect(body).toMatchObject({ created: 0, replayed: 1, failed: 0 });
  });

  it('sends NO key without a requestId, so a retry may record a duplicate', async () => {
    const { ctx, calls } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      return { statusCode: 201, json: resultRow(120, 'TR-9', 'pass') };
    });
    await call(registerRecordTestResults, ctx, {
      build: '1.4.2',
      runDate: '2026-11-04',
      results: [{ testCaseKey: 'TC-1', verdict: 'pass' }],
    });
    expect(calls.find((c) => c.method === 'POST')?.idempotencyKey).toBeUndefined();
  });

  it('is an ERROR result when every entry failed, with each refusal listed', async () => {
    const { ctx } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      return { statusCode: 403, json: { error: { code: 'FORBIDDEN' } } };
    });
    const { isError, body } = await call(registerRecordTestResults, ctx, {
      build: '1.4.2',
      runDate: '2026-11-04',
      results: [{ testCaseKey: 'TC-1', verdict: 'pass' }],
    });
    expect(isError).toBe(true);
    expect(body['created']).toBe(0);
    expect(body['replayed']).toBe(0);
    expect(body['failed']).toBe(1);
    expect(body['results']).toMatchObject([{ testCaseKey: 'TC-1', ok: false, statusCode: 403 }]);
  });

  it("defaults the tester to the caller and the date to the caller's own local today", async () => {
    const { ctx, calls } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      return { statusCode: 201, json: resultRow(120, 'TR-9', 'pass') };
    });

    vi.useFakeTimers();
    // 20:00 UTC is already the NEXT day in Asia/Ho_Chi_Minh — the profile's zone, not the server's.
    vi.setSystemTime(new Date('2026-11-04T20:00:00Z'));

    const { isError, body } = await call(registerRecordTestResults, ctx, {
      build: '1.4.2',
      results: [{ testCaseKey: 'TC-1', verdict: 'pass' }],
    });
    expect(isError, JSON.stringify(body)).toBeFalsy();
    expect(body['runDate']).toBe('2026-11-05');
    expect(body['runDateDefaulted']).toBe(true);
    expect(body['runDateZone']).toBe('Asia/Ho_Chi_Minh');
    expect(calls.some((c) => c.url === '/v1/auth/me')).toBe(true);

    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({ testerId: ME, runDate: '2026-11-05' });
  });

  it('refuses to guess the date when the profile is unreadable or has no timezone', async () => {
    const unreadable = context((call) => {
      if (call.method === 'GET' && call.url === '/v1/auth/me') {
        return { statusCode: 500, json: { error: { code: 'BOOM' } } };
      }
      return feeds(call) ?? { statusCode: 500, json: {} };
    });
    const first = await call(registerRecordTestResults, unreadable.ctx, {
      build: '1.4.2',
      results: [{ testCaseKey: 'TC-1', verdict: 'pass' }],
    });
    expect(first.isError).toBe(true);
    expect(first.body['error']).toMatch(/Pass runDate explicitly/);
    expect(unreadable.calls.some((c) => c.method === 'POST')).toBe(false);

    const zoneless = context((call) => {
      if (call.method === 'GET' && call.url === '/v1/auth/me') {
        return { statusCode: 200, json: { id: ME, timezone: '' } };
      }
      return feeds(call) ?? { statusCode: 500, json: {} };
    });
    const second = await call(registerRecordTestResults, zoneless.ctx, {
      build: '1.4.2',
      results: [{ testCaseKey: 'TC-1', verdict: 'pass' }],
    });
    expect(second.isError).toBe(true);
    expect(second.body['error']).toMatch(/no timezone/);
    expect(zoneless.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('refuses to write when writes are not enabled', async () => {
    const { ctx, calls } = context((call) => feeds(call) ?? { statusCode: 500, json: {} });
    const noWrites: ToolContext = { ...ctx, clientIdempotencyKey: undefined };
    const { isError, body } = await call(registerRecordTestResults, noWrites, {
      build: '1.4.2',
      runDate: '2026-11-04',
      results: [{ testCaseKey: 'TC-1', verdict: 'pass' }],
    });
    expect(isError).toBe(true);
    expect(body['error']).toMatch(/Writes are not enabled/);
    expect(calls).toEqual([]);
  });
});
