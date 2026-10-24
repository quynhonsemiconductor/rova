import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pageInfoOf, pageArgs, result, type ToolContext } from './rest';

/**
 * `iteration_status` — the Iteration Status read-model of one iteration
 * (GET /v1/iterations/:id/status, `iteration:view` on the iteration): metrics plus the
 * assigned work items.
 */
export function registerIterationStatus(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'iteration_status',
    {
      title: 'Iteration status',
      description:
        'Metrics and assigned work items for one iteration you can read (accepted points, defects, days left). Paginated.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        iterationId: z.uuid().describe('The iteration id'),
        q: z.string().max(255).optional().describe('Free-text filter over the assigned work items'),
        isBlocked: z.boolean().optional().describe('Only blocked items'),
        ...pageArgs,
      },
    },
    async ({ iterationId, q, isBlocked, limit, cursor }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: `/v1/iterations/${iterationId}/status`,
        query: {
          q,
          ...(isBlocked !== undefined ? { isBlocked: String(isBlocked) } : {}),
          limit: limit ?? 20,
          cursor,
        },
      });
      const body = json as {
        iteration?: Record<string, unknown>;
        metrics?: Record<string, unknown>;
        items?: Record<string, unknown>[];
        pageInfo?: unknown;
      };
      const m = body.metrics ?? {};
      return result(statusCode, json, {
        iteration: body.iteration
          ? {
              name: body.iteration['name'],
              state: body.iteration['state'],
              startDate: body.iteration['startDate'] ?? null,
              endDate: body.iteration['endDate'] ?? null,
            }
          : undefined,
        metrics: {
          plannedVelocity: m['plannedVelocity'] ?? null,
          acceptedPoints: m['acceptedPoints'],
          acceptedPercent: m['acceptedPercent'],
          daysLeft: m['daysLeft'] ?? null,
          defectCount: m['defectCount'],
          taskCount: m['taskCount'],
        },
        items: (body.items ?? []).map((it) => ({
          id: it['workItemId'],
          itemKey: it['itemKey'],
          type: it['type'],
          title: it['title'],
          scheduleState: it['scheduleState'],
          isBlocked: it['isBlocked'],
          planEstimate: it['planEstimate'] ?? null,
        })),
        ...pageInfoOf(json),
      });
    },
  );
}
