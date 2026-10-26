import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCarryoverReport } from './carryover_report';
import { registerGetMilestone } from './get_milestone';
import { registerGetPortfolioItem } from './get_portfolio_item';
import { registerGetRelease } from './get_release';
import { registerListNotifications } from './list_notifications';
import { registerListTeams } from './list_teams';
import { registerProjectHealth } from './project_health';
import { registerReleaseTracking } from './release_tracking';
import { registerWorkItemCodeChanges } from './work_item_code_changes';
import { registerGetProject } from './get_project';
import { registerGetTestCaseByKey } from './get_test_case_by_key';
import { registerIterationBurndown } from './iteration_burndown';
import { registerListMilestones } from './list_milestones';
import { registerListReleases } from './list_releases';
import { registerGetWorkItem } from './get_work_item';
import { registerGetWorkItemByKey } from './get_work_item_by_key';
import { registerIterationOptions } from './iteration_options';
import { registerIterationStatus } from './iteration_status';
import { registerListBacklog } from './list_backlog';
import { registerListPortfolioItems } from './list_portfolio_items';
import { registerListComments } from './list_comments';
import { registerListIterations } from './list_iterations';
import { registerListProjectMembers } from './list_project_members';
import { registerListProjects } from './list_projects';
import { registerListTestCases } from './list_test_cases';
import { registerMyWork } from './my_work';
import { registerSearchWorkItems } from './search_work_items';
import { registerTeamCapacity } from './team_capacity';
import { registerUnreadNotifications } from './unread_notifications';
import { registerVelocity } from './velocity';
import { registerQualityDefects } from './quality_defects';
import { registerTeamStatus } from './team_status';
import { registerWhoami } from './whoami';
import { registerWorkItemActivity } from './work_item_activity';
import type { ToolContext } from './rest';

/** One mounted tool, with its stable name (RegisteredTool itself carries no name). */
export interface MountedTool {
  name: string;
  tool: RegisteredTool;
}

/** Mounts the P1 read-only catalogue on a fresh per-request server; returns what it mounted. */
export function registerTools(server: McpServer, ctx: ToolContext): MountedTool[] {
  return [
    { name: 'whoami', tool: registerWhoami(server, ctx) },
    { name: 'list_projects', tool: registerListProjects(server, ctx) },
    { name: 'get_project', tool: registerGetProject(server, ctx) },
    { name: 'list_project_members', tool: registerListProjectMembers(server, ctx) },
    { name: 'search_work_items', tool: registerSearchWorkItems(server, ctx) },
    { name: 'get_work_item', tool: registerGetWorkItem(server, ctx) },
    { name: 'get_work_item_by_key', tool: registerGetWorkItemByKey(server, ctx) },
    { name: 'my_work', tool: registerMyWork(server, ctx) },
    { name: 'list_backlog', tool: registerListBacklog(server, ctx) },
    { name: 'work_item_activity', tool: registerWorkItemActivity(server, ctx) },
    { name: 'list_iterations', tool: registerListIterations(server, ctx) },
    { name: 'iteration_options', tool: registerIterationOptions(server, ctx) },
    { name: 'iteration_status', tool: registerIterationStatus(server, ctx) },
    { name: 'list_comments', tool: registerListComments(server, ctx) },
    { name: 'list_releases', tool: registerListReleases(server, ctx) },
    { name: 'list_milestones', tool: registerListMilestones(server, ctx) },
    { name: 'iteration_burndown', tool: registerIterationBurndown(server, ctx) },
    { name: 'velocity', tool: registerVelocity(server, ctx) },
    { name: 'team_capacity', tool: registerTeamCapacity(server, ctx) },
    { name: 'unread_notifications', tool: registerUnreadNotifications(server, ctx) },
    { name: 'list_test_cases', tool: registerListTestCases(server, ctx) },
    { name: 'get_test_case_by_key', tool: registerGetTestCaseByKey(server, ctx) },
    { name: 'quality_defects', tool: registerQualityDefects(server, ctx) },
    { name: 'team_status', tool: registerTeamStatus(server, ctx) },
    { name: 'list_portfolio_items', tool: registerListPortfolioItems(server, ctx) },
    { name: 'get_portfolio_item', tool: registerGetPortfolioItem(server, ctx) },
    { name: 'carryover_report', tool: registerCarryoverReport(server, ctx) },
    { name: 'release_tracking', tool: registerReleaseTracking(server, ctx) },
    { name: 'get_release', tool: registerGetRelease(server, ctx) },
    { name: 'get_milestone', tool: registerGetMilestone(server, ctx) },
    { name: 'project_health', tool: registerProjectHealth(server, ctx) },
    { name: 'work_item_code_changes', tool: registerWorkItemCodeChanges(server, ctx) },
    { name: 'list_teams', tool: registerListTeams(server, ctx) },
    { name: 'list_notifications', tool: registerListNotifications(server, ctx) },
  ];
}
