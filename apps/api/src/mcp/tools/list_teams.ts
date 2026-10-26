import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { denied, type ToolContext } from './rest';

/** The workspace team list is an unpaginated reference feed; the tool caps it. */
export const MAX_TEAMS = 100;

/** The whole feed, capped and mapped; `truncated` when the cap bit. */
export function shapeTeams(all: Record<string, unknown>[]) {
  const payload: Record<string, unknown> = { teams: all.slice(0, MAX_TEAMS).map(shapeTeam) };
  if (all.length > MAX_TEAMS) payload['truncated'] = true;
  return payload;
}

/** The team row an agent needs, from toTeamWithStatsDto (the route's own mapper). */
export function shapeTeam(t: Record<string, unknown>) {
  return {
    id: t['id'],
    name: t['name'],
    key: t['key'] ?? null,
    description: t['description'] ?? null,
    status: t['status'],
    leadId: t['leadId'] ?? null,
    memberCount: t['memberCount'],
    projects: t['projects'],
  };
}

/**
 * `list_teams` — the teams of the bound workspace linked to at least one project the person
 * can read (GET /v1/workspaces/:workspaceId/teams with the PRINCIPAL's workspace — the route
 * 404s on any other id, so the tool takes no workspace argument; AuthorizedInService scopes
 * the list itself). The route answers a bare array; the tool caps to 100 with `truncated`.
 */
export function registerListTeams(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'list_teams',
    {
      title: 'List teams',
      description:
        'The teams of your workspace, exactly the teams linked to a project you can read in the web app.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {},
    },
    async () => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: `/v1/workspaces/${ctx.principal.workspaceId}/teams`,
      });
      if (statusCode >= 400 || !Array.isArray(json)) return denied(statusCode, json);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(shapeTeams(json as Record<string, unknown>[])),
          },
        ],
      };
    },
  );
}
