import {
  denied,
  pathSegment,
  responseEtag,
  toolError,
  type McpRestResult,
  type ToolContext,
} from './rest';

/**
 * Human-reference resolution for tools that take a KEY/NAME where the REST route takes a UUID
 * (MCP v2 design §4: "args take human references … never guess"). These helpers read the app's
 * own list/picker routes with the caller's principal, so a reference resolves only to something
 * the person can already see. Three outcomes: the value; a MESSAGE with candidates (nothing
 * matched, or a name is ambiguous); or a REST DENIAL relayed unchanged — the same 403 body the
 * web receives, never a paraphrase that loses the code.
 */

export interface ResolvedProject {
  ok: true;
  id: string;
  key: string;
  name: string;
}

export interface ResolvedWorkItem {
  ok: true;
  id: string;
  itemKey: string;
  title: string;
  type: string;
  version: number;
  projectId: string;
  /** The item's current timeboxes, for a plan PREVIEW (read from the same record). */
  iterationId: string | null;
  releaseId: string | null;
}

export interface ResolvedPortfolioItem {
  ok: true;
  id: string;
  itemKey: string;
  name: string;
  projectId: string;
  /** `epic` | `feature` when the feed says; a Feature is the only valid work-item link. */
  type: string | null;
}

export interface ResolvedTestCase {
  ok: true;
  id: string;
  testCaseKey: string;
  name: string;
}

/** A reference that did not resolve: a candidate message, or the REST refusal to relay. */
export type LookupFailure =
  { ok: false; message: string } | { ok: false; statusCode: number; json: unknown };

export type Lookup<T> = T | LookupFailure;

/** True when a failure is a REST denial to relay, not a message to render. */
export function isDenial(
  failure: LookupFailure,
): failure is { ok: false; statusCode: number; json: unknown } {
  return 'statusCode' in failure;
}

