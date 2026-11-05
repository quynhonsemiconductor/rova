/**
 * The tool catalogue: every tool's name and the REST route it composes, in one table. This is
 * the ratchet's anchor (tools.routes.spec.ts asserts each route exists in the controllers) and
 * the stability contract — names are deprecated, never renamed (MCP-PLAN §11). 2026-10-26
 * owner decision: every name carries the `rova_` prefix, because the MCP portal fronts all
 * apps and tool names must be unique across them.
 */
export const TOOL_ROUTES = {
  rova_whoami: { method: 'GET', url: '/v1/auth/me' },
  rova_list_projects: { method: 'GET', url: '/v1/projects' },
  rova_search_work_items: { method: 'GET', url: '/v1/work-items' },
  rova_my_work: { method: 'GET', url: '/v1/work-items/my' },
  rova_list_iterations: { method: 'GET', url: '/v1/iterations' },
  rova_list_comments: { method: 'GET', url: '/v1/work-items/:workItemId/comments' },
  rova_get_work_item: { method: 'GET', url: '/v1/work-items/:workItemId' },
  rova_get_project: { method: 'GET', url: '/v1/projects/:projectId' },
  rova_list_project_members: { method: 'GET', url: '/v1/projects/:id/member-options' },
  rova_get_work_item_by_key: { method: 'GET', url: '/v1/work-items/by-key' },
  rova_list_backlog: { method: 'GET', url: '/v1/work-items/backlog' },
  rova_work_item_activity: { method: 'GET', url: '/v1/work-items/:id/activity' },
  rova_work_item_details: { method: 'GET', url: '/v1/work-items/:id/tasks' },
  rova_project_vocabulary: { method: 'GET', url: '/v1/projects/:id/statuses' },
  rova_project_activity: { method: 'GET', url: '/v1/projects/:id/activity' },
  rova_list_test_results: { method: 'GET', url: '/v1/test-cases/:id/test-results' },
  rova_iteration_options: { method: 'GET', url: '/v1/iterations/options' },
  rova_iteration_status: { method: 'GET', url: '/v1/iterations/:id/status' },
  rova_list_releases: { method: 'GET', url: '/v1/releases' },
  rova_list_milestones: { method: 'GET', url: '/v1/milestones' },
  rova_iteration_burndown: { method: 'GET', url: '/v1/reports/iteration-burndown' },
  rova_velocity: { method: 'GET', url: '/v1/reports/velocity' },
  rova_team_capacity: { method: 'GET', url: '/v1/reports/team-capacity' },
  rova_unread_notifications: { method: 'GET', url: '/v1/notifications/unread-count' },
  rova_list_test_cases: { method: 'GET', url: '/v1/work-items/:id/test-cases' },
  rova_get_test_case_by_key: { method: 'GET', url: '/v1/test-cases/by-key/:key' },
  rova_quality_defects: { method: 'GET', url: '/v1/quality/defects' },
  rova_team_status: { method: 'GET', url: '/v1/team-status' },
  rova_list_portfolio_items: { method: 'GET', url: '/v1/portfolio-items' },
  rova_get_portfolio_item: { method: 'GET', url: '/v1/portfolio-items/:portfolioItemId' },
  rova_carryover_report: { method: 'GET', url: '/v1/reports/carryover' },
  rova_release_tracking: { method: 'GET', url: '/v1/reports/release-tracking' },
  rova_get_release: { method: 'GET', url: '/v1/releases/:id' },
  rova_get_milestone: { method: 'GET', url: '/v1/milestones/:id' },
  rova_project_health: { method: 'GET', url: '/v1/projects/health' },
  rova_work_item_code_changes: { method: 'GET', url: '/v1/work-items/:id/connections' },
  rova_list_teams: { method: 'GET', url: '/v1/workspaces/:workspaceId/teams' },
  rova_list_notifications: { method: 'GET', url: '/v1/notifications' },
} as const;

/**
 * The write catalogue, empty until the first write tool lands. Every entry is a NON-GET route
 * the MCP bridge may reach, and it is the SOURCE of the REST-side allowlist (`write-policy.ts`
 * derives `MCP_WRITE_ROUTES` from this table): a write tool that is not listed here mounts, but
 * its injected request is refused 403 by `McpWriteGuard`. The routes spec keeps the two in step.
 */
export interface WriteRoute {
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
}

/**
 * Every write tool and the route(s) it may reach. A tool may name MORE THAN ONE route when its
 * arguments select the subject (a comment lives on a work item or a portfolio item); every one
 * of them is required to be reachable from MCP or the tool cannot do its job.
 */
export const WRITE_TOOL_ROUTES = {
  rova_log_time: { method: 'POST', url: '/v1/work-items/:id/time-logs' },
  rova_add_comment: [
    { method: 'POST', url: '/v1/work-items/:id/comments' },
    { method: 'POST', url: '/v1/portfolio-items/:id/comments' },
  ],
  rova_mark_notifications_read: [
    { method: 'POST', url: '/v1/notifications/:id/read' },
    { method: 'POST', url: '/v1/notifications/read-all' },
  ],
  rova_create_work_item: { method: 'POST', url: '/v1/work-items' },
  rova_add_task: { method: 'POST', url: '/v1/work-items/:id/tasks' },
  rova_update_work_item: { method: 'PATCH', url: '/v1/work-items/:id' },
  rova_link_work_items: { method: 'POST', url: '/v1/work-items/:id/relations' },
  rova_label_work_item: [
    { method: 'POST', url: '/v1/work-items/:id/labels' },
    { method: 'DELETE', url: '/v1/work-items/:id/labels/:labelId' },
  ],
  rova_plan_work_items: [
    { method: 'PATCH', url: '/v1/work-items/bulk-iteration' },
    { method: 'PATCH', url: '/v1/work-items/bulk-release' },
  ],
  // A test case is created under its parent work item and edited by its own id.
  rova_save_test_case: [
    { method: 'POST', url: '/v1/work-items/:id/test-cases' },
    { method: 'PATCH', url: '/v1/test-cases/:id' },
  ],
  rova_record_test_results: { method: 'POST', url: '/v1/test-cases/:id/test-results' },
  // A portfolio item is created at the collection and edited by its own id.
  rova_save_portfolio_item: [
    { method: 'POST', url: '/v1/portfolio-items' },
    { method: 'PATCH', url: '/v1/portfolio-items/:id' },
  ],
  rova_save_iteration: [
    { method: 'POST', url: '/v1/iterations' },
    { method: 'PATCH', url: '/v1/iterations/:id' },
  ],
} as const satisfies Record<string, WriteRoute | readonly WriteRoute[]>;

export type ToolName = keyof typeof TOOL_ROUTES;
