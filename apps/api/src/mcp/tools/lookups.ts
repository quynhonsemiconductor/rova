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
  version: number;
}

export interface ResolvedPortfolioItem {
  ok: true;
  id: string;
  itemKey: string;
  name: string;
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
    const info = (res.json as { pageInfo?: { hasNextPage?: unknown; cursor?: unknown } } | null)
      ?.pageInfo;
    const next = typeof info?.cursor === 'string' ? info.cursor : undefined;
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
    version: versionOfEtag(res, item['version']),
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
        return { ok: true, id: String(row['id']), itemKey, name: str(row['name']) ?? '' };
      }
    }
  }
  return {
    ok: false,
    message: `No portfolio item matches "${reference}". Candidates: ${seen.slice(0, 20).join(', ') || 'none'}.`,
  };
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
