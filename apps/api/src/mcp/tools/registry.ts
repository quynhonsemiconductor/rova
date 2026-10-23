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
} as const;

export type ToolName = keyof typeof TOOL_ROUTES;
