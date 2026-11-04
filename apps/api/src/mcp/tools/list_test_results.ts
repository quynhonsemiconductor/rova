import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, result, toolError, type ToolContext } from './rest';
import { resolveTestCase } from './lookups';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/** The tool payload; pure so a spec can feed rows parsed through TestResultResponseSchema. */
export function shapeTestResults(
  testCase: { id: string; testCaseKey: string; name: string },
  all: Record<string, unknown>[],
  limit: number,
): Record<string, unknown> {
  const capped = all.slice(0, limit);
  const payload: Record<string, unknown> = {
    testCase,
    results: capped.map((r) => ({
      id: r['id'],
      testResultKey: r['testResultKey'],
      build: r['build'],
      runDate: r['runDate'],
      verdict: r['verdict'],
      durationMinutes: r['durationMinutes'],
      testerName: r['testerName'] ?? null,
      notes: r['notes'] ?? null,
      workItemKey: r['workItemKey'] ?? null,
      createdAt: r['createdAt'],
    })),
  };
  if (all.length > capped.length) payload['truncated'] = true;
  return payload;
}

/**
 * `rova_list_test_results` — the recorded runs of one test case (verdict, build, tester, date),
 * newest first as the API returns them (BR14). The route is unpaginated, so the tool caps the
 * feed itself and flags `truncated`.
 */
export function registerListTestResults(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_list_test_results',
    {
      title: 'List test results',
      description:
        'The recorded results of one test case you can read (verdict, build, tester, date), newest first. Capped at 50.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        testCaseKey: z.string().min(1).max(64).describe('The test case key, e.g. TC-12'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .describe(`How many results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`),
      },
    },
    async ({ testCaseKey, limit }) => {
      const testCase = await resolveTestCase(ctx, testCaseKey);
      if (!testCase.ok) return toolError(testCase.message);

      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: `/v1/test-cases/${testCase.id}/test-results`,
      });
      if (statusCode >= 400 || !Array.isArray(json)) return denied(statusCode, json);

      const payload = shapeTestResults(
        { id: testCase.id, testCaseKey: testCase.testCaseKey, name: testCase.name },
        json as Record<string, unknown>[],
        limit ?? DEFAULT_LIMIT,
      );
      return result(200, {}, payload);
    },
  );
}
