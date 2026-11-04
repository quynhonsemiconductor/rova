import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, pathSegment, result, toolError, type ToolContext } from './rest';
import { failureResult, resolveWorkItem } from './lookups';

/** Same rule as the REST `LoggedDateSchema`: a real calendar date in 2000–2100 (2026-02-30 is refused). */
function isRealLoggedDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 2000 || year > 2100) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

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
        "WRITES a time log on a work item as YOU, and must be used only on the user's explicit request. `date` is the work date (YYYY-MM-DD, a real calendar date) and is required.",
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
          .refine(isRealLoggedDate, 'Must be a real calendar date between 2000 and 2100')
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
      ctx.noteWrite?.({
        targets: [item.id],
        fields: ['hours', 'loggedDate', 'description'],
        count: 1,
      });
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
