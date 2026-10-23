import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGetWorkItem } from './get_work_item';
import { registerListComments } from './list_comments';
import { registerListIterations } from './list_iterations';
import { registerListProjects } from './list_projects';
import { registerMyWork } from './my_work';
import { registerSearchWorkItems } from './search_work_items';
import { registerWhoami } from './whoami';
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
    { name: 'search_work_items', tool: registerSearchWorkItems(server, ctx) },
    { name: 'my_work', tool: registerMyWork(server, ctx) },
    { name: 'list_iterations', tool: registerListIterations(server, ctx) },
    { name: 'list_comments', tool: registerListComments(server, ctx) },
    { name: 'get_work_item', tool: registerGetWorkItem(server, ctx) },
  ];
}
