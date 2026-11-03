import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listResultExpanded, type ToolContext } from './rest';
import { createRefResolver } from './refs';
import { resolveToolWorkItemRefs, toToolWorkItem } from './search_work_items';

/**
 * `rova_my_work` — work items assigned to the caller within their readable projects
 * (GET /v1/work-items/my, self-scoped; the same Top-N the Home widget shows).
 */
export function registerMyWork(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_my_work',
    {
      title: 'My work',
      description: 'The work items assigned to you, in the projects you can read.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('How many items (default 10, max 50 — the REST route caps it)'),
      },
    },
    async ({ limit }) => {
      const resolver = createRefResolver(ctx);
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/work-items/my',
        query: { ...(limit ? { limit } : {}) },
      });
      return listResultExpanded(
        statusCode,
        json,
        async (p) => toToolWorkItem(p, await resolveToolWorkItemRefs(p, resolver)),
        'items',
      );
    },
  );
}
