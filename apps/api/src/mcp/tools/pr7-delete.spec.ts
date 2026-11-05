import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type McpRestCall, type McpRestResult, type ToolContext, type WriteAudit } from './rest';
import { planDelete } from './delete_guard';
import { registerDelete } from './rova_delete';

const U = (n: number) => `0194a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ME = U(1);
const OTHER = U(2);
const PROJECT = U(10);
const TASK = U(20);
const STORY = U(21);
const COMMENT = U(30);
const LOG = U(31);
const RELATION = U(32);
const RESULT = U(33);
const TEST_CASE = U(34);
const EPIC = U(42);

const now = () => new Date().toISOString();

function item(over: Record<string, unknown> = {}) {
  return {
    id: STORY,
    itemKey: 'US-500',
    type: 'story',
    title: 'Everything moves',
    createdBy: ME,
    createdAt: now(),
    projectId: PROJECT,
    teamId: null,
    iterationId: null,
    assigneeId: null,
    parentId: null,
    ...over,
  };
}

function context(
  route: (call: McpRestCall) => McpRestResult,
  principal: string = ME,
): { ctx: ToolContext; calls: McpRestCall[]; notes: WriteAudit[] } {
  const calls: McpRestCall[] = [];
  const notes: WriteAudit[] = [];
  const ctx: ToolContext = {
    principal: { userId: principal, workspaceId: U(50), sessionId: 'mcp:pr7' },
    callRest: async (_p, call) => {
      calls.push(call);
      return route(call);
    },
    noteWrite: (meta) => notes.push(meta),
  };
  return { ctx, calls, notes };
}

async function call(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; body: Record<string, unknown> }> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const tool = registerDelete(server, ctx) as {
    handler: (
      a: unknown,
      e: unknown,
    ) => Promise<{ isError?: boolean; content: { text: string }[] }>;
  };
  const res = await tool.handler(args, {});
  return { isError: res.isError, body: JSON.parse(res.content[0].text) as Record<string, unknown> };
}

/** The feeds a delete guard reads, with per-test overrides. */
function feeds(overrides: {
  item?: Record<string, unknown>;
  comments?: Record<string, unknown>[];
  timeLogs?: Record<string, unknown>[];
  relations?: Record<string, unknown>[];
  tasks?: Record<string, unknown>[];
  testCases?: Record<string, unknown>[];
  results?: Record<string, unknown>[];
  timeLogTotal?: number;
  omitTimeLogTotal?: boolean;
}) {
  return (call: McpRestCall): McpRestResult => {
    if (call.method === 'DELETE') return { statusCode: 204, json: null };
    if (call.method !== 'GET') return { statusCode: 500, json: {} };
    if (
      call.url === '/v1/work-items/by-key' ||
      /^\/v1\/work-items\/[0-9a-f-]{36}$/.test(call.url)
    ) {
      // Both record routes answer the FLATTENED detail DTO — not `{ item }`. The guard once
      // read `body.item`, so a mock in that shape kept a production bug green.
      return { statusCode: 200, json: overrides.item ?? item() };
    }
    if (call.url === '/v1/portfolio-items') {
      return {
        statusCode: 200,
        json: {
          data: [{ id: EPIC, itemKey: 'EP-3', name: 'Platform', projectId: PROJECT }],
          pageInfo: {},
        },
      };
    }
    if (call.url.endsWith('/comments')) return { statusCode: 200, json: overrides.comments ?? [] };
    if (call.url.endsWith('/time-logs')) {
      const logs = overrides.timeLogs ?? [];
      return {
        statusCode: 200,
        json: {
          items: logs,
          ...(overrides.omitTimeLogTotal ? {} : { total: overrides.timeLogTotal ?? logs.length }),
        },
      };
    }
    if (call.url.endsWith('/relations'))
      return { statusCode: 200, json: overrides.relations ?? [] };
    if (call.url.endsWith('/tasks')) return { statusCode: 200, json: overrides.tasks ?? [] };
    if (call.url.endsWith('/test-cases')) {
      return {
        statusCode: 200,
        json: { data: overrides.testCases ?? [], pageInfo: {} },
      };
    }
    if (call.url.endsWith('/test-results'))
      return { statusCode: 200, json: overrides.results ?? [] };
    if (call.url.startsWith('/v1/test-cases/by-key/')) {
      return { statusCode: 200, json: { id: TEST_CASE, testCaseKey: 'TC-12' } };
    }
    return { statusCode: 404, json: { error: { code: 'NOT_FOUND' } } };
  };
}

const deleteCalls = (calls: McpRestCall[]) => calls.filter((call) => call.method === 'DELETE');

describe('rova_delete guard (§5)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('deletes only a comment you wrote', async () => {
    const own = feeds({ comments: [{ id: COMMENT, authorId: ME, body: 'mine' }] });
    const { ctx, calls } = context(own);
    const { isError, body } = await call(ctx, { kind: 'comment', key: 'US-500', id: COMMENT });
    expect(isError, JSON.stringify(body)).toBeFalsy();
    expect(deleteCalls(calls)[0]?.url).toBe(`/v1/work-items/${STORY}/comments/${COMMENT}`);

    const theirs = context(feeds({ comments: [{ id: COMMENT, authorId: OTHER, body: 'theirs' }] }));
    const refused = await call(theirs.ctx, { kind: 'comment', key: 'US-500', id: COMMENT });
    expect(refused.isError).toBe(true);
    expect(refused.body['error']).toMatch(/your own comment/);
    expect(deleteCalls(theirs.calls)).toHaveLength(0);
  });

  it("refuses someone else's time log, even though a Workspace Admin could delete it over REST", async () => {
    const { ctx, calls } = context(feeds({ timeLogs: [{ id: LOG, userId: OTHER, hours: 3 }] }));
    const { isError, body } = await call(ctx, { kind: 'time_log', key: 'US-500', id: LOG });
    expect(isError).toBe(true);
    expect(body['error']).toMatch(/your own time log/);
    expect(deleteCalls(calls)).toHaveLength(0);
  });

  it('deletes a relation only when the caller created it', async () => {
    const mine = context(
      feeds({
        relations: [
          {
            id: RELATION,
            relationType: 'blocks',
            createdBy: ME,
            relatedItem: { id: 'x' },
          },
        ],
      }),
    );
    const { isError } = await call(mine.ctx, { kind: 'relation', key: 'US-500', id: RELATION });
    expect(isError).toBeFalsy();
    expect(deleteCalls(mine.calls)[0]?.url).toBe(`/v1/work-items/${STORY}/relations/${RELATION}`);

    const theirs = context(
      feeds({
        relations: [
          {
            id: RELATION,
            relationType: 'blocks',
            createdBy: OTHER,
            relatedItem: { id: 'x' },
          },
        ],
      }),
    );
    const refused = await call(theirs.ctx, { kind: 'relation', key: 'US-500', id: RELATION });
    expect(refused.isError).toBe(true);
    expect(refused.body['error']).toMatch(/relation you created/);
    expect(deleteCalls(theirs.calls)).toHaveLength(0);
  });

  it('bounds a test-result delete to 7 days and to the caller who RECORDED it', async () => {
    const theirs = context(
      feeds({
        results: [{ id: RESULT, createdBy: OTHER, testerId: OTHER, createdAt: now() }],
      }),
    );
    expect(
      (await call(theirs.ctx, { kind: 'test_result', key: 'TC-12', id: RESULT })).isError,
    ).toBe(true);
    expect(deleteCalls(theirs.calls)).toHaveLength(0);

    // `tester_id` names who the result is ABOUT; only `created_by` is the recorder.
    const testerOnly = context(
      feeds({
        results: [{ id: RESULT, createdBy: OTHER, testerId: ME, createdAt: now() }],
      }),
    );
    const testerOnlyRes = await call(testerOnly.ctx, {
      kind: 'test_result',
      key: 'TC-12',
      id: RESULT,
    });
    expect(testerOnlyRes.isError).toBe(true);
    expect(testerOnlyRes.body['error']).toMatch(/recorded/);
    expect(deleteCalls(testerOnly.calls)).toHaveLength(0);

    const stale = context(
      feeds({
        results: [
          {
            id: RESULT,
            createdBy: ME,
            testerId: ME,
            createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
          },
        ],
      }),
    );
    const staleRes = await call(stale.ctx, { kind: 'test_result', key: 'TC-12', id: RESULT });
    expect(staleRes.isError).toBe(true);
    expect(staleRes.body['error']).toMatch(/7 days/);
    expect(deleteCalls(stale.calls)).toHaveLength(0);

    const mine = context(
      feeds({ results: [{ id: RESULT, createdBy: ME, testerId: OTHER, createdAt: now() }] }),
    );
    const ok = await call(mine.ctx, { kind: 'test_result', key: 'TC-12', id: RESULT });
    expect(ok.isError).toBeFalsy();
    expect(deleteCalls(mine.calls)[0]?.url).toBe(`/v1/test-results/${RESULT}`);
  });

  it('refuses a task you neither created nor own, and one with another person’s time', async () => {
    const notMine = context(
      feeds({ item: item({ id: TASK, type: 'task', createdBy: OTHER, assigneeId: null }) }),
    );
    expect((await call(notMine.ctx, { kind: 'task', key: 'TA-9' })).isError).toBe(true);
    expect(deleteCalls(notMine.calls)).toHaveLength(0);

    const foreignTime = context(
      feeds({
        item: item({ id: TASK, type: 'task', createdBy: ME }),
        timeLogs: [{ id: LOG, userId: OTHER }],
      }),
    );
    const res = await call(foreignTime.ctx, { kind: 'task', key: 'TA-9' });
    expect(res.isError).toBe(true);
    expect(res.body['error']).toMatch(/someone else/);
    expect(deleteCalls(foreignTime.calls)).toHaveLength(0);
  });

  it('refuses a task whose time logs exceed one page, so a foreign log cannot hide on page 2', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: U(100 + index),
      userId: ME,
    }));
    const { ctx, calls } = context(
      feeds({
        item: item({ id: TASK, type: 'task', createdBy: ME }),
        timeLogs: firstPage,
        timeLogTotal: 101,
      }),
    );
    const res = await call(ctx, { kind: 'task', key: 'TA-9' });
    expect(res.isError).toBe(true);
    expect(res.body['error']).toMatch(/more time logs than one page/);
    expect(deleteCalls(calls)).toHaveLength(0);

    // No total at all is not "one page is everything": fail closed, exactly as for a longer page.
    const unknown = context(
      feeds({
        item: item({ id: TASK, type: 'task', createdBy: ME }),
        timeLogs: [],
        omitTimeLogTotal: true,
      }),
    );
    const unknownRes = await call(unknown.ctx, { kind: 'task', key: 'TA-9' });
    expect(unknownRes.isError).toBe(true);
    expect(unknownRes.body['error']).toMatch(/more time logs than one page/);
    expect(deleteCalls(unknown.calls)).toHaveLength(0);

    // The time_log branch reads the same page: its own log #101+ must not become alreadyDeleted.
    const manyLogs = context(feeds({ timeLogs: firstPage, timeLogTotal: 101 }));
    const logRes = await call(manyLogs.ctx, { kind: 'time_log', key: 'US-500', id: LOG });
    expect(logRes.isError).toBe(true);
    expect(logRes.body['error']).toMatch(/more time logs than one page/);
    expect(deleteCalls(manyLogs.calls)).toHaveLength(0);
  });

  it('deletes a task you created, echoing the subject and recording the reason', async () => {
    const { ctx, calls, notes } = context(
      feeds({ item: item({ id: TASK, type: 'task', createdBy: ME }) }),
    );
    const { isError, body } = await call(ctx, {
      kind: 'task',
      key: 'TA-9',
      reason: 'finished by mistake',
    });
    expect(isError, JSON.stringify(body)).toBeFalsy();
    expect(deleteCalls(calls)[0]?.url).toBe(`/v1/work-items/${TASK}`);
    expect(body).toEqual({
      deleted: { kind: 'task', id: TASK, subject: 'TA-9' },
      reason: 'finished by mistake',
    });
    // The audit line names the target and the KIND, and records only the reason's LENGTH.
    expect(notes).toEqual([
      { targets: [TASK], fields: ['task'], count: 1, reasonLength: 'finished by mistake'.length },
    ]);
  });

  it('deletes your own comment on a PORTFOLIO item (the EP-/FE- branch)', async () => {
    const { ctx, calls } = context(
      feeds({ comments: [{ id: COMMENT, authorId: ME, body: 'mine' }] }),
    );
    const { isError, body } = await call(ctx, { kind: 'comment', key: 'EP-3', id: COMMENT });
    expect(isError, JSON.stringify(body)).toBeFalsy();
    expect(deleteCalls(calls)[0]?.url).toBe(`/v1/portfolio-items/${EPIC}/comments/${COMMENT}`);
  });

  it('answers a 403 and a 404 on a target read with byte-identical output', async () => {
    // A foreign item answers 403; a missing one 404. Relaying either status (or reporting the
    // 404 as alreadyDeleted) would let a chat user probe keys in projects they cannot see.
    const denial = (statusCode: number) =>
      context((routeCall) =>
        routeCall.method === 'GET'
          ? { statusCode, json: { error: { code: 'DENIED' } } }
          : { statusCode: 204, json: null },
      );
    const cases: Array<[string, Record<string, unknown>]> = [
      ['task', { kind: 'task', key: 'TA-9' }],
      ['comment', { kind: 'comment', key: 'US-500', id: COMMENT }],
      ['time_log', { kind: 'time_log', key: 'US-500', id: LOG }],
      ['relation', { kind: 'relation', key: 'US-500', id: RELATION }],
      ['test_result', { kind: 'test_result', key: 'TC-12', id: RESULT }],
    ];
    for (const [label, args] of cases) {
      const forbidden = await call(denial(403).ctx, args);
      const missing = await call(denial(404).ctx, args);
      expect(forbidden.isError, label).toBe(true);
      expect(missing.isError, label).toBe(true);
      expect(JSON.stringify(forbidden.body), label).toBe(JSON.stringify(missing.body));
      expect(forbidden.body, label).toEqual({
        error: 'That record was not found, or it is not yours.',
      });
    }
  });

  it('never calls an absent child alreadyDeleted: the id may belong to another item', async () => {
    // Absence from THIS parent's list is not proof the row is gone; no route resolves a child by
    // id alone. Every child kind must answer the generic refusal and delete nothing.
    const cases: Array<[string, Record<string, unknown>, Parameters<typeof feeds>[0]]> = [
      ['comment', { kind: 'comment', key: 'US-500', id: COMMENT }, { comments: [] }],
      ['time_log', { kind: 'time_log', key: 'US-500', id: LOG }, { timeLogs: [] }],
      ['relation', { kind: 'relation', key: 'US-500', id: RELATION }, { relations: [] }],
      ['test_result', { kind: 'test_result', key: 'TC-12', id: RESULT }, { results: [] }],
    ];
    for (const [kind, args, overrides] of cases) {
      const retryCtx = context(feeds(overrides));
      const retry = await call(retryCtx.ctx, { ...args, reason: 'already gone' });
      expect(retry.isError, kind).toBe(true);
      expect(retry.body, kind).toEqual({
        error: 'That record was not found, or it is not yours.',
      });
      expect(deleteCalls(retryCtx.calls), kind).toHaveLength(0);
      expect(retryCtx.notes, kind).toEqual([]);
    }
  });

  it('refuses a task with test cases, a foreign comment, or a foreign relation', async () => {
    const task = item({ id: TASK, type: 'task', createdBy: ME });
    const cases: Array<[string, Parameters<typeof feeds>[0], RegExp]> = [
      ['test case', { item: task, testCases: [{ id: U(80) }] }, /test cases/],
      [
        'foreign comment',
        { item: task, comments: [{ id: COMMENT, authorId: OTHER }] },
        /comments by other people/,
      ],
      [
        'foreign relation',
        { item: task, relations: [{ id: RELATION, createdBy: OTHER }] },
        /relations by other people/,
      ],
    ];
    for (const [label, overrides, message] of cases) {
      const blocked = context(feeds(overrides));
      const res = await call(blocked.ctx, { kind: 'task', key: 'TA-9' });
      expect(res.isError, label).toBe(true);
      expect(res.body['error'], label).toMatch(message);
      expect(deleteCalls(blocked.calls), label).toHaveLength(0);
    }
  });

  it('re-reads the parent after a task delete and reports the stored auto-completion', async () => {
    const parentId = U(90);
    const { ctx, calls } = context((routeCall) => {
      if (routeCall.method === 'DELETE') return { statusCode: 204, json: null };
      if (routeCall.method === 'GET' && routeCall.url === `/v1/work-items/${parentId}`) {
        return {
          statusCode: 200,
          json: item({ id: parentId, type: 'story', scheduleState: 'completed' }),
        };
      }
      return feeds({ item: item({ id: TASK, type: 'task', createdBy: ME, parentId }) })(routeCall);
    });
    const { isError, body } = await call(ctx, { kind: 'task', key: 'TA-9' });
    expect(isError, JSON.stringify(body)).toBeFalsy();
    expect(body['parentAutoCompleted']).toBe(true);
    expect(calls.some((c) => c.method === 'GET' && c.url === `/v1/work-items/${parentId}`)).toBe(
      true,
    );
  });

  it('relays the REST refusal from the DELETE itself instead of reporting success', async () => {
    const { ctx } = context((call) =>
      call.method === 'DELETE'
        ? { statusCode: 403, json: { error: { code: 'FORBIDDEN' } } }
        : feeds({ item: item({ id: TASK, type: 'task', createdBy: ME }) })(call),
    );
    const { isError, body } = await call(ctx, { kind: 'task', key: 'TA-9' });
    expect(isError).toBe(true);
    expect(body).toMatchObject({ statusCode: 403 });
  });

  it('the guard itself answers a plan, not a deletion, when called directly', async () => {
    const { ctx } = context(feeds({ item: item({ id: TASK, type: 'task', createdBy: ME }) }));
    const plan = await planDelete(ctx, { kind: 'task', key: 'TA-9' });
    expect(plan).toMatchObject({
      ok: true,
      kind: 'task',
      targetId: TASK,
      path: `/v1/work-items/${TASK}`,
    });
  });

  it('no longer accepts the work_item kind (deferred to v2.1)', () => {
    type Fields = { shape: Record<string, { safeParse: (v: unknown) => { success: boolean } }> };
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const { ctx } = context(feeds({}));
    const tool = registerDelete(server, ctx) as unknown as { inputSchema: Fields };
    const kind = tool.inputSchema.shape['kind'];
    expect(kind.safeParse('task').success).toBe(true);
    expect(kind.safeParse('work_item').success).toBe(false);
  });
});
