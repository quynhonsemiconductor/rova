import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRestCall, McpRestResult, ToolContext } from './rest';
import { instrumentToolHandler, type ToolCallObservation } from './rest';
import { registerLogTime } from './log_time';
import { registerAddComment } from './add_comment';
import { registerMarkNotificationsRead } from './mark_notifications_read';

const U = (n: number) => `0194a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

function context(route: (call: McpRestCall) => McpRestResult) {
  const calls: McpRestCall[] = [];
  const idempotencyKey = vi.fn((_tool: string, _args: unknown) => 'k-test');
  const ctx: ToolContext = {
    principal: { userId: U(1), workspaceId: U(2), sessionId: 'mcp:writes' },
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
  const result = await tool.handler(args, {});
  return {
    isError: result.isError,
    body: JSON.parse(result.content[0].text) as Record<string, unknown>,
  };
}

const WORK_ITEM = { id: U(20), itemKey: 'US-412', title: 'Story' };
const resolved = (call: McpRestCall): McpRestResult | null => {
  if (call.url === '/v1/work-items/by-key')
    return { statusCode: 200, json: WORK_ITEM, headers: { ETag: '"3"' } };
  return null;
};

describe('PR2 write tools', () => {
  it('rova_log_time posts the log with the generated idempotency key and relays the row', async () => {
    const { ctx, calls, idempotencyKey } = context((call) => {
      const hit = resolved(call);
      if (hit) return hit;
      if (call.url === `/v1/work-items/${U(20)}/time-logs`) {
        return {
          statusCode: 201,
          json: {
            id: U(60),
            workItemId: U(20),
            userId: U(1),
            hours: '2.00',
            loggedDate: '2026-06-20',
            description: 'api',
            createdAt: '2026-06-20T10:00:00.000Z',
          },
        };
      }
      return { statusCode: 404, json: { error: 'x' } };
    });

    const { body } = await call(registerLogTime, ctx, {
      key: 'US-412',
      hours: 2,
      date: '2026-06-20',
      description: 'api',
    });

    expect(idempotencyKey).toHaveBeenCalledWith(
      'rova_log_time',
      expect.objectContaining({ hours: 2 }),
    );
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({ loggedDate: '2026-06-20', hours: 2, description: 'api' });
    expect(post.idempotencyKey).toBe('k-test');
    expect(body).toMatchObject({
      timeLog: { id: U(60) },
      changed: ['hours', 'loggedDate', 'description'],
    });
  });

  it('a non-member refusal is relayed exactly as REST returned it', async () => {
    const restBody = {
      error: { code: 'PROJECT_PERMISSION_DENIED', message: 'Forbidden resource' },
    };
    const { ctx } = context((call) => {
      const hit = resolved(call);
      if (hit) return { statusCode: 403, json: restBody };
      return { statusCode: 500, json: {} };
    });
    const { isError, body } = await call(registerLogTime, ctx, {
      key: 'US-412',
      hours: 1,
      date: '2026-06-20',
    });
    expect(isError).toBe(true);
    expect(body).toEqual({ statusCode: 403, error: restBody });
  });

  it('rova_add_comment on a work item resolves mentions and posts body + mentionedUserIds', async () => {
    const { ctx, calls } = context((call) => {
      const hit = resolved(call);
      if (hit) return hit;
      if (call.url.endsWith('/member-options')) {
        return {
          statusCode: 200,
          json: [
            {
              userId: U(70),
              displayName: 'Linh',
              email: 'linh@qnsc.vn',
              avatarUrl: null,
              assignable: true,
            },
          ],
        };
      }
      if (call.url === `/v1/work-items/${U(20)}/comments`) {
        return {
          statusCode: 201,
          json: {
            id: U(80),
            authorId: U(1),
            parentId: null,
            body: 'PR up, @Linh',
            isEdited: false,
            editedAt: null,
            createdAt: '2026-06-20T10:00:00.000Z',
          },
        };
      }
      return { statusCode: 404, json: { error: 'x' } };
    });

    const { body } = await call(registerAddComment, ctx, {
      workItemKey: 'US-412',
      body: 'PR up, @Linh',
      mention: ['linh@qnsc.vn'],
    });
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe(`/v1/work-items/${U(20)}/comments`);
    expect(post.body).toMatchObject({ body: 'PR up, @Linh', mentionedUserIds: [U(70)] });
    expect(body).toMatchObject({ comment: { id: U(80) }, changed: ['body'] });
  });

  it('rova_add_comment refuses an ambiguous mention instead of naming the wrong person', async () => {
    const { ctx } = context((call) => {
      if (call.url.endsWith('/member-options')) {
        return {
          statusCode: 200,
          json: [
            {
              userId: U(71),
              displayName: 'Linh',
              email: 'linh.a@qnsc.vn',
              avatarUrl: null,
              assignable: true,
            },
            {
              userId: U(72),
              displayName: 'Linh',
              email: 'linh.b@qnsc.vn',
              avatarUrl: null,
              assignable: true,
            },
          ],
        };
      }
      const hit = resolved(call);
      return hit ?? { statusCode: 404, json: {} };
    });
    const { isError, body } = await call(registerAddComment, ctx, {
      workItemKey: 'US-412',
      body: 'hi',
      mention: ['Linh'],
    });
    expect(isError).toBe(true);
    expect(JSON.stringify(body)).toContain('linh.a@qnsc.vn');
    expect(JSON.stringify(body)).toContain('linh.b@qnsc.vn');
  });

  it('rova_mark_notifications_read marks one or all, idempotently, with an idempotency key', async () => {
    const { ctx, calls } = context(() => ({ statusCode: 204, json: undefined }));
    const one = await call(registerMarkNotificationsRead, ctx, { notificationId: U(90) });
    expect(calls[0]).toMatchObject({
      url: `/v1/notifications/${U(90)}/read`,
      idempotencyKey: 'k-test',
    });
    expect(one.body).toMatchObject({ marked: true, notificationId: U(90) });

    const all = await call(registerMarkNotificationsRead, ctx, { all: true });
    expect(calls[1]).toMatchObject({ url: '/v1/notifications/read-all' });
    expect(all.body).toMatchObject({ marked: true, all: true });
  });

  it('the audit observation carries FIELD NAMES only — never the comment body or description', async () => {
    const observe = vi.fn<(event: ToolCallObservation) => void>();
    const body = 'customer-secret-sentinel-text';
    const wrapped = instrumentToolHandler(
      'rova_add_comment',
      U(1),
      async (_args: unknown) => ({ content: [] }),
      observe,
    );
    await wrapped({ workItemKey: 'US-412', body });

    const logged = JSON.stringify(observe.mock.calls[0][0]);
    expect(logged).not.toContain(body);
    expect(Object.keys(observe.mock.calls[0][0] as object).sort()).toEqual([
      'durationMs',
      'outcome',
      'principalId',
      'tool',
    ]);
  });
});
