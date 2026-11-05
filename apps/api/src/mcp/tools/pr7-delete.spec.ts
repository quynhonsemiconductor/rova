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
const ITERATION = U(40);
const PARENT = U(41);

const now = () => new Date().toISOString();
const old = () => new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

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
  iterations?: Record<string, unknown>[];
}) {
  return (call: McpRestCall): McpRestResult => {
    if (call.method === 'DELETE') return { statusCode: 204, json: null };
    if (call.method !== 'GET') return { statusCode: 500, json: {} };
    if (
      call.url === '/v1/work-items/by-key' ||
      /^\/v1\/work-items\/[0-9a-f-]{36}$/.test(call.url)
    ) {
      return { statusCode: 200, json: { item: overrides.item ?? item() } };
    }
    if (call.url.endsWith('/comments')) return { statusCode: 200, json: overrides.comments ?? [] };
    if (call.url.endsWith('/time-logs')) {
      const logs = overrides.timeLogs ?? [];
      return { statusCode: 200, json: { items: logs, total: logs.length } };
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
    if (call.url === '/v1/iterations/options') {
      return { statusCode: 200, json: overrides.iterations ?? [] };
    }
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

  it('deletes a relation that touches the named item', async () => {
    const { ctx, calls } = context(
      feeds({
        relations: [{ id: RELATION, relationType: 'blocks', relatedItem: { id: 'x' } }],
      }),
    );
    const { isError } = await call(ctx, { kind: 'relation', key: 'US-500', id: RELATION });
    expect(isError).toBeFalsy();
    expect(deleteCalls(calls)[0]?.url).toBe(`/v1/work-items/${STORY}/relations/${RELATION}`);
  });

  it('bounds a test-result delete to 7 days and to a result you recorded or tested', async () => {
    const theirs = context(
      feeds({
        results: [{ id: RESULT, createdBy: OTHER, testerId: OTHER, createdAt: now() }],
      }),
    );
    expect(
      (await call(theirs.ctx, { kind: 'test_result', key: 'TC-12', id: RESULT })).isError,
    ).toBe(true);
    expect(deleteCalls(theirs.calls)).toHaveLength(0);

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

  it('warns when deleting the parent’s last open task, because the parent auto-completes', async () => {
    const { ctx } = context(
      feeds({
        item: item({ id: TASK, type: 'task', createdBy: ME, parentId: PARENT }),
        tasks: [
          { id: TASK, scheduleState: 'In-Progress' },
          { id: U(60), scheduleState: 'Completed' },
        ],
      }),
    );
    const { isError, body } = await call(ctx, { kind: 'task', key: 'TA-9' });
    expect(isError, JSON.stringify(body)).toBeFalsy();
    expect(body['deleted']).toMatchObject({
      kind: 'task',
      warning: expect.stringMatching(/last open task/),
    });
  });

  it('refuses a story/defect with dependants, an old one, or one in a committed iteration', async () => {
    const withTask = context(feeds({ tasks: [{ id: TASK }] }));
    expect((await call(withTask.ctx, { kind: 'work_item', key: 'US-500' })).isError).toBe(true);
    expect(deleteCalls(withTask.calls)).toHaveLength(0);

    const withForeignComment = context(feeds({ comments: [{ id: COMMENT, authorId: OTHER }] }));
    const commentRes = await call(withForeignComment.ctx, { kind: 'work_item', key: 'US-500' });
    expect(commentRes.isError).toBe(true);
    expect(commentRes.body['error']).toMatch(/comments by other people/);

    const tooOld = context(feeds({ item: item({ createdAt: old() }) }));
    const ageRes = await call(tooOld.ctx, { kind: 'work_item', key: 'US-500' });
    expect(ageRes.isError).toBe(true);
    expect(ageRes.body['error']).toMatch(/24 hours/);

    const committed = context(
      feeds({
        item: item({ iterationId: ITERATION }),
        iterations: [{ id: ITERATION, state: 'committed' }],
      }),
    );
    const iterRes = await call(committed.ctx, { kind: 'work_item', key: 'US-500' });
    expect(iterRes.isError).toBe(true);
    expect(iterRes.body['error']).toMatch(/committed/);
    expect(deleteCalls(committed.calls)).toHaveLength(0);
  });

  it('deletes a fresh story you created with no dependants, echoing only the subject and reason', async () => {
    const { ctx, calls, notes } = context(feeds({}));
    const { isError, body } = await call(ctx, {
      kind: 'work_item',
      key: 'US-500',
      reason: 'duplicate I just made',
    });
    expect(isError, JSON.stringify(body)).toBeFalsy();
    expect(deleteCalls(calls)[0]?.url).toBe(`/v1/work-items/${STORY}`);
    expect(body).toEqual({
      deleted: { kind: 'work_item', id: STORY, subject: 'US-500' },
      reason: 'duplicate I just made',
    });
    // The audit line names the target and the KIND only; free text never reaches it.
    expect(notes).toEqual([{ targets: [STORY], fields: ['work_item'], count: 1 }]);
  });

  it('relays the REST refusal instead of reporting success', async () => {
    const { ctx } = context((call) =>
      call.method === 'DELETE'
        ? { statusCode: 403, json: { error: { code: 'FORBIDDEN' } } }
        : feeds({})(call),
    );
    const { isError, body } = await call(ctx, { kind: 'work_item', key: 'US-500' });
    expect(isError).toBe(true);
    expect(body).toMatchObject({ statusCode: 403 });
  });

  it('the guard itself answers a plan, not a deletion, when called directly', async () => {
    const { ctx } = context(feeds({}));
    const plan = await planDelete(ctx, { kind: 'work_item', key: 'US-500' });
    expect(plan).toMatchObject({
      ok: true,
      kind: 'work_item',
      targetId: STORY,
      path: `/v1/work-items/${STORY}`,
    });
  });
});
