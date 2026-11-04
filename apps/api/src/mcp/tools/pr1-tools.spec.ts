import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WorkItemResponseSchema } from '@modules/work-items/interface/http/dto/work-item-response.dto';
import type { McpRestCall, McpRestResult, ToolContext } from './rest';
import { registerProjectActivity } from './project_activity';
import { registerWorkItemDetails } from './work_item_details';
import { registerListComments } from './list_comments';
import { registerListTestResults } from './list_test_results';

const U = (n: number) => `0194a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

function context(route: (call: McpRestCall) => McpRestResult): ToolContext {
  return {
    principal: { userId: U(1), workspaceId: U(2), sessionId: 'mcp:tools' },
    callRest: async (_p, call) => route(call),
  };
}

/** Mounts one tool on a throwaway server and calls it like the transport would. */
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
  const result = await tool.handler(args, {});
  return {
    isError: result.isError,
    body: JSON.parse(result.content[0].text) as Record<string, unknown>,
  };
}

const WORK_ITEM = {
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
};

describe('PR1 tool handlers through the fake bridge', () => {
  it('work_item_details relays the sections with per-section truncation and version', async () => {
    const task = WorkItemResponseSchema.parse({
      ...WORK_ITEM,
      id: U(21),
      itemKey: 'TA-1',
      type: 'task',
    });
    const tasks = Array.from({ length: 101 }, () => task);
    const ctx = context((call) => {
      if (call.url === '/v1/work-items/by-key') {
        return { statusCode: 200, json: WORK_ITEM, headers: { ETag: '"3"' } };
      }
      if (call.url.endsWith('/tasks')) return { statusCode: 200, json: tasks };
      if (call.url.endsWith('/relations')) {
        return { statusCode: 403, json: { error: { code: 'FORBIDDEN' } } };
      }
      if (call.url.endsWith('/time-logs')) {
        return { statusCode: 200, json: { items: [WORK_ITEM], total: 5 } };
      }
      if (call.url.endsWith('/labels')) return { statusCode: 200, json: [] };
      if (call.url.endsWith('/watchers')) return { statusCode: 200, json: [] };
      if (call.url.endsWith('/attachments')) return { statusCode: 200, json: [] };
      if (call.url.endsWith('/test-cases'))
        return { statusCode: 200, json: { data: [], pageInfo: {} } };
      return { statusCode: 404, json: { error: 'not found' } };
    });

    const { body } = await call(registerWorkItemDetails, ctx, {
      key: 'US-412',
      include: ['tasks', 'relations', 'timeLogs', 'labels', 'watchers', 'attachments', 'testCases'],
    });

    expect(body['workItem']).toMatchObject({ id: U(20), version: 3 });
    expect(body['tasks']).toMatchObject({ truncated: true });
    expect((body['tasks'] as { items: unknown[] }).items).toHaveLength(100);
    expect(body['relations']).toBeNull();
    expect(body['unavailable']).toEqual(['relations']);
    expect(body['timeLogs']).toMatchObject({ total: 5, truncated: true });
  });

  it('project_activity follows pages until a row older than since, then stops (hasMore false)', async () => {
    const row = (n: number, createdAt: string) => ({
      id: U(30 + n),
      createdAt,
      action: 'work_item.updated',
      entityType: 'work_item',
      entityId: U(40),
      actorName: 'Ada',
      changes: null,
    });
    const ctx = context((call) => {
      if (call.url === '/v1/projects') {
        return {
          statusCode: 200,
          json: {
            data: [{ id: U(10), key: 'OBSE', name: 'Observability' }],
            pageInfo: { hasNextPage: false },
          },
        };
      }
      const page = Number(call.query?.['page'] ?? 1);
      if (page === 1) {
        return {
          statusCode: 200,
          json: {
            data: [row(1, '2026-06-20T10:00:00.000Z'), row(2, '2026-06-18T10:00:00.000Z')],
            total: 150,
          },
        };
      }
      throw new Error('must not scan page 2: page 1 already reached a row older than since');
    });

    const { body } = await call(registerProjectActivity, ctx, {
      project: 'OBSE',
      since: '2026-06-19T00:00:00.000Z',
    });
    expect((body['activity'] as unknown[]).length).toBe(1);
    expect(body['hasMore']).toBe(false);
    expect(body['truncated']).toBeUndefined();
    expect(body['scannedPages']).toBe(1);
  });

  it('project_activity reports truncated when the 5-page cap stops the scan', async () => {
    const row = (n: number) => ({
      id: U(30 + n),
      createdAt: '2026-06-20T10:00:00.000Z',
      action: 'a',
      entityType: 'work_item',
      entityId: U(40),
      actorName: null,
      changes: null,
    });
    const ctx = context((call) => {
      if (call.url === '/v1/projects') {
        return {
          statusCode: 200,
          json: { data: [{ id: U(10), key: 'OBSE', name: 'Observability' }], pageInfo: {} },
        };
      }
      const page = Number(call.query?.['page'] ?? 1);
      return { statusCode: 200, json: { data: [row(page)], total: 1000 } };
    });
    const { body } = await call(registerProjectActivity, ctx, {
      project: 'OBSE',
      since: '2026-06-19T00:00:00.000Z',
    });
    expect(body['scannedPages']).toBe(5);
    expect(body['truncated']).toBe(true);
    expect(body['hasMore']).toBe(true);
  });

  it('list_comments on a portfolio item resolves the key and attaches authors', async () => {
    const ctx = context((call) => {
      if (call.url === '/v1/portfolio-items') {
        return {
          statusCode: 200,
          json: { data: [{ id: U(50), itemKey: 'F-12', name: 'Wafer map' }], pageInfo: {} },
        };
      }
      if (call.url === `/v1/portfolio-items/${U(50)}/comments`) {
        return {
          statusCode: 200,
          json: [
            {
              id: U(51),
              authorId: U(1),
              parentId: null,
              body: 'hi',
              isEdited: false,
              editedAt: null,
              createdAt: '2026-06-20T10:00:00.000Z',
            },
          ],
        };
      }
      if (call.url.endsWith('/member-options')) {
        return {
          statusCode: 200,
          json: [
            { userId: U(1), displayName: 'Ada', email: 'a@x', avatarUrl: null, assignable: true },
          ],
        };
      }
      return { statusCode: 404, json: { error: 'not found' } };
    });
    const { body } = await call(registerListComments, ctx, { portfolioItemKey: 'F-12' });
    expect(body['comments']).toMatchObject([{ body: 'hi', author: { id: U(1), name: 'Ada' } }]);
  });

  it('a REST denial reaches the tool caller unchanged (403 body, isError)', async () => {
    const deniedBody = { error: { code: 'FORBIDDEN', message: 'Forbidden resource' } };
    const ctx = context(() => ({ statusCode: 403, json: deniedBody }));
    const { isError, body } = await call(registerListTestResults, ctx, { testCaseKey: 'TC-12' });
    expect(isError).toBe(true);
    expect(body).toEqual({ statusCode: 403, error: deniedBody });
  });
});
