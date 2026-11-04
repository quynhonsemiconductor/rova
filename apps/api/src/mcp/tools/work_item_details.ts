import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pathSegment, result, type McpRestResult, type ToolContext } from './rest';
import { failureResult, resolveWorkItem } from './lookups';

const SECTIONS = [
  'tasks',
  'relations',
  'labels',
  'timeLogs',
  'testCases',
  'watchers',
  'attachments',
] as const;
type Section = (typeof SECTIONS)[number];

/** Caps keep one tool call inside an agent's context; a bigger feed is flagged, not fetched. */
const ARRAY_CAP = 100;
const PAGE_CAP = 50;

interface Raw {
  json: unknown;
  status: number;
}

function rowsOf(json: unknown): Record<string, unknown>[] | null {
  const body = Array.isArray(json) ? json : (json as { data?: unknown } | null)?.data;
  return Array.isArray(body) ? (body as Record<string, unknown>[]) : null;
}

/**
 * `rova_work_item_details` — the sub-resources the work-item DETAIL page shows but the record
 * read does not: child tasks, relations, labels, time logs (who/when/hours), test cases,
 * watchers and attachment names. `include` narrows the sections; a section the caller cannot
 * read is `null` and listed in `unavailable`, so one missing permission does not hide the rest.
 */
export function registerWorkItemDetails(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_work_item_details',
    {
      title: 'Work item details',
      description:
        'Tasks, relations, labels, time logs, test cases, watchers and attachment names of one work item you can read. `include` selects sections.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        key: z.string().min(1).max(64).describe('The work item key (e.g. US-412) or id'),
        include: z.array(z.enum(SECTIONS)).optional().describe('Sections to fetch (default: all)'),
      },
    },
    async ({ key, include }) => {
      const item = await resolveWorkItem(ctx, key);
      if (!item.ok) return failureResult(item);
      const wanted = new Set<Section>(include ?? SECTIONS);
      const itemPath = pathSegment(item.id);

      const fetchSection = async (
        url: string,
        query?: Record<string, number>,
      ): Promise<Raw | null> => {
        if (!wanted.size) return null;
        const res: McpRestResult = await ctx.callRest(ctx.principal, {
          method: 'GET',
          url,
          ...(query ? { query } : {}),
        });
        return { json: res.json, status: res.statusCode };
      };

      const [tasks, relations, labels, timeLogs, testCases, watchers, attachments] =
        await Promise.all([
          wanted.has('tasks') ? fetchSection(`/v1/work-items/${itemPath}/tasks`) : null,
          wanted.has('relations') ? fetchSection(`/v1/work-items/${itemPath}/relations`) : null,
          wanted.has('labels') ? fetchSection(`/v1/work-items/${itemPath}/labels`) : null,
          wanted.has('timeLogs')
            ? fetchSection(`/v1/work-items/${itemPath}/time-logs`, {
                page: 1,
                pageSize: PAGE_CAP,
              })
            : null,
          wanted.has('testCases')
            ? fetchSection(`/v1/work-items/${itemPath}/test-cases`, { limit: PAGE_CAP })
            : null,
          wanted.has('watchers') ? fetchSection(`/v1/work-items/${itemPath}/watchers`) : null,
          wanted.has('attachments') ? fetchSection(`/v1/work-items/${itemPath}/attachments`) : null,
        ]);

      const unavailable: Section[] = [];
      const arraySection = (name: Section, raw: Raw | null) => {
        if (raw === null) return undefined;
        if (raw.status >= 400) {
          unavailable.push(name);
          return null;
        }
        const rows = rowsOf(raw.json);
        if (!rows) {
          unavailable.push(name);
          return null;
        }
        const items = rows.slice(0, ARRAY_CAP);
        // A cap that bit is reported per SECTION: the caller can page the specific feed it needs
        // (the REST routes carry their own paging) instead of guessing which list was cut.
        return rows.length > items.length ? { items, truncated: true } : { items };
      };
      const timeLogSection = (raw: Raw | null) => {
        if (raw === null) return undefined;
        const body = raw.json as { items?: unknown; total?: unknown } | null;
        if (raw.status >= 400 || !body || !Array.isArray(body.items)) {
          unavailable.push('timeLogs');
          return null;
        }
        const items = (body.items as Record<string, unknown>[]).slice(0, ARRAY_CAP);
        const total = typeof body.total === 'number' ? body.total : items.length;
        return total > items.length ? { items, total, truncated: true } : { items, total };
      };
      const testCaseSection = (raw: Raw | null) => {
        if (raw === null) return undefined;
        const rows = rowsOf(raw.json);
        if (raw.status >= 400 || !rows) {
          unavailable.push('testCases');
          return null;
        }
        const pageInfo = (raw.json as { pageInfo?: unknown }).pageInfo;
        return { testCases: rows.slice(0, ARRAY_CAP), pageInfo: pageInfo ?? null };
      };

      const payload: Record<string, unknown> = {
        workItem: { id: item.id, itemKey: item.itemKey, title: item.title, version: item.version },
        tasks: arraySection('tasks', tasks),
        relations: arraySection('relations', relations),
        labels: arraySection('labels', labels),
        timeLogs: timeLogSection(timeLogs),
        testCases: testCaseSection(testCases),
        watchers: arraySection('watchers', watchers),
        attachments: arraySection('attachments', attachments),
      };
      for (const [k, v] of Object.entries(payload)) if (v === undefined) delete payload[k];
      if (unavailable.length > 0) payload['unavailable'] = unavailable;
      return result(200, {}, payload);
    },
  );
}
