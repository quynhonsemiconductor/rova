import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  denied,
  isRealCalendarDate,
  pathSegment,
  result,
  replayedFrom,
  toolError,
  type ToolContext,
} from './rest';
import { failureResult, resolveWorkItem } from './lookups';

/**
 * `rova_log_time` — log hours the CALLER worked on a work item (W7). Wraps
 * `POST /v1/work-items/:id/time-logs`, which records the person from the request and is already
 * `@UseIdempotency`, so an LLM retry with the same `requestId` replays the first entry instead of
 * double-logging; without one a repeat is a second log, as it should be.
 *
 * `date` is REQUIRED (YYYY-MM-DD): "today" is a database-clock question and a tool must not guess
 * it from the process clock. ({@link isRealCalendarDate} is the shared check.)
 */
export function registerLogTime(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_log_time',
    {
      title: 'Log time',
      description:
        "WRITES a time log on a work item as YOU, and must be used only on the user's explicit request. `date` is the work date (YYYY-MM-DD, a real calendar date) and is required. DUPLICATES: a create is deduplicated ONLY by `requestId` — generate one per user request and reuse the SAME value when retrying that request; without one a retry may create a duplicate. A reused `requestId` replays the first record for 24 h; during a Valkey outage a retry may create a duplicate.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        requestId: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe(
            'A create-only retry guard: generate once per user request and reuse the SAME value when retrying that request. A repeat with the same id returns the first record; omit it and a retry may create a duplicate.',
          ),
        key: z.string().min(1).max(64).describe('The work item key (e.g. US-412) or id'),
        hours: z.number().positive().max(24).describe('Hours worked (max 24)'),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
          .refine(isRealCalendarDate, 'Must be a real calendar date between 2000 and 2100')
          .describe('The work date'),
        description: z.string().max(2000).optional().describe('What the time was for'),
      },
    },
    async ({ key, hours, date, description, requestId }) => {
      const item = await resolveWorkItem(ctx, key);
      if (!item.ok) return failureResult(item);
      if (!ctx.clientIdempotencyKey) return toolError('Writes are not enabled on this endpoint.');
      const idempotencyKey =
        requestId !== undefined
          ? ctx.clientIdempotencyKey('rova_log_time', { requestId })
          : undefined;
      const res = await ctx.callRest(ctx.principal, {
        method: 'POST',
        url: `/v1/work-items/${pathSegment(item.id)}/time-logs`,
        body: { loggedDate: date, hours, ...(description !== undefined ? { description } : {}) },
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
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
        replayed: replayedFrom(res),
      });
    },
  );
}