/** The tool result for a failed lookup: relay the REST refusal, or render the candidate message. */
export function failureResult(failure: LookupFailure) {
  return isDenial(failure) ? denied(failure.statusCode, failure.json) : toolError(failure.message);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A page loop stops here: a reference that needs 10 pages of pickers is not a human reference. */
const MAX_PAGES = 10;

function rowsOf(json: unknown): Record<string, unknown>[] | null {
  const body = Array.isArray(json) ? json : (json as { data?: unknown } | null)?.data;
  return Array.isArray(body) ? (body as Record<string, unknown>[]) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The strong ETag a work-item response carries: `"<version>"` → the integer. */
function versionOfEtag(res: McpRestResult, fallback: unknown): number {
  const etag = responseEtag(res);
  const match = etag ? /"(0|[1-9][0-9]*)"/.exec(etag) : null;
  if (match) return Number(match[1]);
  return typeof fallback === 'number' ? fallback : -1;
}

/** Reads every page of a `{ data, pageInfo }` list, capped at {@link MAX_PAGES}. */
async function collectPaged(
  ctx: ToolContext,
  url: string,
  query: Record<string, string | number | undefined>,
): Promise<{ rows: Record<string, unknown>[] | null; failure?: LookupFailure }> {
  const rows: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await ctx.callRest(ctx.principal, {
      method: 'GET',
      url,
      query: { ...query, ...(cursor ? { cursor } : {}) },
    });
    if (res.statusCode >= 400) {
      return { rows: null, failure: { ok: false, statusCode: res.statusCode, json: res.json } };
    }
    const pageRows = rowsOf(res.json);
    if (!pageRows) {
      return { rows: null, failure: { ok: false, message: `Unexpected response from ${url}.` } };
    }
    rows.push(...pageRows);
    // The platform's PageInfo contract (libs/platform/src/http/pagination.ts) is
    // `{ nextCursor, hasNextPage, limit, total? }` — NOT `cursor`.
    const info = (res.json as { pageInfo?: { hasNextPage?: unknown; nextCursor?: unknown } } | null)
      ?.pageInfo;
    const next = typeof info?.nextCursor === 'string' ? info.nextCursor : undefined;
    if (info?.hasNextPage !== true || !next) return { rows };
    cursor = next;
  }
  return { rows };
}

/** A project by id, key (case-insensitive) or exact name, among the projects the caller can read. */
export async function resolveProject(
  ctx: ToolContext,
  reference: string,
): Promise<Lookup<ResolvedProject>> {
  const { rows, failure } = await collectPaged(ctx, '/v1/projects', { limit: 100 });
  if (failure) return failure;
  const all = rows ?? [];
  const wanted = reference.trim();
  const byId = all.find((p) => str(p['id']) === wanted);
  const byKey = all.filter((p) => str(p['key'])?.toLowerCase() === wanted.toLowerCase());
  const byName = all.filter((p) => str(p['name'])?.toLowerCase() === wanted.toLowerCase());
  const candidates = (list: Record<string, unknown>[]) =>
    list.slice(0, 20).map((p) => `${str(p['key'])} (${str(p['name'])})`);

  const toResolved = (p: Record<string, unknown> | undefined): ResolvedProject => ({
    ok: true,
    id: String(p?.['id']),
    key: str(p?.['key']) ?? '',
    name: str(p?.['name']) ?? '',
  });

  if (byId) return toResolved(byId);
  if (byKey.length === 1) return toResolved(byKey[0]);
  // An exact NAME may be shared by two projects (the key is the unique identity). Never pick the
  // first: list the matches and make the caller say which.
  if (byName.length === 1) return toResolved(byName[0]);
  if (byName.length > 1) {
    return {
      ok: false,
      message: `"${reference}" matches ${byName.length} projects: ${candidates(byName).join(', ')}. Use the project key.`,
    };
  }
  return {
    ok: false,
    message: `No project matches "${reference}". Candidates: ${candidates(all).join(', ') || 'none'}.`,
  };
}

/** A work item by UUID or by its human key (e.g. US-412), with its current version (the ETag). */
export async function resolveWorkItem(
  ctx: ToolContext,
  reference: string,
): Promise<Lookup<ResolvedWorkItem>> {
  const ref = reference.trim();
  const res = UUID.test(ref)
    ? await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: `/v1/work-items/${pathSegment(ref)}`,
      })
    : await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/work-items/by-key',
        query: { itemKey: ref },
      });
  if (res.statusCode >= 400) {
    // The caller's own refusal (403/404) relays as the REST body — the same code the web sees.
    return { ok: false, statusCode: res.statusCode, json: res.json };
  }
  if (res.json === null || typeof res.json !== 'object') {
    return { ok: false, message: `No work item matches "${reference}".` };
  }
  const row = res.json as Record<string, unknown>;
  const item = (row['item'] as Record<string, unknown> | undefined) ?? row;
  const id = str(item['id']);
  if (!id) return { ok: false, message: `No work item matches "${reference}".` };
  return {
    ok: true,
    id,
    itemKey: str(item['itemKey']) ?? '',
    title: str(item['title']) ?? '',
    type: str(item['type']) ?? '',
    version: versionOfEtag(res, item['version']),
    projectId: str(item['projectId']) ?? '',
    iterationId: str(item['iterationId']),
    releaseId: str(item['releaseId']),
  };
}

/**
 * A portfolio item (Epic/Feature) by key. There is no by-key route: the list is searched by the
 * key text for the type the prefix implies (EP-… epic, otherwise feature), every page followed,
 * then matched exactly.
 */
