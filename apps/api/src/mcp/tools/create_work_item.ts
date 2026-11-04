import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, replayedFrom, toolError, type ToolContext } from './rest';
import {
  failureResult,
  resolvePeople,
  resolvePortfolioItem,
  resolveProject,
  resolveRelease,
  resolveTeam,
  resolveIteration,
  resolveWorkItem,
} from './lookups';
import { workItemWriteResult } from './work_item_write';

/**
 * `rova_create_work_item` — create a story or a defect in one project (W1). Child tasks have
 * their own tool (`rova_add_task`) and are refused here, so the two shapes never drift.
 *
 * Every human reference is resolved through the app's own feeds with the caller's principal
 * (project, people, teams, iterations, releases, features), so a name only resolves to something
 * the person can already see. The server still enforces every rule: the team scope, the release
 * field guard, the parent-type rule and the assignment scope all run on `POST /v1/work-items`.
 */
export function registerCreateWorkItem(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_create_work_item',
    {
      title: 'Create work item',
      description:
        "WRITES a new story or defect as you, and must be used only on the user's explicit request; confirm the project, type and title with the user first. Names (project, team, iteration, release, feature, assignee) are resolved against what you can see — an unknown or ambiguous name comes back with candidates. An identical request within 10 minutes returns the first result (`replayed: true`).",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        project: z.string().min(1).max(255).describe('Project key, exact name or id'),
        type: z.enum(['story', 'defect']).describe('story (User Story) or defect'),
        title: z.string().min(1).max(500).describe('The item title'),
        description: z.string().max(50_000).optional(),
        acceptanceCriteria: z.string().max(50_000).optional(),
        assignee: z.string().min(1).max(255).optional().describe('Owner by display name or email'),
        team: z.string().min(1).max(255).optional().describe('Team by name or key (active link)'),
        iteration: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe('Iteration by name or key in the project'),
        release: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe('Release by name or key in the project'),
        feature: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe('Feature (Epic/Feature key) this item rolls up to'),
        parentStory: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe('For a defect only: the parent Story key (e.g. US-412)'),
        storyPoints: z.number().min(0).max(100).optional(),
        priority: z
          .string()
          .min(1)
          .max(32)
          .optional()
          .describe('Defect priority: none|low|normal|high|urgent'),
        severity: z
          .string()
          .min(1)
          .max(32)
          .optional()
          .describe('Defect severity: critical|major|minor|trivial|none'),
        foundInEnvironment: z
          .string()
          .min(1)
          .max(32)
          .optional()
          .describe('Defect environment: development|staging|production|testing'),
        foundInRelease: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe('Defect: the release it was found in, by name or key'),
      },
    },
    async (args) => {
      if (!ctx.idempotencyKey) return toolError('Writes are not enabled on this endpoint.');

      const project = await resolveProject(ctx, args.project);
      if (!project.ok) return failureResult(project);

      const body: Record<string, unknown> = {
        projectId: project.id,
        type: args.type,
        title: args.title,
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.acceptanceCriteria !== undefined
          ? { acceptanceCriteria: args.acceptanceCriteria }
          : {}),
      };

      if (args.assignee !== undefined) {
        const people = await resolvePeople(ctx, project.id, [args.assignee]);
        if (!people.ok) return failureResult(people);
        body['assigneeId'] = people.ids[0];
      }
      if (args.team !== undefined) {
        const team = await resolveTeam(ctx, project.id, args.team);
        if (!team.ok) return failureResult(team);
        body['teamId'] = team.id;
      }
      if (args.iteration !== undefined) {
        const iteration = await resolveIteration(ctx, project.id, args.iteration);
        if (!iteration.ok) return failureResult(iteration);
        body['iterationId'] = iteration.id;
      }
      if (args.release !== undefined) {
        const release = await resolveRelease(ctx, project.id, args.release);
        if (!release.ok) return failureResult(release);
        body['releaseId'] = release.id;
      }
      if (args.feature !== undefined) {
        const feature = await resolvePortfolioItem(ctx, args.feature);
        if (!feature.ok) return failureResult(feature);
        if (feature.type !== null && feature.type !== 'feature') {
          return toolError(
            `"${args.feature}" is a ${feature.type}; a work item can only roll up to a Feature.`,
          );
        }
        if (feature.projectId !== project.id) {
          return toolError(
            `"${args.feature}" belongs to another project; a work item may only roll up to a Feature in its own project.`,
          );
        }
        body['featureId'] = feature.id;
      }
      if (args.parentStory !== undefined) {
        if (args.type !== 'defect') {
          return toolError('parentStory is only valid for a defect.');
        }
        const parent = await resolveWorkItem(ctx, args.parentStory);
        if (!parent.ok) return failureResult(parent);
        if (parent.type !== 'story') {
          return toolError(
            `"${args.parentStory}" is a ${parent.type}; a defect's parent must be a story.`,
          );
        }
        body['parentId'] = parent.id;
      }
      if (args.storyPoints !== undefined) body['storyPoints'] = args.storyPoints;
      if (args.priority !== undefined) body['priority'] = args.priority;
      if (args.severity !== undefined) body['severity'] = args.severity;
      if (args.foundInEnvironment !== undefined)
        body['foundInEnvironment'] = args.foundInEnvironment;
      if (args.foundInRelease !== undefined) {
        const found = await resolveRelease(ctx, project.id, args.foundInRelease);
        if (!found.ok) return failureResult(found);
        body['foundInReleaseId'] = found.id;
      }

      const idempotencyKey = ctx.idempotencyKey('rova_create_work_item', args);
      const res = await ctx.callRest(ctx.principal, {
        method: 'POST',
        url: '/v1/work-items',
        body,
        idempotencyKey,
      });
      if (res.statusCode >= 400) return denied(res.statusCode, res.json);
      return workItemWriteResult(
        res,
        Object.keys(body).filter((field) => !['projectId', 'type', 'title'].includes(field)),
        { replayed: replayedFrom(res) },
      );
    },
  );
}
