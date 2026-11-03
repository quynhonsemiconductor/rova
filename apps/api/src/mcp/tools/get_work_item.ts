import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, result, type ToolContext, pathSegment } from './rest';
import {
  createRefResolver,
  personRef,
  type PersonRef,
  type Ref,
  type WorkItemParentRef,
} from './refs';

/** The identity a detail row adds once its ids are resolved (refs.ts). */
export interface WorkItemRefs {
  assignee?: PersonRef | null;
  devOwner?: PersonRef | null;
  parent?: WorkItemParentRef | null;
  team?: Ref | null;
  iteration?: Ref | null;
  release?: Ref | null;
}

/** The WorkItemResponseDto fields an agent acts on, across item types (story/task/defect). */
export function shapeWorkItem(p: Record<string, unknown>, refs: WorkItemRefs = {}) {
  return {
    id: p['id'],
    itemKey: p['itemKey'],
    title: p['title'],
    type: p['type'],
    description: p['description'] ?? null,
    scheduleState: p['scheduleState'],
    priority: p['priority'],
    // Both names are joined server-side on the record read; a person with no picker row (a
    // Workspace Admin) keeps that name even when the workspace feed cannot resolve the id.
    assignee: refs.assignee ?? null,
    devOwner: refs.devOwner ?? null,
    storyPoints: p['storyPoints'] ?? null,
    estimateHours: p['estimateHours'] ?? null,
    todoHours: p['todoHours'] ?? null,
    parent: refs.parent ?? null,
    featureId: p['featureId'] ?? null,
    team: refs.team ?? null,
    iteration: refs.iteration ?? null,
    release: refs.release ?? null,
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

/** Resolves the record's ids through the app's own reference feeds (one fetch per kind). */
export async function resolveWorkItemRefs(
  p: Record<string, unknown>,
  resolver: ReturnType<typeof createRefResolver>,
): Promise<WorkItemRefs> {
  const projectId = p['projectId'];
  const [assignee, devOwner, parent, team, iteration, release] = await Promise.all([
    resolver.person(p['assigneeId']),
    resolver.person(p['devOwnerId']),
    resolver.parent(p['parentId']),
    resolver.team(p['teamId']),
    resolver.iteration(p['iterationId'], projectId),
    resolver.release(p['releaseId'], projectId),
  ]);
  return {
    assignee: personRef(p['assigneeId'], p['assigneeName'], assignee),
    devOwner: personRef(p['devOwnerId'], p['devOwnerName'], devOwner),
    parent,
    team,
    iteration,
    release,
  };
}

/**
 * `rova_get_work_item` — one work item by id, if the person can read it
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
      const resolver = createRefResolver(ctx);
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: `/v1/work-items/${pathSegment(workItemId)}`,
      });
      if (statusCode >= 400 || json === null || typeof json !== 'object' || Array.isArray(json))
        return denied(statusCode, json);
      const p = json as Record<string, unknown>;
      return result(statusCode, json, shapeWorkItem(p, await resolveWorkItemRefs(p, resolver)));
    },
  );
}
