import type { McpRestCall, McpRestResult, ToolContext } from './rest';
import { pathSegment } from './rest';
import { resolvePortfolioItem, resolveWorkItem, type Lookup, type LookupFailure } from './lookups';

/** The kinds §5 of the MCP v2 design allows a chat user to delete, and nothing else. */
export type DeleteKind = 'comment' | 'time_log' | 'relation' | 'test_result' | 'task' | 'work_item';

export const DELETE_KINDS = [
  'comment',
  'time_log',
  'relation',
  'test_result',
  'task',
  'work_item',
] as const;

/** What the tool needs to perform exactly one REST delete, and what to echo back. */
export interface DeletePlan {
  ok: true;
  kind: DeleteKind;
  path: string;
  targetId: string;
  /** The subject key/id the caller named, echoed so the result is self-contained. */
  subject: string;
  /** A consequence of the delete the caller must see (currently only a parent auto-complete). */
  warning?: string;
}

export type DeleteRefusal = LookupFailure;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;
const TEST_RESULT_MAX_AGE_MS = 7 * DAY_MS;

/** A full work-item record (the detail's `item`), not the narrow lookup projection. */
async function fetchItem(
  ctx: ToolContext,
  reference: string,
): Promise<Lookup<{ ok: true } & Record<string, unknown>>> {
  const res = UUID.test(reference.trim())
    ? await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: `/v1/work-items/${pathSegment(reference.trim())}`,
      })
    : await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/work-items/by-key',
        query: { itemKey: reference.trim() },
      });
  if (res.statusCode >= 400) {
    return { ok: false, statusCode: res.statusCode, json: res.json };
  }
  const body = res.json as Record<string, unknown> | null;
  const item = body?.['item'] as Record<string, unknown> | undefined;
  if (!item || typeof item['id'] !== 'string') {
    return { ok: false, message: `No work item matches "${reference}".` };
  }
  return { ok: true, ...item };
}

/** Rows of a bare-array or paged REST answer, or a refusal to relay. */
function rowsOf(json: unknown): Record<string, unknown>[] | null {
  const body = Array.isArray(json)
    ? json
    : ((json as { data?: unknown; items?: unknown } | null)?.data ??
      (json as { items?: unknown } | null)?.items);
  return Array.isArray(body) ? (body as Record<string, unknown>[]) : null;
}

