import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  naturalIdempotencyKeyFor,
  type McpRestCall,
  type McpRestResult,
  type ToolContext,
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
 * The REAL natural key builder, so the spec exercises the mechanism the route wires: two identical
 * calls inside one test must produce one key, whatever the wall clock says.
 */
function context(route: (call: McpRestCall) => McpRestResult) {
  const calls: McpRestCall[] = [];
  const natural = vi.fn((tool: string, args: unknown) =>
    naturalIdempotencyKeyFor(SECRET, ME, tool, args),
  );
  const ctx: ToolContext = {
    principal: { userId: ME, workspaceId: U(2), sessionId: 'mcp:pr5' },
    callRest: async (_p, call) => {
      calls.push(call);
      return route(call);
    },
    naturalIdempotencyKey: natural,
  };
  return { ctx, calls, natural };
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
    expect(post.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    // The candidate feed is scoped to the ROW's Team, exactly as the web's pickers are.
    expect(calls.find((c) => c.url.endsWith('/member-options'))?.query).toEqual({ teamId: U(30) });
    expect(body).toMatchObject({
      testCase: { testCaseKey: 'TC-9', assignee: { id: PERSON.userId, name: 'Alice' } },
      changed: ['created'],
      replayed: false,
    });
  });

  it('keys the create by its OWN content, never by the clock: an identical call keeps one key', async () => {
    const { ctx, calls } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      return { statusCode: 201, json: testCaseRow(110, 'TC-9') };
    });
    const args = { workItemKey: 'US-412', name: 'Verify voltage' };

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T10:00:00Z'));
    await call(registerSaveTestCase, ctx, args);
    // 25 minutes later: a bucketed key would have changed bucket by now.
    vi.setSystemTime(new Date('2026-11-04T10:25:00Z'));
    await call(registerSaveTestCase, ctx, args);

    const keys = calls.filter((c) => c.method === 'POST').map((c) => c.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('applies content fields the CREATE contract cannot carry with one follow-up edit', async () => {
    const { ctx, calls } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      if (call.method === 'POST') return { statusCode: 201, json: testCaseRow(110, 'TC-9') };
      if (call.method === 'PATCH') {
        return { statusCode: 200, json: { ...testCaseRow(110, 'TC-9'), objective: 'o' } };
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
    expect(body['content']).toEqual({ applied: true });
    expect(body['changed']).toEqual(['created', 'objective', 'validationInput']);
  });

  it('on a replay it does NOT repeat the follow-up edit (the first call applied it)', async () => {
    const { ctx, calls } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      return {
        statusCode: 201,
        json: testCaseRow(110, 'TC-9'),
        headers: { 'idempotency-replayed': 'true' },
      };
    });

    const { body } = await call(registerSaveTestCase, ctx, {
      workItemKey: 'US-412',
      name: 'Verify voltage',
      objective: 'o',
    });
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(body['replayed']).toBe(true);
    expect(body['content']).toEqual({ applied: null });
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
    });
    expect(isError, JSON.stringify(body)).toBeFalsy();
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe(`/v1/test-cases/${TC1.id}`);
    expect(patch.body).toEqual({ priority: 'high', ownerId: null });
    // A PATCH is a SET: no Idempotency-Key is sent.
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
    const { ctx, calls } = context((call) => {
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
      results: [
        { testCaseKey: 'TC-1', verdict: 'pass', durationMinutes: 3 },
        { testCaseKey: 'TC-404', verdict: 'fail' },
        { testCaseKey: 'TC-2', verdict: 'fail', notes: 'crashed' },
      ],
    });
    // One row landed, so the call is a partial success — and says so per item.
    expect(isError, JSON.stringify(body)).toBeFalsy();
    expect(body['created']).toBe(1);
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
    }
    const withMinutes = calls.find((c) => c.url.endsWith(`${TC1.id}/test-results`))!;
    expect(withMinutes.body).toMatchObject({ verdict: 'pass', durationMinutes: 3 });
    // The tester feed is scoped to the test CASE's Team, not just its project.
    expect(calls.find((c) => c.url.endsWith('/member-options'))?.query).toEqual({ teamId: U(30) });
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
    expect(calls.some((c) => c.url === '/v1/auth/me')).toBe(true);

    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({ testerId: ME, runDate: '2026-11-05' });
  });

  it('keys each row by its own content: a corrected verdict is a NEW record, a retry is not', async () => {
    const { ctx, calls } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      return { statusCode: 201, json: resultRow(120, 'TR-9', 'pass') };
    });

    await call(registerRecordTestResults, ctx, {
      build: '1.4.2',
      runDate: '2026-11-04',
      results: [{ testCaseKey: 'TC-1', verdict: 'fail' }],
    });
    await call(registerRecordTestResults, ctx, {
      build: '1.4.2',
      runDate: '2026-11-04',
      results: [{ testCaseKey: 'TC-1', verdict: 'fail' }],
    });
    await call(registerRecordTestResults, ctx, {
      build: '1.4.2',
      runDate: '2026-11-04',
      results: [{ testCaseKey: 'TC-1', verdict: 'pass' }],
    });

    const keys = calls.filter((c) => c.method === 'POST').map((c) => c.idempotencyKey);
    expect(keys).toHaveLength(3);
    expect(keys[0]).toBe(keys[1]); // the identical retry replays the row that landed
    expect(keys[2]).not.toBe(keys[0]); // the correction is its own record
  });

  it('reports a replayed row as replayed, so the model can tell a retry from a new run', async () => {
    const { ctx } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      return {
        statusCode: 201,
        json: resultRow(120, 'TR-9', 'pass'),
        headers: { 'idempotency-replayed': 'true' },
      };
    });
    const { body } = await call(registerRecordTestResults, ctx, {
      build: '1.4.2',
      runDate: '2026-11-04',
      results: [{ testCaseKey: 'TC-1', verdict: 'pass' }],
    });
    expect(body['results']).toMatchObject([{ ok: true, replayed: true }]);
  });

  it('refuses to write when writes are not enabled', async () => {
    const { ctx, calls } = context((call) => feeds(call) ?? { statusCode: 500, json: {} });
    const noWrites: ToolContext = { ...ctx, naturalIdempotencyKey: undefined };
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
