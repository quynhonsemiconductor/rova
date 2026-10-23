import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGetWorkItem } from './get_work_item';
import { registerListComments } from './list_comments';
import { registerListIterations } from './list_iterations';
import { registerListProjects } from './list_projects';
import { registerMyWork } from './my_work';
import { registerSearchWorkItems } from './search_work_items';
import { registerWhoami } from './whoami';
import type { ToolContext } from './rest';

/** Mounts the P1 read-only catalogue on a fresh per-request server. */
export function registerTools(server: McpServer, ctx: ToolContext): void {
  registerWhoami(server, ctx);
  registerListProjects(server, ctx);
  registerSearchWorkItems(server, ctx);
  registerMyWork(server, ctx);
  registerListIterations(server, ctx);
  registerListComments(server, ctx);
  registerGetWorkItem(server, ctx);
}
