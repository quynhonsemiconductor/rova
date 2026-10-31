import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, result, type ToolContext } from './rest';

/**
 * `rova_get_test_case_by_key` — one Test Case by its workspace-unique key
 * (GET /v1/test-cases/by-key/:key — resolve-then-check: the service asserts `work_item:view`
 * on the parent work item, so the key alone grants nothing).
 */
export function registerGetTestCaseByKey(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_get_test_case_by_key',
    {
      title: 'Get test case by key',
      description: 'One Test Case by its key (e.g. TC-3), what its detail page shows you.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        testCaseKey: z
          .string()
          .max(64)
          .regex(/^[A-Z]+-\d+$/)
          .describe('The Test Case key, e.g. TC-3'),
      },
    },
    async ({ testCaseKey }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: `/v1/test-cases/by-key/${encodeURIComponent(testCaseKey)}`,
      });
      if (statusCode >= 400 || json === null || typeof json !== 'object' || Array.isArray(json))
        return denied(statusCode, json);
      const tc = json as Record<string, unknown>;
      return result(statusCode, json, {
        id: tc['id'],
        testCaseKey: tc['testCaseKey'],
        name: tc['name'],
        method: tc['method'],
        priority: tc['priority'],
        ownerName: tc['ownerName'] ?? null,
        assigneeName: tc['assigneeName'] ?? null,
        lastVerdict: tc['lastVerdict'] ?? null,
        lastRun: tc['lastRun'] ?? null,
      });
    },
  );
}
