import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, pathSegment, result, toolError, type ToolContext } from './rest';
import { failureResult, resolvePeople, resolvePortfolioItem, resolveWorkItem } from './lookups';

/**
 * `rova_add_comment` — comment on a work item or a portfolio item (W8). Exactly one subject;
 * a reply uses `replyTo` (the parent comment's id), and `mention` names people (display name or
 * email) resolved to the workspace ids the API's mention fan-out needs. The comment carries the
 * caller as author; @mention notifications fire exactly as they do from the web.
 */
export function registerAddComment(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_add_comment',
    {
      title: 'Add comment',
      description:
        "WRITES a comment on one work item (key/id) or portfolio item (key) as you; @mentions notify the named people. Use only on the user's explicit request.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        workItemKey: z.string().min(1).max(64).optional().describe('The work item key or id'),
        portfolioItemKey: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe('The Epic/Feature key (e.g. F-12)'),
        body: z.string().min(1).max(50_000).describe('The comment text (plain text/Markdown)'),
        replyTo: z.uuid().optional().describe('Parent comment id, for a reply'),
        mention: z
          .array(z.string().min(1).max(255))
          .max(50)
          .optional()
          .describe('People to @mention, by display name or email'),
      },
    },
    async ({ workItemKey, portfolioItemKey, body, replyTo, mention }) => {
      if ((workItemKey === undefined) === (portfolioItemKey === undefined)) {
        return toolError('Pass exactly one of workItemKey or portfolioItemKey.');
      }
      let url: string;
      let subject: Record<string, unknown>;
      let projectId: string;
      if (workItemKey !== undefined) {
        const item = await resolveWorkItem(ctx, workItemKey);
        if (!item.ok) return failureResult(item);
        url = `/v1/work-items/${pathSegment(item.id)}/comments`;
        subject = { workItemId: item.id, itemKey: item.itemKey };
        projectId = item.projectId;
      } else {
        const item = await resolvePortfolioItem(ctx, portfolioItemKey as string);
        if (!item.ok) return failureResult(item);
        url = `/v1/portfolio-items/${pathSegment(item.id)}/comments`;
        subject = { portfolioItemId: item.id, itemKey: item.itemKey };
        projectId = item.projectId;
      }

      let mentionedUserIds: string[] | undefined;
      if (mention && mention.length > 0) {
        const people = await resolvePeople(ctx, projectId, mention);
        if (!people.ok) return failureResult(people);
        mentionedUserIds = people.ids;
      }

      if (!ctx.idempotencyKey) return toolError('Writes are not enabled on this endpoint.');
      const idempotencyKey = ctx.idempotencyKey('rova_add_comment', {
        workItemKey,
        portfolioItemKey,
        body,
        replyTo,
        mention,
      });
      const res = await ctx.callRest(ctx.principal, {
        method: 'POST',
        url,
        body: {
          body,
          ...(replyTo !== undefined ? { parentId: replyTo } : {}),
          ...(mentionedUserIds !== undefined && mentionedUserIds.length > 0
            ? { mentionedUserIds }
            : {}),
        },
        idempotencyKey,
      });
      if (res.statusCode >= 400 || res.json === null || typeof res.json !== 'object') {
        return denied(res.statusCode, res.json);
      }
      const c = res.json as Record<string, unknown>;
      const subjectId =
        typeof subject['workItemId'] === 'string'
          ? subject['workItemId']
          : typeof subject['portfolioItemId'] === 'string'
            ? subject['portfolioItemId']
            : undefined;
      ctx.noteWrite?.({
        ...(subjectId !== undefined ? { targets: [subjectId] } : {}),
        fields: ['body'],
        count: 1,
      });
      return result(res.statusCode, res.json, {
        subject,
        comment: {
          id: c['id'],
          authorId: c['authorId'],
          parentId: c['parentId'] ?? null,
          body: c['body'],
          isEdited: c['isEdited'],
          createdAt: c['createdAt'],
        },
        changed: ['body'],
      });
    },
  );
}
