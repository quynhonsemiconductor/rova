import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listResult, pageArgs, type ToolContext } from './rest';

/**
 * `rova_list_test_cases` — a Work Item's Test Cases, in rank order
 * (GET /v1/work-items/:id/test-cases, `test_case:view` via the parent work item).
 */
export function registerListTestCases(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_list_test_cases',
    {
      title: 'List test cases',
      description:
        'The Test Cases attached to one work item you can read, in rank order. Paginated.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        workItemId: z.uuid().describe('The work item whose test cases to list'),
        ...pageArgs,
      },
    },
    async ({ workItemId, limit, cursor }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: `/v1/work-items/${workItemId}/test-cases`,
        query: { limit: limit ?? 20, cursor },
      });
      return listResult(
        statusCode,
        json,
        (tc) => ({
          id: tc['id'],
          testCaseKey: tc['testCaseKey'],
          name: tc['name'],
          method: tc['method'],
          priority: tc['priority'],
          lastVerdict: tc['lastVerdict'] ?? null,
          assigneeName: tc['assigneeName'] ?? null,
        }),
        'testCases',
      );
    },
  );
}
