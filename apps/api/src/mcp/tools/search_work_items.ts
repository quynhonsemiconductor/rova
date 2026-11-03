import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listResultExpanded, pageArgs, type ToolContext } from './rest';
import { createRefResolver, personRef, type PersonRef, type Ref } from './refs';

/** The identity a list row adds once its ids are resolved (refs.ts). */
export interface ToolWorkItemRefs {
  assignee?: PersonRef | null;
  iteration?: Ref | null;
}

/** The small work-item shape the search/get tools return. */
export function toToolWorkItem(p: Record<string, unknown>, refs: ToolWorkItemRefs = {}) {
  return {
    id: p['id'],
    itemKey: p['itemKey'],
    title: p['title'],
    type: p['type'],
    scheduleState: p['scheduleState'],
    priority: p['priority'],
    assignee: refs.assignee ?? null,
    iteration: refs.iteration ?? null,
  };
}

/** Resolves one row's refs. The DTO's joined `assigneeName` wins over the picker feed. */
export async function resolveToolWorkItemRefs(
  p: Record<string, unknown>,
  resolver: ReturnType<typeof createRefResolver>,
): Promise<ToolWorkItemRefs> {
  const [person, iteration] = await Promise.all([
    resolver.person(p['assigneeId']),
    resolver.iteration(p['iterationId'], p['projectId']),
  ]);
  return { assignee: personRef(p['assigneeId'], p['assigneeName'], person), iteration };
}

/**
 * `rova_search_work_items` — filtered list in one project (GET /v1/work-items, `work_item:view` from
 * the `projectId` query). Filters mirror the REST `WorkItemQueryDto` subset an agent needs.
 */
export function registerSearchWorkItems(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_search_work_items',
    {
      title: 'Search work items',
      description:
        'Search the work items of one project you can read, with optional filters. Paginated.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        projectId: z.uuid().describe('The project to search in'),
        q: z.string().max(255).optional().describe('Free-text search over title and key'),
        assigneeId: z.uuid().optional().describe('Filter by assignee'),
        iterationId: z.uuid().optional().describe('Filter by iteration'),
        statusId: z.uuid().optional().describe('Filter by workflow status'),
        priority: z
          .enum(['none', 'low', 'normal', 'high', 'urgent'])
          .optional()
          .describe('Filter by priority'),
        ...pageArgs,
      },
    },
    async ({ projectId, q, assigneeId, iterationId, statusId, priority, limit, cursor }) => {
      const resolver = createRefResolver(ctx);
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/work-items',
        query: {
          projectId,
          q,
          assigneeId,
          iterationId,
          statusId,
          priority,
          limit: limit ?? 20,
          cursor,
        },
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
