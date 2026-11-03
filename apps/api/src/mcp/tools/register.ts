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
import type { ToolCallObserver, ToolContext } from './rest';
import { instrumentToolHandler } from './rest';

/** One mounted tool, with its stable name (RegisteredTool itself carries no name). */
export interface MountedTool {
  name: string;
  tool: RegisteredTool;
}

/**
 * Mounts the P1 read-only catalogue on a fresh per-request server; returns what it mounted.
 *
 * With an `observe` sink, every handler is wrapped once, here, so no tool can forget the audit
 * line: the SDK's `RegisteredTool.update({ callback })` replaces the handler in the registry the
 * transport dispatches to. The sink receives the tool name, the principal id and the duration.
 *
 * NOT COUNTED, deliberately: a `tools/call` for an unknown tool name or with arguments that fail
 * the input schema is rejected by the pinned SDK (@modelcontextprotocol/sdk 1.32.1,
 * `server/mcp.js`, the tools/call handler's `validateToolInput` and the registry lookup) BEFORE
 * the wrapped handler runs — it answers an `isError` result without dispatch. There is therefore
 * no tool to time and no principal-side work to audit; the only pre-dispatch refusal that IS
 * counted is the per-person rate limit, logged by route.ts.
 */
export function registerTools(
  server: McpServer,
  ctx: ToolContext,
  observe?: ToolCallObserver,
): MountedTool[] {
  const mounted: MountedTool[] = [
    { name: 'rova_whoami', tool: registerWhoami(server, ctx) },
    { name: 'rova_list_projects', tool: registerListProjects(server, ctx) },
    { name: 'rova_get_project', tool: registerGetProject(server, ctx) },
    { name: 'rova_list_project_members', tool: registerListProjectMembers(server, ctx) },
    { name: 'rova_search_work_items', tool: registerSearchWorkItems(server, ctx) },
    { name: 'rova_get_work_item', tool: registerGetWorkItem(server, ctx) },
    { name: 'rova_get_work_item_by_key', tool: registerGetWorkItemByKey(server, ctx) },
    { name: 'rova_my_work', tool: registerMyWork(server, ctx) },
    { name: 'rova_list_backlog', tool: registerListBacklog(server, ctx) },
    { name: 'rova_work_item_activity', tool: registerWorkItemActivity(server, ctx) },
    { name: 'rova_list_iterations', tool: registerListIterations(server, ctx) },
    { name: 'rova_iteration_options', tool: registerIterationOptions(server, ctx) },
    { name: 'rova_iteration_status', tool: registerIterationStatus(server, ctx) },
    { name: 'rova_list_comments', tool: registerListComments(server, ctx) },
    { name: 'rova_list_releases', tool: registerListReleases(server, ctx) },
    { name: 'rova_list_milestones', tool: registerListMilestones(server, ctx) },
    { name: 'rova_iteration_burndown', tool: registerIterationBurndown(server, ctx) },
    { name: 'rova_velocity', tool: registerVelocity(server, ctx) },
    { name: 'rova_team_capacity', tool: registerTeamCapacity(server, ctx) },
    { name: 'rova_unread_notifications', tool: registerUnreadNotifications(server, ctx) },
    { name: 'rova_list_test_cases', tool: registerListTestCases(server, ctx) },
    { name: 'rova_get_test_case_by_key', tool: registerGetTestCaseByKey(server, ctx) },
    { name: 'rova_quality_defects', tool: registerQualityDefects(server, ctx) },
    { name: 'rova_team_status', tool: registerTeamStatus(server, ctx) },
    { name: 'rova_list_portfolio_items', tool: registerListPortfolioItems(server, ctx) },
    { name: 'rova_get_portfolio_item', tool: registerGetPortfolioItem(server, ctx) },
    { name: 'rova_carryover_report', tool: registerCarryoverReport(server, ctx) },
    { name: 'rova_release_tracking', tool: registerReleaseTracking(server, ctx) },
    { name: 'rova_get_release', tool: registerGetRelease(server, ctx) },
    { name: 'rova_get_milestone', tool: registerGetMilestone(server, ctx) },
    { name: 'rova_project_health', tool: registerProjectHealth(server, ctx) },
    { name: 'rova_work_item_code_changes', tool: registerWorkItemCodeChanges(server, ctx) },
    { name: 'rova_list_teams', tool: registerListTeams(server, ctx) },
    { name: 'rova_list_notifications', tool: registerListNotifications(server, ctx) },
  ];
  if (observe) {
    for (const { name, tool } of mounted) {
      // The SDK's handler is a union (a plain callback or a task handler); the wrapper is a
      // plain callback and is what this catalogue registers everywhere.
      tool.update({
        callback: instrumentToolHandler(
          name,
          ctx.principal.userId,
          tool.handler as (...args: unknown[]) => Promise<unknown>,
          observe,
        ) as unknown as NonNullable<Parameters<RegisteredTool['update']>[0]['callback']>,
      });
    }
  }
  return mounted;
}
