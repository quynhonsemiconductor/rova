import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpPrincipalContext } from '../mcp-principal';

/**
 * The rova MCP tools. READ-ONLY first; every tool is task-shaped over the app's OWN REST routes,
 * called IN-PROCESS (`app.inject()`) with the person as principal — never a service, repository
 * or DB client directly, because the HTTP layer is the authorization point (`PolicyGuard`).
 *
 * Rules the ratchet (tools.ratchet.spec.ts) enforces on this directory:
 *  - no import of a controller, route handler, service, repository or DB client;
 *  - no `headers` on an inject() call — a tool never copies a network header into the in-process
 *    call (the principal comes from the MCP context, not the request);
 *  - no reference to `Cf-Access-Jwt-Assertion`, `x-` headers or the raw request object.
 *
 * Responses stay small (the plan's agent-traffic rule): needed fields only, names over ids, and
 * `limit` + `cursor` on every list tool (the REST route's own page args are reused, so a denied
 * or paginated call behaves exactly as the same person's REST call would).
 */

/** One in-process REST call a tool composes. No headers, ever — see the ratchet above. */
export interface McpRestCall {
  method: 'GET';
  url: string;
  query?: Record<string, string | number | undefined>;
}

export interface McpRestResult {
  statusCode: number;
  json: unknown;
}

/** Runs one call through `app.inject()` with the tool call's principal (built in mcp.route.ts). */
export type McpRestCaller = (
  principal: McpPrincipalContext,
  call: McpRestCall,
) => Promise<McpRestResult>;

/** Tools cap the page below the REST max: an agent re-asks with a cursor rather than reading 100 rows. */
export const MCP_TOOL_PAGE_LIMIT = 20;

/** Shape of `ProjectResponseDto` we keep — fields an agent needs, not the full REST DTO. */
interface ToolProject {
  id: string;
  key: string;
  name: string;
  status: string;
  leadName: string | null;
}

function toToolProject(p: Record<string, unknown>): ToolProject {
  return {
    id: String(p['id']),
    key: String(p['key']),
    name: String(p['name']),
    status: String(p['status']),
    leadName: (p['leadName'] as string | null) ?? null,
  };
}

/**
 * Passes a REST denial through unchanged: the same status code and the same error body the
 * person's session path would have received — a denied action is denied IDENTICALLY over MCP.
 */
function denied(statusCode: number, json: unknown) {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: JSON.stringify({ statusCode, error: json }) }],
  };
}

export function registerRovaTools(
  server: McpServer,
  opts: { userId: string; sessionId: string; callRest: McpRestCaller },
): void {
  const { userId, sessionId, callRest } = opts;
  const call = (workspaceId: string, rest: McpRestCall) =>
    callRest({ userId, sessionId, workspaceId }, rest);

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description:
        'List the projects of one workspace, exactly the projects this person can read in the web app. Paginated.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        workspaceId: z.uuid().describe('The workspace to list projects from'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MCP_TOOL_PAGE_LIMIT)
          .optional()
          .describe(`Page size (default ${MCP_TOOL_PAGE_LIMIT})`),
        cursor: z.string().optional().describe('Opaque cursor from the previous page'),
      },
    },
    async ({ workspaceId, limit, cursor }) => {
      const { statusCode, json } = await call(workspaceId, {
        method: 'GET',
        url: '/v1/projects',
        query: { limit: limit ?? MCP_TOOL_PAGE_LIMIT, cursor },
      });
      if (statusCode >= 400) return denied(statusCode, json);
      const page = json as { data?: Record<string, unknown>[]; pageInfo?: unknown };
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              projects: (page.data ?? []).map(toToolProject),
              ...(page.pageInfo !== undefined ? { pageInfo: page.pageInfo } : {}),
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'get_project',
    {
      title: 'Get project',
      description: 'One project by id, if this person can read it in the web app.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        workspaceId: z.uuid().describe('The workspace the project belongs to'),
        projectId: z.uuid().describe('The project id'),
      },
    },
    async ({ workspaceId, projectId }) => {
      const { statusCode, json } = await call(workspaceId, {
        method: 'GET',
        url: `/v1/projects/${projectId}`,
      });
      if (statusCode >= 400) return denied(statusCode, json);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(toToolProject(json as Record<string, unknown>)),
          },
        ],
      };
    },
  );
}
