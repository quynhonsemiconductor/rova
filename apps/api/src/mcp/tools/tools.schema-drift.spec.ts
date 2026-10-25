import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { PageQuerySchema } from '@platform';
import {
  IterationAssignmentOptionsQuerySchema,
  IterationQuerySchema,
} from '@modules/iterations/interface/http/dto/iteration-request.dto';
import { IterationStatusQuerySchema } from '@modules/iterations/interface/http/dto/iteration-status-request.dto';
import {
  ActivityQuerySchema,
  WorkItemQuerySchema,
} from '@modules/work-items/interface/http/dto/work-item-request.dto';
import {
  IterationBurndownQuerySchema,
  TeamCapacityQuerySchema,
  VelocityQuerySchema,
} from '@modules/reporting/interface/http/dto/reporting-request.dto';
import { MilestoneQuerySchema } from '@modules/milestones/interface/http/dto/milestone-request.dto';
import { ReleaseQuerySchema } from '@modules/releases/interface/http/dto/release-request.dto';
import { registerTools } from './register';
import type { ToolContext } from './rest';

/**
 * SCHEMA DRIFT (owner decision on rova#788): the tools' inline zod inputs mirror the REST query
 * schemas, deliberately re-declared because the ratchet bans importing product modules into tool
 * files. This spec lives in .spec.ts and MAY import @modules: it asserts each tool's input keys
 * are a SUBSET of the REST schema's keys, so a filter renamed or removed on a REST route breaks
 * THIS test until the tool follows — the mirror cannot silently rot into a 400 the REST route
 * never asked for. Tools whose routes take no query DTO (whoami, get_work_item, my_work's plain
 * `limit`, list_comments' no-query route) are pinned by hand below.
 */

const fakeCtx: ToolContext = {
  principal: {
    userId: '0194a000-0000-7000-8000-0000000000aa',
    workspaceId: '0194a000-0000-7000-8000-000000000003',
    sessionId: 'mcp:drift',
  },
  callRest: async () => ({ statusCode: 200, json: {} }),
};

/** Mounts the catalogue on a throwaway server and returns name → input keys. */
function toolInputs(): Map<string, string[]> {
  // a real McpServer, so what is checked is exactly what a client receives
  const server = new McpServer({ name: 'drift', version: '0.0.0' });
  const mounted = registerTools(server, fakeCtx);
  return new Map(
    mounted.map(({ name, tool }) => [
      name,
      // the SDK stores registerTool's raw shape wrapped as a zod object: `.shape` holds the fields
      Object.keys(
        (tool.inputSchema as { shape?: Record<string, unknown> } | undefined)?.shape ?? {},
      ),
    ]),
  );
}

