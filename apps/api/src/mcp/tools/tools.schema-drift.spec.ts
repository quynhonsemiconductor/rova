import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { PageQuerySchema } from '@platform';
import { IterationQuerySchema } from '@modules/iterations/interface/http/dto/iteration-request.dto';
import { WorkItemQuerySchema } from '@modules/work-items/interface/http/dto/work-item-request.dto';
import { registerTools } from './register';
import type { ToolContext } from './rest';

/**
 * SCHEMA DRIFT (owner decision on rova#788): the tools' inline zod inputs mirror the REST query
 * schemas, deliberately re-declared because the ratchet bans importing product modules into tool
 * files. This spec lives in .spec.ts and MAY import @modules: it asserts each tool's input keys
 * are a SUBSET of the REST schema's keys, so a filter renamed or removed on a REST route breaks
 * THIS test until the tool follows — the mirror cannot silently rot into a 400 the REST route
 * never asked for. Tools whose routes take no query DTO (whoami, get_work_item, my_work's plain
 * `limit`, list_comments' no-query route) are pinned by hand below.
 */

const fakeCtx: ToolContext = {
  principal: {
    userId: '0194a000-0000-7000-8000-0000000000aa',
    workspaceId: '0194a000-0000-7000-8000-000000000003',
    sessionId: 'mcp:drift',
  },
  callRest: async () => ({ statusCode: 200, json: {} }),
};

/** Mounts the catalogue on a throwaway server and returns name → input keys. */
function toolInputs(): Map<string, string[]> {
  // a real McpServer, so what is checked is exactly what a client receives
  const server = new McpServer({ name: 'drift', version: '0.0.0' });
  const mounted = registerTools(server, fakeCtx);
  return new Map(
    mounted.map(({ name, tool }) => [
      name,
      // the SDK stores registerTool's raw shape wrapped as a zod object: `.shape` holds the fields
      Object.keys(
        (tool.inputSchema as { shape?: Record<string, unknown> } | undefined)?.shape ?? {},
      ),
    ]),
  );
}

describe("MCP tool inputs ⊆ their REST route's query schema", () => {
  it('list_projects ⊆ PageQuerySchema (GET /v1/projects)', () => {
    const rest = Object.keys(PageQuerySchema.shape);
    const tool = toolInputs().get('list_projects')!;
    expect(tool.length).toBeGreaterThan(0);
    expect(tool.filter((key) => !rest.includes(key))).toEqual([]);
  });

  it('search_work_items ⊆ WorkItemQuerySchema (GET /v1/work-items)', () => {
    const rest = Object.keys(WorkItemQuerySchema.shape);
    const tool = toolInputs().get('search_work_items')!;
    expect(tool.length).toBeGreaterThan(0);
    expect(tool.filter((key) => !rest.includes(key))).toEqual([]);
  });

  it('list_iterations ⊆ IterationQuerySchema (GET /v1/iterations)', () => {
    const rest = Object.keys(IterationQuerySchema.shape);
    const tool = toolInputs().get('list_iterations')!;
    expect(tool.length).toBeGreaterThan(0);
    expect(tool.filter((key) => !rest.includes(key))).toEqual([]);
  });

  it('the schema-less routes take only what their controllers read by hand', () => {
    const inputs = toolInputs();
    // GET /v1/work-items/my reads `@Query('limit')` only
    expect(inputs.get('my_work')).toEqual(['limit']);
    // GET /v1/work-items/:workItemId/comments reads NO query (unpaginated REST route)
    expect(inputs.get('list_comments')).toEqual(['workItemId']);
    // no query at all
    expect(inputs.get('whoami')).toEqual([]);
    expect(inputs.get('get_work_item')).toEqual(['workItemId']);
  });
});
