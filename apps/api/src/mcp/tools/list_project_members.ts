import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { result, type ToolContext } from './rest';

/**
 * `list_project_members` — the roster of one project the person can read
 * (GET /v1/projects/:id/members, `project:view` on the project). People fields only:
 * no emails or avatars.
 */
export function registerListProjectMembers(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'list_project_members',
    {
      title: 'List project members',
      description: 'The people on one project you can read, with their access level.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        projectId: z.uuid().describe('The project whose members to list'),
      },
    },
    async ({ projectId }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: `/v1/projects/${projectId}/members`,
      });
      const members = (json as Record<string, unknown>[]) ?? [];
      return result(statusCode, json, {
        members: members.map((m) => ({
          userId: m['userId'],
          displayName: m['displayName'] ?? null,
          accessLevel: m['accessLevel'],
          status: m['status'],
          isWorkspaceAdmin: m['isWorkspaceAdmin'] ?? false,
        })),
      });
    },
  );
}
