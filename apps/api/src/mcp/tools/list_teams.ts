import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { denied, type ToolContext } from './rest';
import { createRefResolver, type PersonRef } from './refs';

/** The workspace team list is an unpaginated reference feed; the tool caps it. */
export const MAX_TEAMS = 100;

/** The team row an agent needs, from toTeamWithStatsDto (the route's own mapper). */
export function shapeTeam(t: Record<string, unknown>, lead: PersonRef | null = null) {
  return {
    id: t['id'],
    name: t['name'],
    key: t['key'] ?? null,
    description: t['description'] ?? null,
    status: t['status'],
    lead,
    memberCount: t['memberCount'],
    projects: t['projects'],
  };
}

/** The whole feed, capped and mapped; `truncated` when the cap bit. */
export async function shapeTeams(
  all: Record<string, unknown>[],
  resolver: ReturnType<typeof createRefResolver>,
) {
  const payload: Record<string, unknown> = {
    teams: await Promise.all(
      all.slice(0, MAX_TEAMS).map(async (t) => shapeTeam(t, await resolver.person(t['leadId']))),
    ),
  };
  if (all.length > MAX_TEAMS) payload['truncated'] = true;
  return payload;
}

/**
 * `rova_list_teams` — the teams of the bound workspace linked to at least one project the person
 * can read (GET /v1/workspaces/:workspaceId/teams with the PRINCIPAL's workspace — the route
 * 404s on any other id, so the tool takes no workspace argument; AuthorizedInService scopes
 * the list itself). The route answers a bare array; the tool caps to 100 with `truncated`.
 */
export function registerListTeams(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_list_teams',
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
      const payload = await shapeTeams(json as Record<string, unknown>[], createRefResolver(ctx));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
      };
    },
  );
}
