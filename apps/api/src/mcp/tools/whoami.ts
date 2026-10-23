import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { result, type ToolContext } from './rest';

/**
 * `whoami` — the person, their role and workspace memberships (GET /v1/auth/me, self-scoped).
 * Small: no permissions array, no timestamps.
 */
export function registerWhoami(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description:
        'The signed-in person as rova sees them: identity, role, and the workspaces they belong to.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {},
    },
    async () => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/auth/me',
      });
      const p = json as Record<string, unknown>;
      const memberships = ((p['memberships'] as Record<string, unknown>[]) ?? []).map((m) => ({
        workspaceId: m['workspaceId'],
        name: m['name'],
        role: m['roleSlug'],
      }));
      return result(statusCode, json, {
        id: p['id'],
        email: p['email'],
        displayName: p['displayName'],
        role: p['role'],
        memberships,
      });
    },
  );
}