/** Reads a collection the guard needs, relaying a refusal instead of guessing. */
async function readRows(
  ctx: ToolContext,
  call: McpRestCall,
): Promise<Lookup<{ ok: true; rows: Record<string, unknown>[] }>> {
  const res: McpRestResult = await ctx.callRest(ctx.principal, call);
  if (res.statusCode >= 400) {
    return { ok: false, statusCode: res.statusCode, json: res.json };
  }
  const rows = rowsOf(res.json);
  if (!rows) {
    return { ok: false, message: `Unexpected response from ${call.url}.` };
  }
  return { ok: true, rows };
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/**
 * The §5 guard: every condition is checked BEFORE the REST delete, and each refusal says what is
 * holding the record. On TOCTOU the REST rules still hold — this only ever NARROWS what a chat
 * user may do, never widens it.
 */
export async function planDelete(
  ctx: ToolContext,
  args: { kind: DeleteKind; key?: string; id?: string },
): Promise<DeletePlan | DeleteRefusal> {
  const me = ctx.principal.userId;
  const key = args.key?.trim();
  const id = args.id?.trim();

  if (args.kind === 'comment') {
    if (!key || !id)
      return { ok: false, message: 'comment needs key (the item) and id (the comment).' };
    const subject = await resolveAnyItem(ctx, key);
    if (!subject.ok) return subject;
    const comments = await readRows(ctx, {
      method: 'GET',
      url: subject.commentsPath,
    });
    if (!comments.ok) return comments;
    const comment = comments.rows.find((row) => str(row['id']) === id);
    if (!comment) {
      return { ok: false, message: `No comment ${id} on ${key}.` };
    }
    if (str(comment['authorId']) !== me) {
      return {
        ok: false,
        message: "You can only delete your own comment; this one is someone else's.",
      };
    }
    return {
      ok: true,
      kind: 'comment',
      path: `${subject.basePath}/comments/${pathSegment(id)}`,
      targetId: id,
      subject: key,
    };
  }

  if (args.kind === 'time_log') {
    if (!key || !id)
      return { ok: false, message: 'time_log needs key (the work item) and id (the log).' };
    const item = await resolveWorkItem(ctx, key);
    if (!item.ok) return item;
    const logs = await readRows(ctx, {
      method: 'GET',
      url: `/v1/work-items/${pathSegment(item.id)}/time-logs`,
      query: { page: 1, pageSize: 100 },
    });
    if (!logs.ok) return logs;
    const log = logs.rows.find((row) => str(row['id']) === id);
    if (!log) return { ok: false, message: `No time log ${id} on ${key}.` };
    if (str(log['userId']) !== me) {
      return { ok: false, message: 'You can only delete your own time log.' };
    }
    return {
      ok: true,
      kind: 'time_log',
      path: `/v1/work-items/${pathSegment(item.id)}/time-logs/${pathSegment(id)}`,
      targetId: id,
      subject: key,
    };
  }

  if (args.kind === 'relation') {
    if (!key || !id)
      return { ok: false, message: 'relation needs key (the work item) and id (the relation).' };
    const item = await resolveWorkItem(ctx, key);
    if (!item.ok) return item;
    const relations = await readRows(ctx, {
      method: 'GET',
      url: `/v1/work-items/${pathSegment(item.id)}/relations`,
    });
    if (!relations.ok) return relations;
    const relation = relations.rows.find((row) => str(row['id']) === id);
    if (!relation) return { ok: false, message: `No relation ${id} touches ${key}.` };
    return {
      ok: true,
      kind: 'relation',
      path: `/v1/work-items/${pathSegment(item.id)}/relations/${pathSegment(id)}`,
      targetId: id,
      subject: key,
    };
  }

  if (args.kind === 'test_result') {
    if (!key || !id) {
      return {
        ok: false,
        message: 'test_result needs key (the test case, e.g. TC-12) and id (the result).',
      };
    }
    const testCase = await resolveTestCaseForDelete(ctx, key);
    if (!testCase.ok) return testCase;
    const results = await readRows(ctx, {
      method: 'GET',
      url: `/v1/test-cases/${pathSegment(testCase.id)}/test-results`,
    });
    if (!results.ok) return results;
    const result = results.rows.find((row) => str(row['id']) === id);
    if (!result) return { ok: false, message: `No result ${id} on ${key}.` };
    const mine = str(result['createdBy']) === me || str(result['testerId']) === me;
    if (!mine) {
      return { ok: false, message: 'You can only delete a result you recorded or tested.' };
    }
    const createdAt = Date.parse(str(result['createdAt']) ?? '');
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > TEST_RESULT_MAX_AGE_MS) {
      return { ok: false, message: 'That result is more than 7 days old; use the web.' };
    }
    return {
      ok: true,
      kind: 'test_result',
      path: `/v1/test-results/${pathSegment(id)}`,
      targetId: id,
      subject: key,
    };
  }

  if (!key) return { ok: false, message: `${args.kind} needs the work item key.` };
  if (id !== undefined) {
    return { ok: false, message: `${args.kind} is identified by key alone; omit id.` };
  }

  const item = await fetchItem(ctx, key);
  if (!item.ok) return item;
  const itemId = String(item['id']);
  const type = str(item['type']);

  if (args.kind === 'task') {
    if (type !== 'task') {
      return { ok: false, message: `${key} is a ${type ?? 'work item'}, not a task.` };
    }
    if (str(item['createdBy']) !== me && str(item['assigneeId']) !== me) {
      return { ok: false, message: 'A task may be deleted only by its creator or its owner.' };
    }

    const logs = await readRows(ctx, {
      method: 'GET',
      url: `/v1/work-items/${pathSegment(itemId)}/time-logs`,
      query: { page: 1, pageSize: 100 },
    });
    if (!logs.ok) return logs;
    const foreignLog = logs.rows.find((row) => str(row['userId']) !== me);
    if (foreignLog) {
      return {
        ok: false,
        message: `${key} carries time logged by someone else; use the web.`,
      };
    }

    const warning = await parentAutoCompleteWarning(ctx, item);
    if (typeof warning === 'object') return warning;
    return {
      ok: true,
      kind: 'task',
      path: `/v1/work-items/${pathSegment(itemId)}`,
      targetId: itemId,
      subject: key,
      ...(warning ? { warning } : {}),
    };
  }

  // kind === 'work_item': the strict "a duplicate I just created" case.
  if (type !== 'story' && type !== 'defect') {
    return {
      ok: false,
      message: `${key} is a ${type ?? 'work item'}; only a story or defect may use this kind.`,
    };
  }
  if (str(item['createdBy']) !== me) {
    return { ok: false, message: 'You can only delete a story/defect you created.' };
  }
  const createdAt = Date.parse(str(item['createdAt']) ?? '');
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > DAY_MS) {
    return {
      ok: false,
      message: 'A story/defect may be deleted only within 24 hours of creation; use the web.',
    };
  }

  const [tasks, testCases, timeLogs, comments, relations] = await Promise.all([
    readRows(ctx, { method: 'GET', url: `/v1/work-items/${pathSegment(itemId)}/tasks` }),
    readRows(ctx, {
      method: 'GET',
      url: `/v1/work-items/${pathSegment(itemId)}/test-cases`,
      query: { limit: 1 },
    }),
    readRows(ctx, {
      method: 'GET',
      url: `/v1/work-items/${pathSegment(itemId)}/time-logs`,
      query: { page: 1, pageSize: 1 },
    }),
    readRows(ctx, { method: 'GET', url: `/v1/work-items/${pathSegment(itemId)}/comments` }),
    readRows(ctx, { method: 'GET', url: `/v1/work-items/${pathSegment(itemId)}/relations` }),
  ]);
  for (const feed of [tasks, testCases, timeLogs, comments, relations]) {
    if (!feed.ok) return feed;
  }
  if (tasks.ok && tasks.rows.length > 0) {
    return { ok: false, message: `${key} has tasks; use the web.` };
  }
  if (testCases.ok && testCases.rows.length > 0) {
    return { ok: false, message: `${key} has test cases; use the web.` };
  }
  if (timeLogs.ok && timeLogs.rows.length > 0) {
    return { ok: false, message: `${key} has time logs; use the web.` };
  }
  const foreignComment = comments.ok
    ? comments.rows.find((row) => str(row['authorId']) !== me)
    : undefined;
  if (foreignComment) {
    return { ok: false, message: `${key} has comments by other people; use the web.` };
  }
  if (relations.ok && relations.rows.length > 0) {
    return { ok: false, message: `${key} is linked to other items; use the web.` };
  }

  const iterationId = str(item['iterationId']);
  if (iterationId) {
    const state = await iterationState(ctx, str(item['projectId']) ?? '', iterationId);
    if (!state.ok) return state;
    if (state.state === 'committed' || state.state === 'accepted') {
      return {
        ok: false,
        message: `${key} is in a ${state.state} iteration; use the web.`,
      };
    }
  }

  return {
    ok: true,
    kind: 'work_item',
    path: `/v1/work-items/${pathSegment(itemId)}`,
    targetId: itemId,
    subject: key,
  };
}