export async function resolvePortfolioItem(
  ctx: ToolContext,
  reference: string,
): Promise<Lookup<ResolvedPortfolioItem>> {
  const ref = reference.trim();
  const types: Array<'epic' | 'feature'> = /^EP[-_]/i.test(ref)
    ? ['epic', 'feature']
    : ['feature', 'epic'];
  const seen: string[] = [];
  for (const type of types) {
    const { rows, failure } = await collectPaged(ctx, '/v1/portfolio-items', {
      type,
      search: ref,
      limit: 50,
    });
    if (failure) return failure;
    for (const row of rows ?? []) {
      const itemKey = str(row['itemKey']);
      if (itemKey) seen.push(itemKey);
      if (itemKey === ref) {
        const id = String(row['id']);
        let projectId = str(row['projectId']) ?? '';
        if (!projectId) {
          // The list row normally carries projectId; a feed that does not gets one record read.
          const detail = await ctx.callRest(ctx.principal, {
            method: 'GET',
            url: `/v1/portfolio-items/${pathSegment(id)}`,
          });
          if (detail.statusCode >= 400) {
            return { ok: false, statusCode: detail.statusCode, json: detail.json };
          }
          projectId = str((detail.json as Record<string, unknown> | null)?.['projectId']) ?? '';
        }
        return {
          ok: true,
          id,
          itemKey,
          name: str(row['name']) ?? '',
          projectId,
          type: str(row['type']),
        };
      }
    }
  }
  return {
    ok: false,
    message: `No portfolio item matches "${reference}". Candidates: ${seen.slice(0, 20).join(', ') || 'none'}.`,
  };
}

export interface ResolvedPeople {
  ok: true;
  ids: string[];
}

/**
 * People by display name or email, from the caller's OWN workspace picker feed (`member-options`,
 * scoped to the projects they can read). An unknown reference lists the candidates; an ambiguous
 * one names every match — a mention must never go to the wrong person.
 */
export async function resolvePeople(
  ctx: ToolContext,
  projectId: string,
  references: string[],
): Promise<Lookup<ResolvedPeople>> {
  // PROJECT-scoped, not the workspace directory: a mention may only name someone who can own work
  // in the SUBJECT's project, and the candidates on a miss must not disclose anyone else.
  const res = await ctx.callRest(ctx.principal, {
    method: 'GET',
    url: `/v1/projects/${pathSegment(projectId)}/member-options`,
  });
  if (res.statusCode >= 400) return { ok: false, statusCode: res.statusCode, json: res.json };
  const people = rowsOf(res.json) ?? [];
  const ids: string[] = [];
  const candidates = people
    .slice(0, 20)
    .map((p) => `${str(p['displayName'])} <${str(p['email'])}>`);

  for (const reference of references) {
    const wanted = reference.trim().toLowerCase();
    const matches = people.filter(
      (p) =>
        str(p['email'])?.toLowerCase() === wanted ||
        str(p['displayName'])?.toLowerCase() === wanted,
    );
    if (matches.length === 0) {
      return {
        ok: false,
        message: `No person matches "${reference}". Candidates: ${candidates.join(', ') || 'none'}.`,
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        message: `"${reference}" matches ${matches.length} people: ${matches
          .map((p) => `${str(p['displayName'])} <${str(p['email'])}>`)
          .join(', ')}. Use the email.`,
      };
    }
    const id = str(matches[0]['userId']);
    if (!id) return { ok: false, message: `"${reference}" resolved to a person without an id.` };
    if (!ids.includes(id)) ids.push(id);
  }
  return { ok: true, ids };
}

/** A test case by key (TC-12): the by-key route answers the record; its id feeds the results feed. */
export async function resolveTestCase(
  ctx: ToolContext,
  testCaseKey: string,
): Promise<Lookup<ResolvedTestCase>> {
  const res = await ctx.callRest(ctx.principal, {
    method: 'GET',
    url: `/v1/test-cases/by-key/${pathSegment(testCaseKey.trim())}`,
  });
  if (res.statusCode >= 400) return { ok: false, statusCode: res.statusCode, json: res.json };
  if (res.json === null || typeof res.json !== 'object') {
    return { ok: false, message: `No test case matches "${testCaseKey}".` };
  }
  const row = res.json as Record<string, unknown>;
  const id = str(row['id']);
  if (!id) return { ok: false, message: `No test case matches "${testCaseKey}".` };
  return {
    ok: true,
    id,
    testCaseKey: str(row['testCaseKey']) ?? testCaseKey,
    name: str(row['name']) ?? '',
  };
}

export interface ResolvedTimebox {
  ok: true;
  id: string;
  name: string;
  /** The iteration state or release status, so the model can see a committed/accepted target. */
  state: string | null;
}

