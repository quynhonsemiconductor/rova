import { describe, expect, it } from 'vitest';
import { ProjectResponseSchema } from '@modules/projects/interface/http/dto/project-response.dto';
import { WorkItemResponseSchema } from '@modules/work-items/interface/http/dto/work-item-response.dto';
import type { ToolContext } from './rest';
import { resolvePortfolioItem, resolveProject, resolveTestCase, resolveWorkItem } from './lookups';

const U = (n: number) => `0194a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

function context(routes: Record<string, unknown>) {
  const calls: Array<{ url: string; query?: Record<string, unknown> }> = [];
  const ctx: ToolContext = {
    principal: { userId: U(1), workspaceId: U(2), sessionId: 'mcp:lookup' },
    callRest: async (_p, call) => {
      calls.push({ url: call.url, query: call.query });
      if (!(call.url in routes)) return { statusCode: 404, json: { error: 'not found' } };
      return { statusCode: 200, json: routes[call.url] };
    },
  };
  return { ctx, calls };
}

const PROJECTS = {
  data: [
    ProjectResponseSchema.parse({
      id: U(10),
      workspaceId: U(2),
      key: 'OBSE',
      name: 'Observability',
      description: null,
      leadId: null,
      leadName: null,
      startDate: null,
      endDate: null,
      status: 'active',
      memberCount: 3,
      teamCount: 1,
      settings: {},
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    }),
  ],
};

const ITEM = WorkItemResponseSchema.parse({
  id: U(20),
  workspaceId: U(2),
  projectId: U(10),
  itemKey: 'US-412',
  type: 'story',
  title: 'Story',
  description: null,
  statusId: U(3),
  scheduleState: 'defined',
  flowState: 'defined',
  priority: 'none',
  assigneeId: null,
  assigneeName: null,
  devOwnerName: null,
  reporterId: null,
  parentId: null,
  teamId: null,
  iterationId: null,
  releaseId: null,
  featureId: null,
  storyPoints: null,
  estimateHours: null,
  todoHours: null,
  actualHours: null,
  acceptanceCriteria: null,
  notes: null,
  releaseNotes: null,
  isBlocked: false,
  blockedReason: null,
  rank: '',
  customFields: {},
  createdBy: U(1),
  updatedBy: null,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  severity: null,
  foundInEnvironment: null,
  foundInReleaseId: null,
  rootCause: null,
  resolution: null,
  devOwnerId: null,
  defectState: null,
  fixedInBuild: null,
  startDate: null,
  actualEndDate: null,
  targetEndDate: null,
});

describe('reference resolution (never guess)', () => {
  it('resolves a project by key, name or id, case-insensitively', async () => {
    const { ctx } = context({ '/v1/projects': PROJECTS });
    await expect(resolveProject(ctx, 'obse')).resolves.toMatchObject({ ok: true, id: U(10) });
    await expect(resolveProject(ctx, 'Observability')).resolves.toMatchObject({
      ok: true,
      id: U(10),
    });
    await expect(resolveProject(ctx, U(10))).resolves.toMatchObject({ ok: true });
  });

  it('returns candidates instead of guessing an unknown project', async () => {
    const { ctx } = context({ '/v1/projects': PROJECTS });
    const out = await resolveProject(ctx, 'nope');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain('OBSE (Observability)');
  });

  it('resolves a work item by UUID and by key, and exposes its version', async () => {
    const { ctx, calls } = context({
      [`/v1/work-items/${U(20)}`]: ITEM,
      '/v1/work-items/by-key': ITEM,
    });
    await expect(resolveWorkItem(ctx, U(20))).resolves.toMatchObject({ ok: true, id: U(20) });
    await expect(resolveWorkItem(ctx, 'US-412')).resolves.toMatchObject({
      ok: true,
      itemKey: 'US-412',
    });
    expect(calls.map((c) => c.url)).toContain('/v1/work-items/by-key');
  });

  it('resolves a portfolio item by key through the list search, trying the prefix type first', async () => {
    const { ctx, calls } = context({
      '/v1/portfolio-items': { data: [{ id: U(30), itemKey: 'F-12', name: 'Wafer map' }] },
    });
    await expect(resolvePortfolioItem(ctx, 'F-12')).resolves.toMatchObject({
      ok: true,
      id: U(30),
      name: 'Wafer map',
    });
    expect(calls[0]?.query?.['type']).toBe('feature');
  });

  it('resolves a test case by key through the by-key route', async () => {
    const { ctx, calls } = context({
      [`/v1/test-cases/by-key/${encodeURIComponent('TC-12')}`]: {
        id: U(40),
        testCaseKey: 'TC-12',
        name: 'Login',
      },
    });
    await expect(resolveTestCase(ctx, 'TC-12')).resolves.toMatchObject({ ok: true, id: U(40) });
    expect(calls[0]?.url).toBe('/v1/test-cases/by-key/TC-12');
  });
});