/** A work-item or portfolio-item subject, with the path its comments hang from. */
async function resolveAnyItem(
  ctx: ToolContext,
  key: string,
): Promise<Lookup<{ ok: true; basePath: string; commentsPath: string }>> {
  if (/^(EP|FE)[-_]/i.test(key)) {
    const portfolio = await resolvePortfolioItem(ctx, key);
    if (!portfolio.ok) return portfolio;
    return {
      ok: true,
      basePath: `/v1/portfolio-items/${pathSegment(portfolio.id)}`,
      commentsPath: `/v1/portfolio-items/${pathSegment(portfolio.id)}/comments`,
    };
  }
  const item = await resolveWorkItem(ctx, key);
  if (!item.ok) return item;
  return {
    ok: true,
    basePath: `/v1/work-items/${pathSegment(item.id)}`,
    commentsPath: `/v1/work-items/${pathSegment(item.id)}/comments`,
  };
}

/** A test case by key (`GET /v1/test-cases/by-key/:key`). */
async function resolveTestCaseForDelete(
  ctx: ToolContext,
  key: string,
): Promise<Lookup<{ ok: true; id: string }>> {
  const res = await ctx.callRest(ctx.principal, {
    method: 'GET',
    url: `/v1/test-cases/by-key/${pathSegment(key)}`,
  });
  if (res.statusCode >= 400) {
    return { ok: false, statusCode: res.statusCode, json: res.json };
  }
  const id = str((res.json as Record<string, unknown> | null)?.['id']);
  if (!id) return { ok: false, message: `No test case matches "${key}".` };
  return { ok: true, id };
}

/** The iteration's state, from the reference feed an Editor can read (`iteration:view`). */
async function iterationState(
  ctx: ToolContext,
  projectId: string,
  iterationId: string,
): Promise<Lookup<{ ok: true; state: string | null }>> {
  const res = await ctx.callRest(ctx.principal, {
    method: 'GET',
    url: '/v1/iterations/options',
    query: { projectId },
  });
  if (res.statusCode >= 400) {
    return { ok: false, statusCode: res.statusCode, json: res.json };
  }
  const rows = rowsOf(res.json) ?? [];
  const row = rows.find((candidate) => str(candidate['id']) === iterationId);
  if (!row) {
    return { ok: false, message: 'Could not confirm the item iteration; use the web.' };
  }
  return { ok: true, state: str(row['state']) ?? null };
}

/**
 * Deleting a task reconciles the parent from its remaining task set. When every OTHER task is
 * already Completed, this delete completes the parent too — a consequence worth saying out loud.
 * No other task at all is NOT that case: `reconcileParentScheduleState` leaves a parent with no
 * live tasks untouched.
 */
async function parentAutoCompleteWarning(
  ctx: ToolContext,
  item: Record<string, unknown>,
): Promise<string | undefined | DeleteRefusal> {
  const parentId = str(item['parentId']);
  if (!parentId) return undefined;
  const siblings = await readRows(ctx, {
    method: 'GET',
    url: `/v1/work-items/${pathSegment(parentId)}/tasks`,
  });
  if (!siblings.ok) return siblings;
  const others = siblings.rows.filter((row) => String(row['id']) !== String(item['id']));
  if (others.length === 0) return undefined;
  const allCompleted = others.every((row) => str(row['scheduleState']) === 'Completed');
  return allCompleted
    ? 'This is the parent’s last open task: deleting it will mark the parent Completed.'
    : undefined;
}
