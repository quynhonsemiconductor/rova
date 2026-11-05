import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRestCall, McpRestResult, ToolContext } from './rest';
import {
  CreateTaskSchema,
  CreateWorkItemSchema,
  UpdateWorkItemSchema,
} from '@modules/work-items/interface/http/dto/work-item-request.dto';
import { registerCreateWorkItem } from './create_work_item';
import { registerGetWorkItem } from './get_work_item';
import { registerAddTask } from './add_task';
import { registerUpdateWorkItem } from './update_work_item';

const U = (n: number) => `0194a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const PROJECT = U(10);
const ITEM = U(20);
const ITEM_ROW = {
  id: ITEM,
  itemKey: 'US-412',
  title: 'Story',
  type: 'story',
  projectId: PROJECT,
};

function context(route: (call: McpRestCall) => McpRestResult) {
  const calls: McpRestCall[] = [];
  const idempotencyKey = vi.fn((_tool: string, _args: unknown) => 'k-test');
  const clientIdempotencyKey = vi.fn((_tool: string, _args: unknown) => 'k-test');
  const ctx: ToolContext = {
    principal: { userId: U(1), workspaceId: U(2), sessionId: 'mcp:writes' },
    callRest: async (_p, call) => {
      calls.push(call);
      return route(call);
    },
    idempotencyKey,
    clientIdempotencyKey,
  };
  return { ctx, calls, idempotencyKey, clientIdempotencyKey };
}

async function call(
  register: (server: McpServer, ctx: ToolContext) => unknown,
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; body: Record<string, unknown>; description?: string }> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const tool = register(server, ctx) as {
    description?: string;
    handler: (
      a: unknown,
      e: unknown,
    ) => Promise<{ isError?: boolean; content: { text: string }[] }>;
  };
  const result = await tool.handler(args, {});
  return {
    isError: result.isError,
    body: JSON.parse(result.content[0].text) as Record<string, unknown>,
    description: tool.description,
  };
}

/** The reference feeds every write tool resolves through — one realistic row each. */
const TEAM = { teamId: U(30), name: 'Alpha', key: 'ALP', status: 'active' };
const ITERATION = { id: U(40), name: 'Sprint 1', iterationKey: 'S1', state: 'committed' };
const RELEASE = { id: U(50), name: 'R-1', releaseKey: 'R1', status: 'planning' };
const FEATURE = {
  id: U(60),
  itemKey: 'FE-3',
  name: 'Feature 3',
  projectId: PROJECT,
  type: 'feature',
};
const PERSON = { userId: U(70), displayName: 'Alice', email: 'alice@qnsc.dev' };
const STATUS = { id: U(80), name: 'In Progress', category: 'in_progress', isDefault: false };

function feeds(call: McpRestCall): McpRestResult | null {
  if (call.url === '/v1/projects') {
    return { statusCode: 200, json: { data: [{ id: PROJECT, key: 'NXP', name: 'NXP' }] } };
  }
  if (call.url === `/v1/projects/${PROJECT}/teams`) return { statusCode: 200, json: [TEAM] };
  if (call.url === '/v1/iterations/options') return { statusCode: 200, json: [ITERATION] };
  if (call.url === '/v1/releases/options') return { statusCode: 200, json: [RELEASE] };
  if (call.url === `/v1/projects/${PROJECT}/statuses`) return { statusCode: 200, json: [STATUS] };
  if (
    call.url === `/v1/workspaces/${U(2)}/member-options` ||
    call.url === `/v1/projects/${PROJECT}/member-options`
  )
    return { statusCode: 200, json: [PERSON] };
  if (call.url === '/v1/portfolio-items') return { statusCode: 200, json: { data: [FEATURE] } };
  if (
    call.method === 'GET' &&
    (call.url === '/v1/work-items/by-key' || call.url === `/v1/work-items/${ITEM}`)
  ) {
    return { statusCode: 200, json: { item: ITEM_ROW }, headers: { ETag: '"3"' } };
  }
  return null;
}

describe('PR3 work-item write tools', () => {
  it('rova_create_work_item resolves every named reference and posts a body the real DTO accepts', async () => {
    const { ctx, calls, clientIdempotencyKey } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      if (call.method === 'POST' && call.url === '/v1/work-items') {
        return {
          statusCode: 201,
          json: { ...ITEM_ROW, description: 'd', statusId: U(80), scheduleState: 'defined' },
          headers: { ETag: '"0"' },
        };
      }
      if (call.method === 'PATCH' && call.url === `/v1/work-items/${ITEM}`) {
        return { statusCode: 200, json: ITEM_ROW, headers: { ETag: '"1"' } };
      }
      return { statusCode: 404, json: { error: 'x' } };
    });

    const args = {
      project: 'NXP',
      type: 'story',
      title: 'Do the thing',
      description: 'd',
      assignee: 'alice@qnsc.dev',
      team: 'ALP',
      iteration: 'Sprint 1',
      release: 'R-1',
      feature: 'FE-3',
      storyPoints: 3,
      requestId: 'req-create',
    };
    const { isError, body } = await call(registerCreateWorkItem, ctx, args);

    expect(isError, JSON.stringify(body)).toBeFalsy();
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/v1/work-items');
    expect(post.idempotencyKey).toBe('k-test');
    expect(clientIdempotencyKey).toHaveBeenCalledWith('rova_create_work_item', {
      requestId: 'req-create',
    });
    expect(post.body).toEqual({
      projectId: PROJECT,
      type: 'story',
      title: 'Do the thing',
      description: 'd',
      assigneeId: PERSON.userId,
      teamId: TEAM.teamId,
      iterationId: ITERATION.id,
      releaseId: RELEASE.id,
      storyPoints: 3,
    });
    // The contract, not our idea of it: the body is accepted by the route's own schema — and
    // featureId is NOT in it (the schema has none; Zod would strip it silently).
    expect(CreateWorkItemSchema.safeParse(post.body).success).toBe(true);
    expect(post.body).not.toHaveProperty('featureId');

    // The Feature is linked by one follow-up PATCH, with the version the create returned.
    const link = calls.find((c) => c.method === 'PATCH')!;
    expect(link.url).toBe(`/v1/work-items/${ITEM}`);
    expect(link.body).toEqual({ featureId: FEATURE.id });
    expect(link.ifMatch).toBe('"0"');

    expect(body).toMatchObject({
      workItem: { id: ITEM, itemKey: 'US-412', type: 'story' },
      version: 0,
      replayed: false,
      featureLink: { linked: true },
      changed: expect.arrayContaining([
        'description',
        'assigneeId',
        'iterationId',
        'releaseId',
        'featureId',
      ]),
    });
  });

  it('rova_create_work_item refuses a defect parent that is not a story, and a Feature from another project', async () => {
    const noFeeds = context((call) => {
      if (call.url === '/v1/work-items/by-key') {
        return { statusCode: 200, json: { item: { ...ITEM_ROW, type: 'defect' } } };
      }
      if (call.url === '/v1/portfolio-items') {
        return { statusCode: 200, json: { data: [{ ...FEATURE, projectId: U(99) }] } };
      }
      const hit = feeds(call);
      if (hit) return hit;
      return { statusCode: 500, json: {} };
    });
    const wrongParent = await call(registerCreateWorkItem, noFeeds.ctx, {
      project: 'NXP',
      type: 'defect',
      title: 'Broken',
      parentStory: 'DE-7',
    });
    expect(wrongParent.isError).toBe(true);
    expect(JSON.stringify(wrongParent.body)).toContain('parent must be a story');
    expect(noFeeds.calls.some((c) => c.method === 'POST')).toBe(false);

    const wrongFeature = await call(registerCreateWorkItem, noFeeds.ctx, {
      project: 'NXP',
      type: 'story',
      title: 'Do',
      feature: 'FE-3',
    });
    expect(wrongFeature.isError).toBe(true);
    expect(JSON.stringify(wrongFeature.body)).toContain('another project');
  });

  it('the SAME requestId produces the same key on a retry; no requestId produces none', async () => {
    const { ctx, calls, clientIdempotencyKey } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      return { statusCode: 201, json: ITEM_ROW, headers: { ETag: '"0"' } };
    });

    const args = { project: 'NXP', type: 'story', title: 'same', requestId: 'req-same' };
    await call(registerCreateWorkItem, ctx, args);
    await call(registerCreateWorkItem, ctx, args);
    expect(clientIdempotencyKey.mock.calls).toEqual([
      ['rova_create_work_item', { requestId: 'req-same' }],
      ['rova_create_work_item', { requestId: 'req-same' }],
    ]);

    const before = calls.filter((c) => c.method === 'POST').length;
    await call(registerCreateWorkItem, ctx, { project: 'NXP', type: 'story', title: 'no key' });
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(before + 1);
    expect(posts[posts.length - 1]?.idempotencyKey).toBeUndefined();
  });

  it('rova_add_task posts a CreateTaskSchema body under the parent and keys only an explicit requestId', async () => {
    const { ctx, calls, clientIdempotencyKey } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      if (call.method === 'POST' && call.url === `/v1/work-items/${ITEM}/tasks`) {
        return {
          statusCode: 201,
          json: { ...ITEM_ROW, id: U(21), itemKey: 'TA-1', type: 'task', title: 'Step one' },
          headers: { ETag: '"0"' },
        };
      }
      return { statusCode: 500, json: {} };
    });

    const args = {
      parentKey: 'US-412',
      title: 'Step one',
      description: 'first',
      state: 'in_progress',
      assignee: 'alice@qnsc.dev',
      estimateHours: 2,
      requestId: 'req-task',
    };
    const { isError, body } = await call(registerAddTask, ctx, args);

    expect(isError, JSON.stringify(body)).toBeFalsy();
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({
      title: 'Step one',
      description: 'first',
      state: 'in_progress',
      assigneeId: PERSON.userId,
      estimateHours: 2,
    });
    expect(CreateTaskSchema.safeParse(post.body).success).toBe(true);
    expect(clientIdempotencyKey).toHaveBeenCalledWith('rova_add_task', { requestId: 'req-task' });
    expect(post.idempotencyKey).toBe('k-test');
    expect(body).toMatchObject({ workItem: { type: 'task', itemKey: 'TA-1' }, version: 0 });
  });

  it('rova_add_task refuses a parent that is itself a task', async () => {
    const { ctx, calls } = context((call) => {
      if (call.url === '/v1/work-items/by-key') {
        return { statusCode: 200, json: { item: { ...ITEM_ROW, type: 'task' } }, headers: {} };
      }
      return { statusCode: 500, json: {} };
    });
    const { isError } = await call(registerAddTask, ctx, { parentKey: 'TA-1', title: 'x' });
    expect(isError).toBe(true);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it("rova_update_work_item sends the caller's If-Match and a UpdateWorkItemSchema body", async () => {
    const { ctx, calls } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      if (call.method === 'PATCH') {
        return {
          statusCode: 200,
          json: { ...ITEM_ROW, title: 'Renamed', scheduleState: 'in_progress' },
          headers: { ETag: '"4"' },
        };
      }
      return { statusCode: 500, json: {} };
    });

    const { isError, body } = await call(registerUpdateWorkItem, ctx, {
      key: 'US-412',
      ifMatch: '3',
      title: 'Renamed',
      status: 'In Progress',
      assignee: 'alice@qnsc.dev',
      blocked: { isBlocked: true, reason: 'waiting' },
    });

    expect(isError, JSON.stringify(body)).toBeFalsy();
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe(`/v1/work-items/${ITEM}`);
    expect(patch.ifMatch).toBe('"3"');
    expect(patch.body).toEqual({
      title: 'Renamed',
      statusId: STATUS.id,
      assigneeId: PERSON.userId,
      isBlocked: true,
      blockedReason: 'waiting',
    });
    expect(UpdateWorkItemSchema.safeParse(patch.body).success).toBe(true);
    expect(body).toMatchObject({ version: 4, changed: expect.arrayContaining(['statusId']) });
  });

  it('rova_update_work_item clears a nullable reference with an explicit null', async () => {
    const { ctx, calls } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      if (call.method === 'PATCH') {
        return { statusCode: 200, json: ITEM_ROW, headers: { ETag: '"4"' } };
      }
      return { statusCode: 500, json: {} };
    });

    await call(registerUpdateWorkItem, ctx, {
      key: 'US-412',
      ifMatch: '"3"',
      assignee: null,
      iteration: null,
      release: null,
      feature: null,
    });

    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.body).toEqual({
      assigneeId: null,
      iterationId: null,
      releaseId: null,
      featureId: null,
    });
    expect(UpdateWorkItemSchema.safeParse(patch.body).success).toBe(true);
  });

  it('rova_update_work_item answers a 412 WORK_ITEM_STALE with the FRESH item and its new version', async () => {
    const { ctx, calls } = context((call) => {
      if (call.method === 'PATCH') {
        return { statusCode: 412, json: { error: { code: 'WORK_ITEM_STALE', message: 'stale' } } };
      }
      if (call.method === 'GET' && call.url === `/v1/work-items/${ITEM}`) {
        return {
          statusCode: 200,
          json: { item: { ...ITEM_ROW, title: 'Theirs', scheduleState: 'completed' } },
          headers: { ETag: '"9"' },
        };
      }
      const hit = feeds(call);
      if (hit) return hit;
      return { statusCode: 500, json: {} };
    });

    const { isError, body } = await call(registerUpdateWorkItem, ctx, {
      key: 'US-412',
      ifMatch: '0',
      title: 'Mine',
    });

    expect(isError).toBe(true);
    expect(body).toMatchObject({
      statusCode: 412,
      error: { error: { code: 'WORK_ITEM_STALE' } },
      current: { id: ITEM, title: 'Theirs', scheduleState: 'completed' },
      version: 9,
    });
    // The tool re-reads exactly once, through the bridge, with the caller's principal.
    expect(
      calls.filter((c) => c.method === 'GET' && c.url === `/v1/work-items/${ITEM}`),
    ).toHaveLength(1);
  });

  it('rova_update_work_item refuses an empty patch instead of sending one', async () => {
    const { ctx, calls } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      return { statusCode: 500, json: {} };
    });
    const { isError, body } = await call(registerUpdateWorkItem, ctx, {
      key: 'US-412',
      ifMatch: '3',
    });
    expect(isError).toBe(true);
    expect(JSON.stringify(body)).toContain('at least one field');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it("rova_update_work_item sends the caller's ifMatch as given, and refuses a malformed one", async () => {
    const { ctx, calls } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      if (call.method === 'PATCH') {
        return { statusCode: 200, json: ITEM_ROW, headers: { ETag: '"4"' } };
      }
      return { statusCode: 500, json: {} };
    });

    await call(registerUpdateWorkItem, ctx, { key: 'US-412', title: 'x', ifMatch: '2' });
    expect(calls.find((c) => c.method === 'PATCH')!.ifMatch).toBe('"2"');

    const bad = await call(registerUpdateWorkItem, ctx, {
      key: 'US-412',
      title: 'x',
      ifMatch: 'yesterday',
    });
    expect(bad.isError).toBe(true);
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
  });

  it('rova_create_work_item sends the defect fields, a valid parent Story and the found-in release', async () => {
    const { ctx, calls } = context((call) => {
      if (call.url === '/v1/work-items/by-key') {
        return { statusCode: 200, json: { item: ITEM_ROW }, headers: { ETag: '"1"' } };
      }
      const hit = feeds(call);
      if (hit) return hit;
      if (call.method === 'POST' && call.url === '/v1/work-items') {
        return {
          statusCode: 201,
          json: { ...ITEM_ROW, type: 'defect' },
          headers: { ETag: '"0"' },
        };
      }
      return { statusCode: 500, json: {} };
    });

    const { isError, body } = await call(registerCreateWorkItem, ctx, {
      project: 'NXP',
      type: 'defect',
      title: 'Broken',
      parentStory: 'US-412',
      priority: 'high',
      severity: 'major',
      foundInEnvironment: 'staging',
      foundInRelease: 'R-1',
    });
    expect(isError, JSON.stringify(body)).toBeFalsy();
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({
      type: 'defect',
      parentId: ITEM,
      priority: 'high',
      severity: 'major',
      foundInEnvironment: 'staging',
      foundInReleaseId: RELEASE.id,
    });
    expect(CreateWorkItemSchema.safeParse(post.body).success).toBe(true);
  });

  it('rova_create_work_item refuses a parentStory on a story, and an Epic as the Feature', async () => {
    const { ctx } = context((call) => {
      if (call.url === '/v1/work-items/by-key') {
        return { statusCode: 200, json: { item: ITEM_ROW }, headers: { ETag: '"1"' } };
      }
      if (call.url === '/v1/portfolio-items') {
        return { statusCode: 200, json: { data: [{ ...FEATURE, itemKey: 'EP-1', type: 'epic' }] } };
      }
      const hit = feeds(call);
      if (hit) return hit;
      return { statusCode: 500, json: {} };
    });
    const parentOnStory = await call(registerCreateWorkItem, ctx, {
      project: 'NXP',
      type: 'story',
      title: 'x',
      parentStory: 'US-412',
    });
    expect(parentOnStory.isError).toBe(true);
    expect(JSON.stringify(parentOnStory.body)).toContain('only valid for a defect');

    const epic = await call(registerCreateWorkItem, ctx, {
      project: 'NXP',
      type: 'story',
      title: 'x',
      feature: 'EP-1',
    });
    expect(epic.isError).toBe(true);
    expect(JSON.stringify(epic.body)).toContain('only roll up to a Feature');
  });

  it('rova_update_work_item maps every remaining field to its REST name', async () => {
    const { ctx, calls } = context((call) => {
      if (call.url === '/v1/work-items/by-key') {
        return { statusCode: 200, json: { item: ITEM_ROW }, headers: { ETag: '"3"' } };
      }
      const hit = feeds(call);
      if (hit) return hit;
      if (call.method === 'PATCH') {
        return { statusCode: 200, json: ITEM_ROW, headers: { ETag: '"4"' } };
      }
      return { statusCode: 500, json: {} };
    });

    const { isError, body } = await call(registerUpdateWorkItem, ctx, {
      key: 'US-412',
      ifMatch: '3',
      description: 'd',
      acceptanceCriteria: 'ac',
      scheduleState: 'completed',
      priority: 'urgent',
      devOwner: 'alice@qnsc.dev',
      team: 'Alpha',
      iteration: 'Sprint 1',
      release: 'R-1',
      feature: 'FE-3',
      parent: 'US-412',
      storyPoints: 5,
      estimateHours: 8,
      todoHours: 4,
      actualHours: 2,
      severity: 'minor',
      defectState: 'fixed',
      rootCause: 'code',
      resolution: 'fixed',
      fixedInBuild: 'b42',
      foundInEnvironment: 'production',
      foundInRelease: 'R-1',
      targetEndDate: '2026-06-30',
      blocked: { isBlocked: false },
    });

    expect(isError, JSON.stringify(body)).toBeFalsy();
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.body).toMatchObject({
      description: 'd',
      acceptanceCriteria: 'ac',
      scheduleState: 'completed',
      priority: 'urgent',
      devOwnerId: PERSON.userId,
      teamId: TEAM.teamId,
      iterationId: ITERATION.id,
      releaseId: RELEASE.id,
      featureId: FEATURE.id,
      parentId: ITEM,
      storyPoints: 5,
      estimateHours: 8,
      todoHours: 4,
      actualHours: 2,
      severity: 'minor',
      defectState: 'fixed',
      rootCause: 'code',
      resolution: 'fixed',
      fixedInBuild: 'b42',
      foundInEnvironment: 'production',
      foundInReleaseId: RELEASE.id,
      targetEndDate: '2026-06-30',
      isBlocked: false,
    });
    // No blockedReason key when the block carries no reason.
    expect(patch.body).not.toHaveProperty('blockedReason');
    expect(UpdateWorkItemSchema.safeParse(patch.body).success).toBe(true);
  });

  it('rova_update_work_item clears the remaining nullable references with null', async () => {
    const { ctx, calls } = context((call) => {
      if (call.url === '/v1/work-items/by-key') {
        return { statusCode: 200, json: { item: ITEM_ROW }, headers: { ETag: '"3"' } };
      }
      const hit = feeds(call);
      if (hit) return hit;
      if (call.method === 'PATCH') {
        return { statusCode: 200, json: ITEM_ROW, headers: { ETag: '"4"' } };
      }
      return { statusCode: 500, json: {} };
    });
    await call(registerUpdateWorkItem, ctx, {
      key: 'US-412',
      ifMatch: '3',
      devOwner: null,
      team: null,
      parent: null,
      foundInRelease: null,
      description: null,
      targetEndDate: null,
    });
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      description: null,
      devOwnerId: null,
      teamId: null,
      parentId: null,
      foundInReleaseId: null,
      targetEndDate: null,
    });
  });

  it('rova_update_work_item relays a reference miss with candidates and writes nothing', async () => {
    const { ctx, calls } = context((call) => {
      if (call.url === '/v1/work-items/by-key') {
        return { statusCode: 200, json: { item: ITEM_ROW }, headers: { ETag: '"3"' } };
      }
      const hit = feeds(call);
      if (hit) return hit;
      return { statusCode: 500, json: {} };
    });
    const { isError, body } = await call(registerUpdateWorkItem, ctx, {
      key: 'US-412',
      team: 'Ghost',
    });
    expect(isError).toBe(true);
    expect(JSON.stringify(body)).toContain('Candidates');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('an ambiguous timebox name is refused with both candidates, never guessed', async () => {
    const { ctx, calls } = context((call) => {
      if (call.url === '/v1/work-items/by-key') {
        return { statusCode: 200, json: { item: ITEM_ROW }, headers: { ETag: '"3"' } };
      }
      if (call.url === '/v1/iterations/options') {
        return {
          statusCode: 200,
          json: [ITERATION, { ...ITERATION, id: U(41) }],
        };
      }
      const hit = feeds(call);
      if (hit) return hit;
      return { statusCode: 500, json: {} };
    });
    const { isError, body } = await call(registerUpdateWorkItem, ctx, {
      key: 'US-412',
      ifMatch: '3',
      iteration: 'Sprint 1',
    });
    expect(isError).toBe(true);
    expect(JSON.stringify(body)).toContain('matches 2 iterations');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('a write tool refuses to create without the idempotency-key builder', async () => {
    const ctx: ToolContext = {
      principal: { userId: U(1), workspaceId: U(2), sessionId: 'mcp:no-keys' },
      callRest: async () => ({ statusCode: 200, json: { item: ITEM_ROW } }),
    };
    for (const [register, args] of [
      [registerCreateWorkItem, { project: 'NXP', type: 'story', title: 'x' }],
      [registerAddTask, { parentKey: 'US-412', title: 'x' }],
      [registerUpdateWorkItem, { key: 'US-412', ifMatch: '3', title: 'x' }],
    ] as const) {
      const { isError, body } = await call(register, ctx, args);
      expect(isError).toBe(true);
      expect(JSON.stringify(body)).toContain('Writes are not enabled');
    }
  });

  it('rova_update_work_item is REFUSED without ifMatch: the edit must name the version it read', async () => {
    const { ctx, calls } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      return { statusCode: 500, json: {} };
    });
    const { isError, body } = await call(registerUpdateWorkItem, ctx, {
      key: 'US-412',
      title: 'x',
    });
    expect(isError).toBe(true);
    expect(JSON.stringify(body)).toContain('ifMatch required: pass the version from');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('states a partial success when the Feature link PATCH fails: the item exists, the link did not land', async () => {
    const { ctx, calls } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      if (call.method === 'POST' && call.url === '/v1/work-items') {
        return { statusCode: 201, json: ITEM_ROW, headers: { ETag: '"0"' } };
      }
      if (call.method === 'PATCH') {
        return { statusCode: 412, json: { error: { code: 'WORK_ITEM_STALE' } } };
      }
      return { statusCode: 500, json: {} };
    });
    const { isError, body } = await call(registerCreateWorkItem, ctx, {
      project: 'NXP',
      type: 'story',
      title: 'partial',
      feature: 'FE-3',
    });
    // The create succeeded, so the tool must not deny the whole call.
    expect(isError).toBeFalsy();
    expect(body).toMatchObject({
      workItem: { id: ITEM },
      featureLink: { linked: false, error: { error: { code: 'WORK_ITEM_STALE' } } },
    });
    expect(body.changed).not.toContain('featureId');
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
  });

  it('a REPLAYED create does not re-apply the Feature link (the first call did)', async () => {
    const { ctx, calls } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      if (call.method === 'POST' && call.url === '/v1/work-items') {
        return {
          statusCode: 201,
          json: ITEM_ROW,
          headers: { ETag: '"0"', 'Idempotency-Replayed': 'true' },
        };
      }
      if (call.method === 'PATCH') {
        return { statusCode: 200, json: ITEM_ROW, headers: { ETag: '"1"' } };
      }
      return { statusCode: 500, json: {} };
    });
    const { body } = await call(registerCreateWorkItem, ctx, {
      project: 'NXP',
      type: 'story',
      title: 'twice',
      feature: 'FE-3',
      requestId: 'req-replay',
    });
    expect(body.replayed).toBe(true);
    expect(body.featureLink).toEqual({ linked: 'unknown', replayed: true });
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('an idempotent CREATE reports replayed from the REST marker', async () => {
    const { ctx } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      if (call.method === 'POST' && call.url === '/v1/work-items') {
        return {
          statusCode: 201,
          json: ITEM_ROW,
          headers: { ETag: '"0"', 'Idempotency-Replayed': 'true' },
        };
      }
      return { statusCode: 500, json: {} };
    });
    const { body } = await call(registerCreateWorkItem, ctx, {
      project: 'NXP',
      type: 'story',
      title: 'twice',
      requestId: 'req-replay',
    });
    expect(body.replayed).toBe(true);
  });

  it('rova_get_work_item answers the version from the ETag, so the model can update what it read', async () => {
    const { ctx } = context((call) => {
      if (call.url === `/v1/work-items/${ITEM}`) {
        return { statusCode: 200, json: ITEM_ROW, headers: { ETag: '"7"' } };
      }
      return { statusCode: 500, json: {} };
    });
    const { isError, body } = await call(registerGetWorkItem, ctx, { workItemId: ITEM });
    expect(isError).toBeFalsy();
    expect(body).toMatchObject({ id: ITEM, itemKey: 'US-412', version: 7 });
  });

  it('every write tool says WRITES and "explicit request" in its description', async () => {
    const ctx = context(() => ({ statusCode: 500, json: {} })).ctx;
    for (const register of [registerCreateWorkItem, registerAddTask, registerUpdateWorkItem]) {
      const server = new McpServer({ name: 'test', version: '0.0.0' });
      const tool = register(server, ctx) as {
        description?: string;
        annotations?: { readOnlyHint?: boolean };
      };
      expect(tool.description, 'a write tool must say WRITES').toContain('WRITES');
      expect(tool.description, 'and must demand an explicit request').toContain('explicit request');
      expect(tool.annotations?.readOnlyHint).toBe(false);
    }
    // update is destructive and NOT idempotent: the same body twice can move two different
    // versions (and a Write that changes release/iteration twice is not a no-op).
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const update = registerUpdateWorkItem(server, ctx) as {
      annotations?: { destructiveHint?: boolean; idempotentHint?: boolean };
    };
    expect(update.annotations).toMatchObject({ destructiveHint: true, idempotentHint: false });
  });
});
