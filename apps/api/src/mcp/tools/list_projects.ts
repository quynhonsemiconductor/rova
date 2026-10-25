import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listResult, pageArgs, type ToolContext } from './rest';

/** The small project shape every project tool returns. */
export function toToolProject(p: Record<string, unknown>) {
  return {
    id: p['id'],
    key: p['key'],
    name: p['name'],
    status: p['status'],
    leadName: p['leadName'] ?? null,
  };
}

/**
 * `list_projects` — the projects of the bound workspace this person can read
 * (GET /v1/projects, scoped by AccessService.listReadableProjectIds).
 */
export function registerListProjects(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description:
        'List the projects of your workspace, exactly the projects you can read in the web app. Paginated.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: { ...pageArgs },
    },
    async ({ limit, cursor }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/projects',
        query: { limit: limit ?? 20, cursor },
      });
      return listResult(statusCode, json, toToolProject, 'projects');
    },
  );
}
