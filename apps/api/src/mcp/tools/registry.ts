/**
 * The tool catalogue: every tool's name and the REST route it composes, in one table. This is
 * the ratchet's anchor (tools.routes.spec.ts asserts each route exists in the controllers) and
 * the stability contract — names are deprecated, never renamed (MCP-PLAN §11).
 */
export const TOOL_ROUTES = {
  whoami: { method: 'GET', url: '/v1/auth/me' },
  list_projects: { method: 'GET', url: '/v1/projects' },
  search_work_items: { method: 'GET', url: '/v1/work-items' },
  my_work: { method: 'GET', url: '/v1/work-items/my' },
  list_iterations: { method: 'GET', url: '/v1/iterations' },
  list_comments: { method: 'GET', url: '/v1/work-items/:workItemId/comments' },
  get_work_item: { method: 'GET', url: '/v1/work-items/:workItemId' },
  get_project: { method: 'GET', url: '/v1/projects/:projectId' },
  list_project_members: { method: 'GET', url: '/v1/projects/:id/member-options' },
  get_work_item_by_key: { method: 'GET', url: '/v1/work-items/by-key' },
  list_backlog: { method: 'GET', url: '/v1/work-items/backlog' },
  work_item_activity: { method: 'GET', url: '/v1/work-items/:id/activity' },
  iteration_options: { method: 'GET', url: '/v1/iterations/options' },
  iteration_status: { method: 'GET', url: '/v1/iterations/:id/status' },
} as const;

export type ToolName = keyof typeof TOOL_ROUTES;
