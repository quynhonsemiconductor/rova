import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, pathSegment, toolError, type ToolContext } from './rest';
import { createRefResolver, type PersonRef } from './refs';
import { resolvePortfolioItem } from './lookups';

/** The REST comments route is unpaginated, so the tool caps the feed itself. */
const MAX_COMMENTS = 100;
const MAX_BODY_CHARS = 4_000;

/**
 * Sorts newest-first, caps to 100, truncates long bodies (flagging it), and maps the
 * CommentResponseDto fields an agent acts on.
 */
export function shapeComments(all: Record<string, unknown>[]) {
  const sorted = [...all].sort((a, b) =>
    String(b['createdAt']).localeCompare(String(a['createdAt'])),
  );
  const capped = sorted.slice(0, MAX_COMMENTS);
  let truncated = sorted.length > MAX_COMMENTS;
  const comments = capped.map((c) => {
    const body = c['body'];
    if (typeof body === 'string' && body.length > MAX_BODY_CHARS) {
      truncated = true;
      c['body'] = `${body.slice(0, MAX_BODY_CHARS)}…`;
    }
    return {
      id: c['id'],
      authorId: c['authorId'],
      parentId: c['parentId'] ?? null,
      body: c['body'],
      isEdited: c['isEdited'],
      editedAt: c['editedAt'] ?? null,
      createdAt: c['createdAt'],
    };
  });
  return { truncated, comments };
}

/**
 * Replaces each comment's `authorId` with `author: { id, name }`. One workspace picker feed
 * serves the whole page, and a person the feed does not name degrades to `{ id, name: null }`.
 */
export async function attachCommentAuthors(
  comments: Record<string, unknown>[],
  resolver: ReturnType<typeof createRefResolver>,
): Promise<Record<string, unknown>[]> {
  const ids = [
    ...new Set(comments.map((c) => c['authorId']).filter((id) => typeof id === 'string')),
  ];
  const people = new Map<string, PersonRef | null>(
    await Promise.all(ids.map(async (id) => [id, await resolver.person(id)] as const)),
  );
  return comments.map((c) => {
    const { authorId, ...rest } = c;
    return { ...rest, author: people.get(String(authorId)) ?? null };
  });
}

/**
 * `rova_list_comments` — the comments on one work item OR portfolio item. The routes return ALL
 * of a subject's comments (no page args, no ordering guarantee), so the tool sorts newest-first,
 * caps to 100, truncates bodies, and sets `truncated`. Exactly one subject argument is required;
 * a portfolio item is named by its KEY and resolved through the app's own list.
 */
export function registerListComments(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_list_comments',
    {
      title: 'List comments',
      description:
        'The comments on one work item (id) or portfolio item (key) you can read — newest first, capped at 100.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        workItemId: z.uuid().optional().describe('The work item whose comments to list'),
        portfolioItemKey: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe('The Epic/Feature key whose comments to list (e.g. F-12)'),
      },
    },
    async ({ workItemId, portfolioItemKey }) => {
      if ((workItemId === undefined) === (portfolioItemKey === undefined)) {
        return toolError('Pass exactly one of workItemId or portfolioItemKey.');
      }
      let url: string;
      if (workItemId !== undefined) {
        url = `/v1/work-items/${pathSegment(workItemId)}/comments`;
      } else {
        const portfolio = await resolvePortfolioItem(ctx, portfolioItemKey as string);
        if (!portfolio.ok) return toolError(portfolio.message);
        url = `/v1/portfolio-items/${pathSegment(portfolio.id)}/comments`;
      }
      const { statusCode, json } = await ctx.callRest(ctx.principal, { method: 'GET', url });
      if (statusCode >= 400 || !Array.isArray(json)) return denied(statusCode, json);
      const { truncated, comments } = shapeComments(json as Record<string, unknown>[]);
      const payload: Record<string, unknown> = {
        comments: await attachCommentAuthors(comments, createRefResolver(ctx)),
      };
      if (truncated) payload['truncated'] = true;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
      };
    },
  );
}
