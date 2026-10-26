import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, result, type ToolContext } from './rest';

/**
 * `get_project` — one project by id, if the person can read it
 * (GET /v1/projects/:id, `project:view` on the project).
 */
export function registerGetProject(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_get_project',
    {
      title: 'Get project',
      description: 'One project by id, exactly what its detail page shows you.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        projectId: z.uuid().describe('The project id'),
      },
    },
    async ({ projectId }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: `/v1/projects/${projectId}`,
      });
      if (statusCode >= 400 || json === null || typeof json !== 'object' || Array.isArray(json))
        return denied(statusCode, json);
      const p = json as Record<string, unknown>;
      return result(statusCode, json, {
        id: p['id'],
        key: p['key'],
        name: p['name'],
        status: p['status'],
        leadName: p['leadName'] ?? null,
        startDate: p['startDate'] ?? null,
        endDate: p['endDate'] ?? null,
      });
    },
  );
}
