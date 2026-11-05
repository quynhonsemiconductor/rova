import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  clientIdempotencyKeyFor,
  type McpRestCall,
  type McpRestResult,
  type ToolContext,
  type WriteAudit,
} from './rest';
import { CreatePortfolioItemSchema } from '@modules/portfolio/interface/http/dto/portfolio-item-request.dto';
import { CreateIterationSchema } from '@modules/iterations/interface/http/dto/iteration-request.dto';
import { registerSavePortfolioItem } from './save_portfolio_item';
import { registerSaveIteration } from './save_iteration';

const U = (n: number) => `0194a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ME = U(1);
const PROJECT = U(10);
const TEAM = U(20);
const RELEASE = U(30);
const EPIC = U(40);
const FEATURE = U(41);
const ITERATION = U(50);
const PERSON = U(60);
const SECRET = 'x'.repeat(32);

const PROJECT_ROW = { id: PROJECT, key: 'NXP', name: 'NXP' };
const PORTFOLIO_ROWS = [
  {
    id: EPIC,
    itemKey: 'EP-3',
    name: 'Platform',
    projectId: PROJECT,
    type: 'epic',
  },
  {
    id: FEATURE,
    itemKey: 'FE-12',
    name: 'Wafer map export',
    projectId: PROJECT,
    type: 'feature',
  },
];

function portfolioRow(n: number, key: string) {
  return {
    id: U(n),
    itemKey: key,
    type: 'feature',
    name: 'Wafer map export',
    state: 'developing',
    preliminaryEstimate: 'm',
    parentKey: 'EP-3',
    teamName: 'Alpha',
    releaseName: 'R3',
    ownerName: 'Alice',
    plannedStartDate: '2026-11-17',
    plannedEndDate: '2026-11-28',
    archivedAt: null,
    updatedAt: '2026-11-05T09:00:00.000Z',
  };
}

function iterationRow(state = 'planning') {
  return {
    id: ITERATION,
    iterationKey: 'S1',
    name: 'Sprint 1',
    state,
    projectId: PROJECT,
    teamId: null,
    startDate: '2026-11-17',
    endDate: '2026-11-28',
    goal: 'Ship',
    plannedVelocity: 30,
    updatedAt: '2026-11-05T09:00:00.000Z',
  };
}

function context(route: (call: McpRestCall) => McpRestResult) {
  const calls: McpRestCall[] = [];
  const notes: WriteAudit[] = [];
  const clientKey = vi.fn((tool: string, args: unknown) =>
    clientIdempotencyKeyFor(SECRET, ME, tool, args),
  );
  const ctx: ToolContext = {
    principal: { userId: ME, workspaceId: U(2), sessionId: 'mcp:pr6' },
    callRest: async (_p, call) => {
      calls.push(call);
      return route(call);
    },
    clientIdempotencyKey: clientKey,
    noteWrite: (meta) => notes.push(meta),
  };
  return { ctx, calls, notes, clientKey };
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

/** The reference feeds both tools read. */
const feeds = (call: McpRestCall): McpRestResult | null => {
  if (call.method === 'GET' && call.url === '/v1/projects') {
    return { statusCode: 200, json: { data: [PROJECT_ROW], pageInfo: {} } };
  }
  if (call.method === 'GET' && call.url === '/v1/portfolio-items') {
    return { statusCode: 200, json: { data: PORTFOLIO_ROWS, pageInfo: {} } };
  }
  if (call.method === 'GET' && call.url === `/v1/projects/${PROJECT}/teams`) {
    return {
      statusCode: 200,
      json: [{ teamId: TEAM, id: TEAM, name: 'Alpha', key: 'ALP', status: 'active' }],
    };
  }
  if (call.method === 'GET' && call.url === '/v1/releases/options') {
    return { statusCode: 200, json: [{ id: RELEASE, name: 'R3', releaseKey: 'R3' }] };
  }
  if (call.method === 'GET' && call.url === `/v1/projects/${PROJECT}/member-options`) {
    return {
      statusCode: 200,
      json: [{ userId: PERSON, displayName: 'Alice', email: 'alice@qnsc.dev' }],
    };
  }
  if (call.method === 'GET' && call.url === '/v1/iterations/options') {
    return {
      statusCode: 200,
      json: [{ id: ITERATION, name: 'Sprint 1', iterationKey: 'S1', state: 'planning' }],
    };
  }
  if (call.method === 'GET' && call.url === `/v1/iterations/${ITERATION}`) {
    return { statusCode: 200, json: iterationRow() };
  }
  return null;
};

/** The registered tool's zod input shape, what an MCP client's arguments are validated against. */
function inputShape(
  register: (server: McpServer, ctx: ToolContext) => unknown,
): Record<string, { safeParse: (value: unknown) => { success: boolean } }> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const { ctx } = context(() => ({ statusCode: 500, json: {} }));
  const tool = register(server, ctx) as {
    inputSchema: {
      shape: Record<string, { safeParse: (value: unknown) => { success: boolean } }>;
    };
  };
  return tool.inputSchema.shape;
}

describe('rova_save_portfolio_item', () => {
  it('creates a Feature with resolved parent/team/release/owner and the REST create contract', async () => {
    const { ctx, calls, notes } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      return { statusCode: 201, json: portfolioRow(90, 'FE-90') };
    });

    const { isError, body } = await call(registerSavePortfolioItem, ctx, {
      project: 'NXP',
      type: 'feature',
      name: 'Wafer map export',
      parent: 'EP-3',
      team: 'Alpha',
      release: 'R3',
      owner: 'Alice',
      state: 'developing',
      preliminaryEstimate: 'm',
      plannedStartDate: '2026-11-17',
      requestId: 'req-1',
    });
    expect(isError, JSON.stringify(body)).toBeFalsy();

    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/v1/portfolio-items');
    expect(CreatePortfolioItemSchema.safeParse(post.body).success).toBe(true);
    expect(post.body).toMatchObject({
      projectId: PROJECT,
      type: 'feature',
      name: 'Wafer map export',
      parentId: EPIC,
      teamId: TEAM,
      releaseId: RELEASE,
      ownerId: PERSON,
    });
    expect(post.idempotencyKey).toBeTruthy();
    expect(body['changed']).toContain('created');
    expect((body['portfolioItem'] as Record<string, unknown>)['itemKey']).toBe('FE-90');
    // The audit line names the target and the field NAMES only — never a typed value.
    expect(notes[0]).toMatchObject({ targets: [U(90)] });
    expect(notes[0]?.fields).toContain('name');
    expect(JSON.stringify(notes)).not.toContain('Wafer map export');
  });

  it('a REPLAY is reported as such, never as a second create', async () => {
    const { ctx } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      return {
        statusCode: 201,
        json: portfolioRow(90, 'FE-90'),
        headers: { 'idempotency-replayed': 'true' },
      };
    });

    const { body } = await call(registerSavePortfolioItem, ctx, {
      project: 'NXP',
      type: 'feature',
      name: 'Wafer map export',
      requestId: 'req-1',
    });
    expect(body['replayed']).toBe(true);
    expect(body['changed']).not.toContain('created');
  });

  it('updates by key with only the fields given, and null clears a reference', async () => {
    const { ctx, calls } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      return {
        statusCode: 200,
        json: { ...portfolioRow(41, 'FE-12'), teamName: null, releaseName: null },
      };
    });

    const { isError, body } = await call(registerSavePortfolioItem, ctx, {
      key: 'FE-12',
      team: null,
      release: null,
      name: 'Wafer map export (renamed)',
    });
    expect(isError, JSON.stringify(body)).toBeFalsy();
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe(`/v1/portfolio-items/${FEATURE}`);
    expect(patch.body).toEqual({
      name: 'Wafer map export (renamed)',
      teamId: null,
      releaseId: null,
    });
    // A PATCH is a SET: no Idempotency-Key, even when a requestId was supplied.
    expect(patch.idempotencyKey).toBeUndefined();
  });

  it('refuses a planned date that is not a real calendar date', () => {
    const shape = inputShape(registerSavePortfolioItem);
    expect(shape['plannedStartDate'].safeParse('2026-02-30').success).toBe(false);
    expect(shape['plannedEndDate'].safeParse('2026-13-01').success).toBe(false);
    expect(shape['plannedStartDate'].safeParse('2026-11-17').success).toBe(true);
  });

  it('relays the REST refusal: an Editor creating a Feature gets the same 403 the web sees', async () => {
    const { ctx } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      return {
        statusCode: 403,
        json: { error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } },
      };
    });

    const { isError, body } = await call(registerSavePortfolioItem, ctx, {
      project: 'NXP',
      type: 'feature',
      name: 'Wafer map export',
      requestId: 'req-1',
    });
    expect(isError).toBe(true);
    expect(body).toMatchObject({ statusCode: 403 });
  });

  it('relays the archived-project refusal instead of creating through it', async () => {
    const { ctx } = callThrough(() => ({
      statusCode: 422,
      json: { error: { code: 'PROJECT_ARCHIVED' } },
    }));
    const { isError, body } = await call(registerSavePortfolioItem, ctx, {
      project: 'NXP',
      type: 'epic',
      name: 'Epic',
      requestId: 'req-1',
    });
    expect(isError).toBe(true);
    expect(body).toMatchObject({ statusCode: 422 });
  });
});

describe('rova_save_iteration', () => {
  it('creates an iteration with the resolved team and the REST create contract', async () => {
    const { ctx, calls } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      return { statusCode: 201, json: iterationRow() };
    });

    const { isError, body } = await call(registerSaveIteration, ctx, {
      project: 'NXP',
      name: 'Sprint 1',
      team: 'Alpha',
      goal: 'Ship',
      startDate: '2026-11-17',
      endDate: '2026-11-28',
      plannedVelocity: 30,
      requestId: 'req-2',
    });
    expect(isError, JSON.stringify(body)).toBeFalsy();

    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/v1/iterations');
    expect(CreateIterationSchema.safeParse(post.body).success).toBe(true);
    expect(post.body).toMatchObject({ projectId: PROJECT, teamId: TEAM, plannedVelocity: 30 });
    expect(post.body).not.toHaveProperty('state');
    expect(post.idempotencyKey).toBeTruthy();
    expect((body['iteration'] as Record<string, unknown>)['iterationKey']).toBe('S1');
  });

  it('updates by UUID: one read for the project, then a PATCH that never carries state', async () => {
    const { ctx, calls } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      return { statusCode: 200, json: { ...iterationRow(), goal: 'Ship it' } };
    });

    const { isError } = await call(registerSaveIteration, ctx, {
      iteration: ITERATION,
      goal: 'Ship it',
      plannedVelocity: 25,
    });
    expect(isError).toBeFalsy();
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe(`/v1/iterations/${ITERATION}`);
    expect(patch.body).toEqual({ goal: 'Ship it', plannedVelocity: 25 });
    expect(patch.body).not.toHaveProperty('state');
  });

  it('updates by NAME through the project reference feed', async () => {
    const { ctx, calls } = context((call) => {
      const hit = feeds(call);
      if (hit) return hit;
      return { statusCode: 200, json: iterationRow() };
    });

    const { isError } = await call(registerSaveIteration, ctx, {
      iteration: 'Sprint 1',
      project: 'NXP',
      endDate: '2026-12-05',
    });
    expect(isError).toBeFalsy();
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe(`/v1/iterations/${ITERATION}`);
    expect(patch.body).toEqual({ endDate: '2026-12-05' });
  });

  it('refuses a start/end date that is not a real calendar date', () => {
    const shape = inputShape(registerSaveIteration);
    expect(shape['startDate'].safeParse('2026-02-30').success).toBe(false);
    expect(shape['endDate'].safeParse('2026-11-31').success).toBe(false);
    expect(shape['startDate'].safeParse('2026-11-17').success).toBe(true);
  });

  it('a name without a project is refused before any write', async () => {
    const { ctx, calls } = context(() => ({ statusCode: 500, json: {} }));
    const { isError, body } = await call(registerSaveIteration, ctx, {
      iteration: 'Sprint 1',
      goal: 'Ship',
    });
    expect(isError).toBe(true);
    expect(body['error']).toMatch(/project/);
    expect(calls).toHaveLength(0);
  });
});

/** A context whose feeds are empty and every other call answers from `route`. */
function callThrough(route: (call: McpRestCall) => McpRestResult) {
  return context((call) => feeds(call) ?? route(call));
}
