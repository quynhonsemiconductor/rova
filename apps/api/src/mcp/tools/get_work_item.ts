import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { result, type ToolContext } from './rest';

/** The WorkItemResponseDto fields an agent acts on, across item types (story/task/defect). */
export function shapeWorkItem(p: Record<string, unknown>) {
  return {
    id: p['id'],
    itemKey: p['itemKey'],
    title: p['title'],
    type: p['type'],
    description: p['description'] ?? null,
    scheduleState: p['scheduleState'],
    priority: p['priority'],
    assigneeName: p['assigneeName'] ?? null,
    devOwnerName: p['devOwnerName'] ?? null,
    storyPoints: p['storyPoints'] ?? null,
    estimateHours: p['estimateHours'] ?? null,
    todoHours: p['todoHours'] ?? null,
    parentId: p['parentId'] ?? null,
    featureId: p['featureId'] ?? null,
    teamId: p['teamId'] ?? null,
    iterationId: p['iterationId'] ?? null,
    releaseId: p['releaseId'] ?? null,
    isBlocked: p['isBlocked'],
    blockedReason: p['blockedReason'] ?? null,
    // defect-specific (null on stories/tasks)
    severity: p['severity'] ?? null,
    defectState: p['defectState'] ?? null,
    rootCause: p['rootCause'] ?? null,
    resolution: p['resolution'] ?? null,
    acceptanceCriteria: p['acceptanceCriteria'] ?? null,
    startDate: p['startDate'] ?? null,
    targetEndDate: p['targetEndDate'] ?? null,
    actualEndDate: p['actualEndDate'] ?? null,
    updatedAt: p['updatedAt'],
  };
}

/**
 * `get_work_item` — one work item by id, if the person can read it
 * (GET /v1/work-items/:id, `work_item:view` on the item).
 */
export function registerGetWorkItem(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_get_work_item',
    {
      title: 'Get work item',
      description:
        'One work item by id — its fields across story/task/defect types, exactly what its detail page shows you.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        workItemId: z.uuid().describe('The work item id'),
      },
    },
    async ({ workItemId }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: `/v1/work-items/${workItemId}`,
      });
      const p = json as Record<string, unknown>;
      return result(statusCode, json, shapeWorkItem(p));
    },
  );
}