/** The feed row fields the two timebox resolvers share. */
function matchTimebox(
  rows: Record<string, unknown>[],
  reference: string,
  label: 'iteration' | 'release',
  nameFields: string[],
): Lookup<ResolvedTimebox> {
  const wanted = reference.trim();
  const byId = rows.find((row) => str(row['id']) === wanted);
  const named = (row: Record<string, unknown>) =>
    nameFields.some((field) => str(row[field])?.toLowerCase() === wanted.toLowerCase());
  const byName = rows.filter(named);
  const describe = (row: Record<string, unknown>) =>
    `${str(row['name']) ?? '(unnamed)'}${str(row['id']) === wanted ? '' : ` [${str(row['id'])}]`}`;

  const toResolved = (row: Record<string, unknown>): ResolvedTimebox => ({
    ok: true,
    id: String(row['id']),
    name: str(row['name']) ?? '',
    state: str(row['state']) ?? str(row['status']) ?? null,
  });

  if (byId) return toResolved(byId);
  if (byName.length === 1) return toResolved(byName[0]);
  if (byName.length > 1) {
    return {
      ok: false,
      message: `"${reference}" matches ${byName.length} ${label}s: ${byName
        .slice(0, 20)
        .map(describe)
        .join(', ')}. Use the id.`,
    };
  }
  return {
    ok: false,
    message: `No ${label} matches "${reference}" in this project. Candidates: ${
      rows.slice(0, 20).map(describe).join(', ') || 'none'
    }.`,
  };
}

/** An iteration of one project by id, name or iteration key (`GET /v1/iterations/options`). */
export async function resolveIteration(
  ctx: ToolContext,
  projectId: string,
  reference: string,
): Promise<Lookup<ResolvedTimebox>> {
  const res = await ctx.callRest(ctx.principal, {
    method: 'GET',
    url: '/v1/iterations/options',
    query: { projectId },
  });
  if (res.statusCode >= 400) return { ok: false, statusCode: res.statusCode, json: res.json };
  const rows = rowsOf(res.json);
  if (!rows) return { ok: false, message: `Unexpected response from /v1/iterations/options.` };
  return matchTimebox(rows, reference, 'iteration', ['name', 'iterationKey']);
}

/** A release of one project by id, name or release key (`GET /v1/releases/options`). */
export async function resolveRelease(
  ctx: ToolContext,
  projectId: string,
  reference: string,
): Promise<Lookup<ResolvedTimebox>> {
  const res = await ctx.callRest(ctx.principal, {
    method: 'GET',
    url: '/v1/releases/options',
    query: { projectId },
  });
  if (res.statusCode >= 400) return { ok: false, statusCode: res.statusCode, json: res.json };
  const rows = rowsOf(res.json);
  if (!rows) return { ok: false, message: `Unexpected response from /v1/releases/options.` };
  return matchTimebox(rows, reference, 'release', ['name', 'releaseKey']);
}

export interface ResolvedTeam {
  ok: true;
  id: string;
  name: string;
  key: string | null;
}

/**
 * An ACTIVE team linked to one project, by team id, name or key
 * (`GET /v1/projects/:id/teams`, the READER-scoped feed: an Editor is offered only their own
 * teams, which is what the write's team scope would accept anyway).
 */
export async function resolveTeam(
  ctx: ToolContext,
  projectId: string,
  reference: string,
): Promise<Lookup<ResolvedTeam>> {
  const res = await ctx.callRest(ctx.principal, {
    method: 'GET',
    url: `/v1/projects/${pathSegment(projectId)}/teams`,
  });
  if (res.statusCode >= 400) return { ok: false, statusCode: res.statusCode, json: res.json };
  const rows = rowsOf(res.json);
  if (!rows) return { ok: false, message: `Unexpected response from the project teams feed.` };
  const active = rows.filter((row) => str(row['status']) === null || row['status'] === 'active');
  const wanted = reference.trim().toLowerCase();
  const matches = active.filter(
    (row) =>
      str(row['teamId']) === reference.trim() ||
      str(row['id']) === reference.trim() ||
      str(row['name'])?.toLowerCase() === wanted ||
      str(row['key'])?.toLowerCase() === wanted,
  );
  const describe = (row: Record<string, unknown>) =>
    `${str(row['name']) ?? '(unnamed)'}${str(row['key']) ? ` (${str(row['key'])})` : ''}`;
  if (matches.length === 1) {
    const row = matches[0];
    const id = str(row['teamId']) ?? str(row['id']);
    if (!id) return { ok: false, message: `"${reference}" resolved to a team without an id.` };
    return { ok: true, id, name: str(row['name']) ?? '', key: str(row['key']) };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      message: `"${reference}" matches ${matches.length} teams: ${matches
        .map(describe)
        .join(', ')}. Use the key.`,
    };
  }
  return {
    ok: false,
    message: `No active team of this project matches "${reference}". Candidates: ${
      active.map(describe).join(', ') || 'none'
    }.`,
  };
}

