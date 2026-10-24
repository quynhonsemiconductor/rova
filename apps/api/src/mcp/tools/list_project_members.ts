import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listResult, type ToolContext } from './rest';

/**
 * `list_project_members` — the people who can own work in one project the person can read
 * (GET /v1/projects/:id/member-options, `project:view` on the project). This is the
 * audience-matched feed the web UI gives non-admins (the assignee projection: id, name,
 * email) — NOT the administrative roster route, which is Workspace/Project-Admin only.
 */
export function registerListProjectMembers(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'list_project_members',
    {
      title: 'List project members',
      description: 'The people who can own work in one project you can read, with their email.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        projectId: z.uuid().describe('The project whose member options to list'),
      },
    },
    async ({ projectId }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: `/v1/projects/${projectId}/member-options`,
      });
      return listResult(
        statusCode,
        json,
        (m) => ({
          userId: m['userId'],
          displayName: m['displayName'] ?? null,
          email: m['email'] ?? null,
        }),
        'members',
      );
    },
  );
}
