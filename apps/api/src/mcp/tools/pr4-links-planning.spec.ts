import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRestCall, McpRestResult, ToolContext } from './rest';
import {
  BulkAssignIterationSchema,
  BulkAssignReleaseSchema,
  CreateRelationSchema,
} from '@modules/work-items/interface/http/dto/work-item-request.dto';
import { registerLinkWorkItems } from './link_work_items';
import { registerLabelWorkItem } from './label_work_item';
import { registerPlanWorkItems } from './plan_work_items';

const U = (n: number) => `0194a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const PROJECT = U(10);

function context(route: (call: McpRestCall) => McpRestResult) {
  const calls: McpRestCall[] = [];
  const idempotencyKey = vi.fn((_tool: string, _args: unknown) => 'k-test');
  const ctx: ToolContext = {
    principal: { userId: U(1), workspaceId: U(2), sessionId: 'mcp:pr4' },
    callRest: async (_p, call) => {
      calls.push(call);
      return route(call);
    },
    idempotencyKey,
  };
  return { ctx, calls, idempotencyKey };
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

const STORY = {
  id: U(20),
  itemKey: 'US-1',
  title: 'Story',
  type: 'story',
  projectId: PROJECT,
  iterationId: null,
  releaseId: null,
};
const DEFECT = { ...STORY, id: U(21), itemKey: 'DE-1', type: 'defect' };
const TASK = { ...STORY, id: U(22), itemKey: 'TA-1', type: 'task' };
const ITERATION = { id: U(40), name: 'Sprint 1', iterationKey: 'S1', state: 'committed' };
const RELEASE = { id: U(50), name: 'R-1', releaseKey: 'R1', status: 'planning' };
const LABELS = [
  { id: U(60), name: 'api', color: '#111' },
  { id: U(61), name: 'ui', color: '#222' },
];

const itemsByKey: Record<string, Record<string, unknown>> = {
  'US-1': STORY,
  'DE-1': DEFECT,
  'TA-1': TASK,
};

const feeds = (call: McpRestCall): McpRestResult | null => {
  if (call.url === '/v1/projects') {
    return { statusCode: 200, json: { data: [{ id: PROJECT, key: 'NXP', name: 'NXP' }] } };
  }
  if (call.url === '/v1/iterations/options') return { statusCode: 200, json: [ITERATION] };
  if (call.url === '/v1/releases/options') return { statusCode: 200, json: [RELEASE] };
  if (call.url === `/v1/projects/${PROJECT}/labels`) return { statusCode: 200, json: LABELS };
  if (call.method === 'GET' && call.url === '/v1/work-items/by-key') {
    const item = itemsByKey[String(call.query?.['itemKey'])];
    return item
      ? { statusCode: 200, json: { item }, headers: { ETag: '"0"' } }
      : { statusCode: 404, json: { error: { code: 'WORK_ITEM_NOT_FOUND' } } };
  }
  return null;
};

describe('PR4 write tools', () => {
  it('rova_link_work_items posts the resolved target and relays the relation list', async () => {
    const { ctx, calls, idempotencyKey } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      if (call.method === 'POST' && call.url === `/v1/work-items/${STORY.id}/relations`) {
        return {
          statusCode: 201,
          json: [
            {
              id: U(70),
              relationType: 'blocks',
              direction: 'outbound',
              label: 'blocks',
              relatedItem: {
                id: DEFECT.id,
                itemKey: 'DE-1',
                title: 'Defect',
                type: 'defect',
                scheduleState: 'defined',
              },
              createdAt: '2026-06-20T10:00:00.000Z',
            },
          ],
        };
      }
      return { statusCode: 500, json: {} };
    });

    const args = { fromKey: 'US-1', toKey: 'DE-1', relationType: 'blocks' };
    const { isError, body } = await call(registerLinkWorkItems, ctx, args);
    expect(isError, JSON.stringify(body)).toBeFalsy();
    const post = calls.find((c) => c.method === 'POST')!;
    expect(CreateRelationSchema.safeParse(post.body).success).toBe(true);
    expect(post.body).toEqual({ targetId: DEFECT.id, relationType: 'blocks' });
    expect(post.idempotencyKey).toBe('k-test');
    expect(idempotencyKey).toHaveBeenCalledWith('rova_link_work_items', {
      fromId: STORY.id,
      toId: DEFECT.id,
      relationType: 'blocks',
    });
    expect(body).toMatchObject({
      to: { itemKey: 'DE-1' },
      changed: ['relation'],
      relations: [{ relationType: 'blocks', relatedItem: { itemKey: 'DE-1' } }],
    });
  });

  it('an EXISTING link answered 412 is success ("already linked"), not an error', async () => {
    const restBody = { error: { code: 'WORK_ITEM_RELATION_EXISTS', message: 'exists' } };
    const { ctx } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      return { statusCode: 412, json: restBody };
    });
    const { isError, body } = await call(registerLinkWorkItems, ctx, {
      fromKey: 'US-1',
      toKey: 'DE-1',
      relationType: 'relates_to',
    });
    expect(isError).toBeFalsy();
    expect(body).toMatchObject({ alreadyLinked: true, changed: [] });

    // Every OTHER refusal is still an error, relayed unchanged.
    const cycle = { error: { code: 'WORK_ITEM_RELATION_CYCLE', message: 'cycle' } };
    const { ctx: second } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      return { statusCode: 412, json: cycle };
    });
    const refused = await call(registerLinkWorkItems, second, {
      fromKey: 'US-1',
      toKey: 'DE-1',
      relationType: 'blocks',
    });
    expect(refused.isError).toBe(true);
    expect(refused.body).toEqual({ statusCode: 412, error: cycle });
  });

  it('rova_label_work_item adds and removes by NAME and answers the post-write label list', async () => {
    const { ctx, calls } = context((call) => {
      if (call.method === 'GET' && call.url === '/v1/work-items/by-key') {
        return { statusCode: 200, json: { item: STORY }, headers: { ETag: '"0"' } };
      }
      const hit = feeds(call);
      if (hit) return hit;
      if (call.method === 'POST' && call.url.endsWith('/labels'))
        return { statusCode: 204, json: {} };
      if (call.method === 'DELETE' && call.url.includes('/labels/')) {
        return { statusCode: 204, json: {} };
      }
      if (call.method === 'GET' && call.url.endsWith('/labels')) {
        return { statusCode: 200, json: [LABELS[1]] };
      }
      return { statusCode: 500, json: {} };
    });

    const { isError, body } = await call(registerLabelWorkItem, ctx, {
      key: 'US-1',
      add: ['api'],
      remove: ['ui'],
    });
    expect(isError, JSON.stringify(body)).toBeFalsy();

    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe(`/v1/work-items/${STORY.id}/labels`);
    expect(post.body).toEqual({ labelId: LABELS[0].id });
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(del.url).toBe(`/v1/work-items/${STORY.id}/labels/${LABELS[1].id}`);
    expect(body).toMatchObject({
      added: ['api'],
      removed: ['ui'],
      labels: [{ name: 'ui' }],
      changed: ['label:api', 'label:-ui'],
    });
  });

  it('rova_label_work_item refuses an unknown label with candidates and writes nothing', async () => {
    const { ctx, calls } = context((call) => {
      if (call.method === 'GET' && call.url === '/v1/work-items/by-key') {
        return { statusCode: 200, json: { item: STORY }, headers: { ETag: '"0"' } };
      }
      const hit = feeds(call);
      if (hit) return hit;
      return { statusCode: 500, json: {} };
    });
    const { isError, body } = await call(registerLabelWorkItem, ctx, {
      key: 'US-1',
      add: ['ghost'],
    });
    expect(isError).toBe(true);
    expect(JSON.stringify(body)).toContain('Candidates');
    expect(calls.some((c) => c.method === 'POST' || c.method === 'DELETE')).toBe(false);
  });

  it('rova_label_work_item refuses an empty request', async () => {
    const { ctx, calls } = context(() => ({ statusCode: 500, json: {} }));
    const { isError, body } = await call(registerLabelWorkItem, ctx, { key: 'US-1' });
    expect(isError).toBe(true);
    expect(JSON.stringify(body)).toContain('at least one label');
    expect(calls).toHaveLength(0);
  });

  it('rova_plan_work_items DRY RUN writes nothing and previews the move and its warnings', async () => {
    const { ctx, calls } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      return { statusCode: 500, json: {} };
    });
    const { isError, body } = await call(registerPlanWorkItems, ctx, {
      project: 'NXP',
      itemKeys: ['US-1', 'TA-1'],
      iteration: 'Sprint 1',
    });
    expect(isError, JSON.stringify(body)).toBeFalsy();
    // The ONLY calls are reads: no PATCH reached the bridge.
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(body).toMatchObject({
      dryRun: true,
      target: { kind: 'iteration', id: ITERATION.id, state: 'committed' },
      items: [
        { itemKey: 'US-1', eligible: true },
        { itemKey: 'TA-1', eligible: false },
      ],
    });
    const warnings = body.warnings as string[];
    expect(warnings.join(' ')).toContain('Only stories and defects');
    expect(warnings.join(' ')).toContain('COMMITTED');
  });

  it('rova_plan_work_items performs ONE bulk-iteration PATCH when dryRun is false', async () => {
    const { ctx, calls } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      if (call.method === 'PATCH' && call.url === '/v1/work-items/bulk-iteration') {
        return { statusCode: 200, json: { updated: 1 } };
      }
      return { statusCode: 500, json: {} };
    });
    const { isError, body } = await call(registerPlanWorkItems, ctx, {
      project: 'NXP',
      itemKeys: ['US-1'],
      iteration: 'Sprint 1',
      dryRun: false,
    });
    expect(isError, JSON.stringify(body)).toBeFalsy();
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(BulkAssignIterationSchema.safeParse(patch.body).success).toBe(true);
    expect(patch.body).toEqual({
      projectId: PROJECT,
      itemIds: [STORY.id],
      iterationId: ITERATION.id,
    });
    expect(body).toMatchObject({ dryRun: false, updated: 1, changed: ['iterationId'] });
  });

  it('a bulk write 2xx without an `updated` count is an ERROR, never a guessed success', async () => {
    const { ctx } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      if (call.method === 'PATCH') return { statusCode: 200, json: { ok: true } };
      return { statusCode: 500, json: {} };
    });
    const { isError, body } = await call(registerPlanWorkItems, ctx, {
      project: 'NXP',
      itemKeys: ['US-1'],
      iteration: 'Sprint 1',
      dryRun: false,
    });
    expect(isError).toBe(true);
    expect(JSON.stringify(body)).toContain('without an `updated` count');
  });

  it('rova_plan_work_items moves to a release, and null clears it (back to the backlog)', async () => {
    const { ctx, calls } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      if (call.method === 'PATCH' && call.url === '/v1/work-items/bulk-release') {
        return { statusCode: 200, json: { updated: 1 } };
      }
      return { statusCode: 500, json: {} };
    });
    await call(registerPlanWorkItems, ctx, {
      project: 'NXP',
      itemKeys: ['US-1'],
      release: 'R-1',
      dryRun: false,
    });
    const withRelease = calls.find((c) => c.method === 'PATCH')!;
    expect(BulkAssignReleaseSchema.safeParse(withRelease.body).success).toBe(true);
    expect(withRelease.body).toEqual({
      projectId: PROJECT,
      itemIds: [STORY.id],
      releaseId: RELEASE.id,
    });

    calls.length = 0;
    await call(registerPlanWorkItems, ctx, {
      project: 'NXP',
      itemKeys: ['US-1'],
      release: null,
      dryRun: false,
    });
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      projectId: PROJECT,
      itemIds: [STORY.id],
      releaseId: null,
    });
  });

  it('rova_plan_work_items refuses a mixed-project selection and two targets', async () => {
    const { ctx, calls } = context((call) => {
      if (call.method === 'GET' && call.url === '/v1/work-items/by-key') {
        const item = itemsByKey[String(call.query?.['itemKey'])];
        return item
          ? { statusCode: 200, json: { item: { ...item, projectId: U(99) } } }
          : { statusCode: 404, json: {} };
      }
      return { statusCode: 200, json: { data: [{ id: PROJECT, key: 'NXP', name: 'NXP' }] } };
    });
    const mixed = await call(registerPlanWorkItems, ctx, {
      project: 'NXP',
      itemKeys: ['US-1'],
      iteration: 'Sprint 1',
    });
    expect(mixed.isError).toBe(true);
    expect(JSON.stringify(mixed.body)).toContain('another project');

    const twoTargets = await call(registerPlanWorkItems, ctx, {
      project: 'NXP',
      itemKeys: ['US-1'],
      iteration: 'Sprint 1',
      release: 'R-1',
    });
    expect(twoTargets.isError).toBe(true);
    expect(JSON.stringify(twoTargets.body)).toContain('exactly one of iteration or release');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('rova_plan_work_items relays the REST refusal (Editor bulk release is 403)', async () => {
    const restBody = { error: { code: 'FORBIDDEN', message: 'Forbidden resource' } };
    const { ctx } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      return { statusCode: 403, json: restBody };
    });
    const { isError, body } = await call(registerPlanWorkItems, ctx, {
      project: 'NXP',
      itemKeys: ['US-1'],
      release: 'R-1',
      dryRun: false,
    });
    expect(isError).toBe(true);
    expect(body).toEqual({ statusCode: 403, error: restBody });
  });

  it('an ambiguous label name is refused with candidates, never guessed', async () => {
    const { ctx, calls } = context((call) => {
      if (call.method === 'GET' && call.url === '/v1/work-items/by-key') {
        return { statusCode: 200, json: { item: STORY }, headers: { ETag: '"0"' } };
      }
      if (call.url === `/v1/projects/${PROJECT}/labels`) {
        return {
          statusCode: 200,
          json: [LABELS[0], { ...LABELS[1], name: 'api' }],
        };
      }
      return { statusCode: 500, json: {} };
    });
    const { isError, body } = await call(registerLabelWorkItem, ctx, {
      key: 'US-1',
      add: ['api'],
    });
    expect(isError).toBe(true);
    expect(JSON.stringify(body)).toContain('matches 2 labels');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('a labels feed refusal is relayed unchanged (the same 403/404 REST answers)', async () => {
    const restBody = { error: { code: 'PROJECT_PERMISSION_DENIED', message: 'Forbidden' } };
    const { ctx } = context((call) => {
      if (call.method === 'GET' && call.url === '/v1/work-items/by-key') {
        return { statusCode: 200, json: { item: STORY }, headers: { ETag: '"0"' } };
      }
      return { statusCode: 403, json: restBody };
    });
    const { isError, body } = await call(registerLabelWorkItem, ctx, {
      key: 'US-1',
      add: ['api'],
    });
    expect(isError).toBe(true);
    expect(body).toEqual({ statusCode: 403, error: restBody });
  });

  it('a label write that fails part-way answers applied/notApplied; a bad label read is an error', async () => {
    const restBody = { error: { code: 'PROJECT_ARCHIVED', message: 'archived' } };
    const { ctx } = context((call) => {
      if (call.method === 'GET' && call.url === '/v1/work-items/by-key') {
        return { statusCode: 200, json: { item: STORY }, headers: { ETag: '"0"' } };
      }
      const hit = feeds(call);
      if (hit) return hit;
      if (call.method === 'POST') return { statusCode: 412, json: restBody };
      return { statusCode: 200, json: LABELS };
    });
    const partial = await call(registerLabelWorkItem, ctx, {
      key: 'US-1',
      add: ['api'],
      remove: ['ui'],
    });
    // The add failed; the REMOVE still ran, and the answer says exactly what landed.
    expect(partial.isError).toBeFalsy();
    expect(partial.body).toMatchObject({
      partial: true,
      applied: [{ name: 'ui', action: 'remove' }],
      notApplied: [{ name: 'api', action: 'add' }],
      failure: { statusCode: 412 },
    });
    expect(partial.body.added).toEqual([]);
    expect(partial.body.removed).toEqual(['ui']);

    // The post-write label read failing is an ERROR — never an empty list claimed as the set.
    const { ctx: second } = context((call) => {
      if (call.method === 'GET' && call.url === '/v1/work-items/by-key') {
        return { statusCode: 200, json: { item: STORY }, headers: { ETag: '"0"' } };
      }
      const hit = feeds(call);
      if (hit) return hit;
      if (call.method === 'DELETE') return { statusCode: 204, json: {} };
      return { statusCode: 502, json: { error: { code: 'BAD_GATEWAY' } } };
    });
    const badRead = await call(registerLabelWorkItem, second, { key: 'US-1', remove: ['ui'] });
    expect(badRead.isError).toBe(true);
    expect(badRead.body).toMatchObject({ statusCode: 502 });
  });

  it('a link 2xx with an unexpected body is still a SUCCESS; only the relation list is omitted', async () => {
    const { ctx } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      return { statusCode: 201, json: { unexpected: true } };
    });
    const { isError, body } = await call(registerLinkWorkItems, ctx, {
      fromKey: 'US-1',
      toKey: 'DE-1',
      relationType: 'duplicates',
    });
    expect(isError).toBeFalsy();
    expect(body).toMatchObject({ relationType: 'duplicates', changed: ['relation'] });
    expect(body.relations).toBeUndefined();
  });

  it('rova_plan_work_items previews a CLEAR and an eligible all-story batch without warnings', async () => {
    const { ctx, calls } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      return { statusCode: 500, json: {} };
    });
    const { isError, body } = await call(registerPlanWorkItems, ctx, {
      project: 'NXP',
      itemKeys: ['US-1'],
      iteration: null,
    });
    expect(isError, JSON.stringify(body)).toBeFalsy();
    expect(body).toMatchObject({
      dryRun: true,
      target: { kind: 'iteration', id: null, name: null },
      items: [{ eligible: true }],
      warnings: [],
    });
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('rova_plan_work_items relays an unknown iteration with candidates and writes nothing', async () => {
    const { ctx, calls } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      return { statusCode: 500, json: {} };
    });
    const { isError, body } = await call(registerPlanWorkItems, ctx, {
      project: 'NXP',
      itemKeys: ['US-1'],
      iteration: 'Sprint 99',
    });
    expect(isError).toBe(true);
    expect(JSON.stringify(body)).toContain('No iteration matches');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('a work item that already sits in a timebox previews its FROM value', async () => {
    const scheduled = { ...STORY, iterationId: U(40), releaseId: U(50) };
    const { ctx } = context((call) => {
      if (call.method === 'GET' && call.url === '/v1/work-items/by-key') {
        return { statusCode: 200, json: { item: scheduled }, headers: { ETag: '"0"' } };
      }
      const hit = feeds(call);
      if (hit) return hit;
      return { statusCode: 500, json: {} };
    });
    const { body } = await call(registerPlanWorkItems, ctx, {
      project: 'NXP',
      itemKeys: ['US-1'],
      release: 'R-1',
    });
    expect(body).toMatchObject({ items: [{ from: { id: U(50) } }] });
  });

  it('each description says WRITES and "explicit request"; plan defaults to a dry run', async () => {
    const ctx = context(() => ({ statusCode: 500, json: {} })).ctx;
    for (const register of [registerLinkWorkItems, registerLabelWorkItem, registerPlanWorkItems]) {
      const server = new McpServer({ name: 'test', version: '0.0.0' });
      const tool = register(server, ctx) as {
        description?: string;
        annotations?: { readOnlyHint?: boolean };
      };
      expect(tool.description).toContain('WRITES');
      expect(tool.description).toContain('explicit request');
      expect(tool.annotations?.readOnlyHint).toBe(false);
    }
  });
});
