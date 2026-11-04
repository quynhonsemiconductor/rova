import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, pathSegment, result, toolError, type ToolContext } from './rest';
import { failureResult, resolveWorkItem } from './lookups';

/**
 * `rova_log_time` — log hours the CALLER worked on a work item (W7). Wraps
 * `POST /v1/work-items/:id/time-logs`, which records the person from the request and is already
 * `@UseIdempotency`, so an LLM retry inside the 10-minute bucket replays the first entry instead
 * of double-logging.
 *
 * `date` is REQUIRED (YYYY-MM-DD): "today" is a database-clock question and a tool must not guess
 * it from the process clock.
 */
export function registerLogTime(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_log_time',
    {
      title: 'Log time',
      description:
        'Log hours YOU worked on a work item. `date` is the work date (YYYY-MM-DD) and is required. Creates a time log on the item.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        key: z.string().min(1).max(64).describe('The work item key (e.g. US-412) or id'),
        hours: z.number().positive().max(24).describe('Hours worked (max 24)'),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
          .describe('The work date'),
        description: z.string().max(2000).optional().describe('What the time was for'),
      },
    },
    async ({ key, hours, date, description }) => {
      const item = await resolveWorkItem(ctx, key);
      if (!item.ok) return failureResult(item);
      if (!ctx.idempotencyKey) return toolError('Writes are not enabled on this endpoint.');

      const idempotencyKey = ctx.idempotencyKey('rova_log_time', { key, hours, date, description });
      const res = await ctx.callRest(ctx.principal, {
        method: 'POST',
        url: `/v1/work-items/${pathSegment(item.id)}/time-logs`,
        body: { loggedDate: date, hours, ...(description !== undefined ? { description } : {}) },
        idempotencyKey,
      });
      if (res.statusCode >= 400 || res.json === null || typeof res.json !== 'object') {
        return denied(res.statusCode, res.json);
      }
      const row = res.json as Record<string, unknown>;
      return result(res.statusCode, res.json, {
        timeLog: {
          id: row['id'],
          workItemId: row['workItemId'],
          userId: row['userId'],
          hours: row['hours'],
          loggedDate: row['loggedDate'],
          description: row['description'] ?? null,
          createdAt: row['createdAt'],
        },
        changed: ['hours', 'loggedDate', 'description'],
      });
    },
  );
}