describe("MCP tool inputs ⊆ their REST route's query schema", () => {
  it('list_projects ⊆ PageQuerySchema (GET /v1/projects)', () => {
    const rest = Object.keys(PageQuerySchema.shape);
    const tool = toolInputs().get('list_projects')!;
    expect(tool.length).toBeGreaterThan(0);
    expect(tool.filter((key) => !rest.includes(key))).toEqual([]);
  });

  it('search_work_items ⊆ WorkItemQuerySchema (GET /v1/work-items)', () => {
    const rest = Object.keys(WorkItemQuerySchema.shape);
    const tool = toolInputs().get('search_work_items')!;
    expect(tool.length).toBeGreaterThan(0);
    expect(tool.filter((key) => !rest.includes(key))).toEqual([]);
  });

  it('list_iterations ⊆ IterationQuerySchema (GET /v1/iterations)', () => {
    const rest = Object.keys(IterationQuerySchema.shape);
    const tool = toolInputs().get('list_iterations')!;
    expect(tool.length).toBeGreaterThan(0);
    expect(tool.filter((key) => !rest.includes(key))).toEqual([]);
  });

  it('get_project ⊆ WorkItemByKeyQuerySchema-shapeless (GET /v1/projects/:id — path param only)', () => {
    expect(toolInputs().get('get_project')).toEqual(['projectId']);
  });

  it('list_project_members takes only the path param (GET /v1/projects/:id/member-options)', () => {
    expect(toolInputs().get('list_project_members')).toEqual(['projectId']);
  });

  it('get_work_item_by_key mirrors WorkItemByKeyQuerySchema (GET /v1/work-items/by-key)', () => {
    expect(toolInputs().get('get_work_item_by_key')).toEqual(['itemKey']);
  });

  it('list_backlog ⊆ WorkItemQuerySchema (GET /v1/work-items/backlog)', () => {
    const rest = Object.keys(WorkItemQuerySchema.shape);
    const tool = toolInputs().get('list_backlog')!;
    expect(tool.length).toBeGreaterThan(0);
    expect(tool.filter((key) => !rest.includes(key))).toEqual([]);
  });

  it('work_item_activity mirrors ActivityQuerySchema (GET /v1/work-items/:id/activity)', () => {
    const rest = Object.keys(ActivityQuerySchema.shape);
    // workItemId is the path param, not a query key
    const tool = toolInputs()
      .get('work_item_activity')!
      .filter((k) => k !== 'workItemId');
    // the tool exposes `page` only and pins pageSize itself
    expect(tool.filter((key) => !rest.includes(key))).toEqual([]);
  });

  it('iteration_options ⊆ IterationAssignmentOptionsQuerySchema (GET /v1/iterations/options)', () => {
    const rest = Object.keys(IterationAssignmentOptionsQuerySchema.shape);
    const tool = toolInputs().get('iteration_options')!;
    expect(tool.length).toBeGreaterThan(0);
    expect(tool.filter((key) => !rest.includes(key))).toEqual([]);
  });

  it('iteration_status ⊆ IterationStatusQuerySchema (GET /v1/iterations/:id/status)', () => {
    const rest = Object.keys(IterationStatusQuerySchema.shape);
    // iterationId is the path param, not a query key
    const tool = toolInputs()
      .get('iteration_status')!
      .filter((k) => k !== 'iterationId');
    expect(tool.length).toBeGreaterThan(0);
    expect(tool.filter((key) => !rest.includes(key))).toEqual([]);
  });

  it('list_releases ⊆ ReleaseQuerySchema (GET /v1/releases)', () => {
    const rest = Object.keys(ReleaseQuerySchema.shape);
    const tool = toolInputs().get('list_releases')!;
    expect(tool.length).toBeGreaterThan(0);
    expect(tool.filter((key) => !rest.includes(key))).toEqual([]);
  });

  it('list_milestones ⊆ MilestoneQuerySchema (GET /v1/milestones)', () => {
    const rest = Object.keys(MilestoneQuerySchema.shape);
    const tool = toolInputs().get('list_milestones')!;
    expect(tool.length).toBeGreaterThan(0);
    expect(tool.filter((key) => !rest.includes(key))).toEqual([]);
  });

  it('iteration_burndown ⊆ IterationBurndownQuerySchema (GET /v1/reports/iteration-burndown)', () => {
    const rest = Object.keys(IterationBurndownQuerySchema.shape);
    const tool = toolInputs().get('iteration_burndown')!;
    expect(tool.length).toBeGreaterThan(0);
    expect(tool.filter((key) => !rest.includes(key))).toEqual([]);
  });

  it('velocity ⊆ VelocityQuerySchema (GET /v1/reports/velocity)', () => {
    const rest = Object.keys(VelocityQuerySchema.shape);
    const tool = toolInputs().get('velocity')!;
    expect(tool.length).toBeGreaterThan(0);
    expect(tool.filter((key) => !rest.includes(key))).toEqual([]);
  });

  it('team_capacity ⊆ TeamCapacityQuerySchema (GET /v1/reports/team-capacity)', () => {
    const rest = Object.keys(TeamCapacityQuerySchema.shape);
    const tool = toolInputs().get('team_capacity')!;
    expect(tool.length).toBeGreaterThan(0);
    expect(tool.filter((key) => !rest.includes(key))).toEqual([]);
  });

  it('the schema-less routes take only what their controllers read by hand', () => {
    const inputs = toolInputs();
    // GET /v1/work-items/my reads `@Query('limit')` only
    expect(inputs.get('my_work')).toEqual(['limit']);
    // GET /v1/work-items/:workItemId/comments reads NO query (unpaginated REST route)
    expect(inputs.get('list_comments')).toEqual(['workItemId']);
    // no query at all
    expect(inputs.get('whoami')).toEqual([]);
    expect(inputs.get('get_work_item')).toEqual(['workItemId']);
    // GET /v1/notifications/unread-count reads NO query
    expect(inputs.get('unread_notifications')).toEqual([]);
  });
});