export interface ResolvedStatus {
  ok: true;
  id: string;
  name: string;
  category: string | null;
}

/**
 * A workflow status of one project by name or id (`GET /v1/projects/:id/statuses`). The server
 * still checks the TRANSITION in the PATCH; this only resolves the name the user said.
 */
export async function resolveStatus(
  ctx: ToolContext,
  projectId: string,
  reference: string,
): Promise<Lookup<ResolvedStatus>> {
  const res = await ctx.callRest(ctx.principal, {
    method: 'GET',
    url: `/v1/projects/${pathSegment(projectId)}/statuses`,
  });
  if (res.statusCode >= 400) return { ok: false, statusCode: res.statusCode, json: res.json };
  const rows = rowsOf(res.json);
  if (!rows) return { ok: false, message: `Unexpected response from the project statuses feed.` };
  const wanted = reference.trim().toLowerCase();
  const matches = rows.filter(
    (row) => str(row['id']) === reference.trim() || str(row['name'])?.toLowerCase() === wanted,
  );
  if (matches.length === 1) {
    return {
      ok: true,
      id: String(matches[0]['id']),
      name: str(matches[0]['name']) ?? '',
      category: str(matches[0]['category']),
    };
  }
  const candidates = rows.map((row) => str(row['name'])).filter((n): n is string => n !== null);
  if (matches.length > 1) {
    return {
      ok: false,
      message: `"${reference}" matches ${matches.length} statuses: ${candidates.join(', ')}. Use the id.`,
    };
  }
  return {
    ok: false,
    message: `No status matches "${reference}". Candidates: ${candidates.join(', ') || 'none'}.`,
  };
}

export interface ResolvedLabel {
  ok: true;
  id: string;
  name: string;
  color: string | null;
}

/**
 * A project label by exact name or id (`GET /v1/projects/:id/labels`, the project's catalogue).
 * Labels are project reference data — `work_item.label_*` is the assignment, and the server
 * checks the label belongs to the item's project on every write.
 */
export async function resolveLabel(
  ctx: ToolContext,
  projectId: string,
  reference: string,
): Promise<Lookup<ResolvedLabel>> {
  const res = await ctx.callRest(ctx.principal, {
    method: 'GET',
    url: `/v1/projects/${pathSegment(projectId)}/labels`,
  });
  if (res.statusCode >= 400) return { ok: false, statusCode: res.statusCode, json: res.json };
  const rows = rowsOf(res.json);
  if (!rows) return { ok: false, message: `Unexpected response from the project labels feed.` };
  const wanted = reference.trim().toLowerCase();
  const matches = rows.filter(
    (row) => str(row['id']) === reference.trim() || str(row['name'])?.toLowerCase() === wanted,
  );
  if (matches.length === 1) {
    return {
      ok: true,
      id: String(matches[0]['id']),
      name: str(matches[0]['name']) ?? '',
      color: str(matches[0]['color']),
    };
  }
  const candidates = rows
    .map((row) => str(row['name']))
    .filter((name): name is string => name !== null)
    .slice(0, 30);
  if (matches.length > 1) {
    return {
      ok: false,
      message: `"${reference}" matches ${matches.length} labels: ${candidates.join(', ')}. Use the id.`,
    };
  }
  return {
    ok: false,
    message: `No label matches "${reference}". Candidates: ${candidates.join(', ') || 'none'}.`,
  };
}
