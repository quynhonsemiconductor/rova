import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, type ToolContext } from './rest';

/**
 * `quality_defects` — the Defects grid of one project with its metrics rollup
 * (GET /v1/quality/defects, `quality:view` from the `projectId` query). The route pages by
 * OFFSET; the tool caps the page and relays the offset for the next slice.
 */
export function registerQualityDefects(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'quality_defects',
    {
      title: 'Quality defects',
      description:
        'The Defects of one project you can read — grid rows plus the open/critical metrics rollup. Offset-paginated.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        projectId: z.uuid().describe('The project whose defects to list'),
        search: z.string().max(200).optional().describe('Free-text filter'),
        severity: z
          .enum(['all', 'critical', 'major', 'minor', 'trivial'])
          .optional()
          .describe('Filter by severity'),
        offset: z.number().int().min(0).optional().describe('Rows to skip (offset pagination)'),
        limit: z.number().int().min(1).max(20).optional().describe('Rows per page (max 20)'),
      },
    },
    async ({ projectId, search, severity, offset, limit }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/quality/defects',
        query: {
          projectId,
          ...(search ? { search } : {}),
          ...(severity && severity !== 'all' ? { severity } : {}),
          ...(offset ? { offset } : {}),
          ...(limit ? { limit } : {}),
        },
      });
      if (json === null || typeof json !== 'object' || Array.isArray(json))
        return denied(statusCode, json);
      const body = json as {
        data?: Record<string, unknown>[];
        total?: number;
        hasMore?: boolean;
        metrics?: Record<string, unknown>;
      };
      if (!Array.isArray(body.data)) return denied(statusCode, json);
      const capped = body.data.slice(0, 20);
      const shaped: Record<string, unknown> = {
        metrics: body.metrics ?? undefined,
        defects: capped.map((d) => ({
          id: d['id'],
          itemKey: d['itemKey'],
          title: d['title'],
          severity: d['severity'] ?? null,
          priority: d['priority'],
          defectState: d['defectState'] ?? null,
          rootCause: d['rootCause'] ?? null,
          resolution: d['resolution'] ?? null,
          assigneeName: d['assigneeName'] ?? null,
        })),
        total: body.total,
        hasMore: body.hasMore,
        offset: offset ?? 0,
      };
      if (body.data.length > 20) shaped['truncated'] = true;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(shaped) }],
      };
    },
  );
}
