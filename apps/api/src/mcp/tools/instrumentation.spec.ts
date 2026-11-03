import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { instrumentToolHandler, type ToolCallObservation, type ToolContext } from './rest';
import { registerTools } from './register';

const PRINCIPAL = '0194a000-0000-7000-8000-0000000000aa';

/** The SDK types the handler as a union (plain callback or task handler); the catalogue is plain. */
function callTool(tool: { tool: { handler: unknown } }): Promise<Record<string, unknown>> {
  return (tool.tool.handler as (args: unknown, extra: unknown) => Promise<Record<string, unknown>>)(
    {},
    {},
  );
}

function context(): ToolContext {
  return {
    principal: { userId: PRINCIPAL, workspaceId: 'ws', sessionId: 'mcp:test' },
    callRest: async () => ({ statusCode: 200, json: {} }),
  };
}

describe('instrumentToolHandler', () => {
  it('reports an ok call with the tool, the principal and a duration', async () => {
    const observe = vi.fn<(event: ToolCallObservation) => void>();
    const handler = instrumentToolHandler('rova_whoami', PRINCIPAL, async () => ({}), observe);

    await handler();

    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0][0]).toMatchObject({
      tool: 'rova_whoami',
      principalId: PRINCIPAL,
      outcome: 'ok',
    });
    expect(observe.mock.calls[0][0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports an isError result as an error outcome', async () => {
    const observe = vi.fn<(event: ToolCallObservation) => void>();
    const handler = instrumentToolHandler(
      'rova_get_work_item',
      PRINCIPAL,
      async () => ({ isError: true }),
      observe,
    );

    await handler();

    expect(observe.mock.calls[0][0].outcome).toBe('error');
  });

  it('reports a throw as an error outcome and rethrows', async () => {
    const observe = vi.fn<(event: ToolCallObservation) => void>();
    const handler = instrumentToolHandler(
      'rova_list_teams',
      PRINCIPAL,
      async () => {
        throw new Error('boom');
      },
      observe,
    );

    await expect(handler()).rejects.toThrow('boom');
    expect(observe.mock.calls[0][0].outcome).toBe('error');
  });
});

describe('registerTools instrumentation', () => {
  it('wraps every mounted handler, so a dispatch is observed', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const observe = vi.fn<(event: ToolCallObservation) => void>();
    const mounted = registerTools(server, context(), observe);

    const whoami = mounted.find((tool) => tool.name === 'rova_whoami')!;
    await callTool(whoami);

    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0][0]).toMatchObject({
      tool: 'rova_whoami',
      principalId: PRINCIPAL,
      outcome: 'ok',
    });
  });

  it('leaves the handlers untouched when no observer is given', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const mounted = registerTools(server, context());
    const whoami = mounted.find((tool) => tool.name === 'rova_whoami')!;

    await expect(callTool(whoami)).resolves.toHaveProperty('content');
  });

  it('emits exactly one observation for a real tools/call round trip', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const observe = vi.fn<(event: ToolCallObservation) => void>();
    registerTools(server, context(), observe);
    const client = new Client({ name: 'test-client', version: '0.0.0' });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: 'rova_whoami', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(observe).toHaveBeenCalledTimes(1);
      expect(observe.mock.calls[0][0]).toMatchObject({
        tool: 'rova_whoami',
        principalId: PRINCIPAL,
        outcome: 'ok',
      });

      // The SDK rejects malformed arguments BEFORE the wrapped handler, so a refused call adds
      // no second observation: that is the documented "not counted" case.
      const refused = await client.callTool({
        name: 'rova_get_work_item',
        arguments: { workItemId: 'not-a-uuid' },
      });
      expect(refused.isError).toBe(true);
      expect(observe).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
