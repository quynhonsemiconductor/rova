import { pathSegment, type ToolContext } from './rest';

/**
 * Human-reference resolution for tools that take a KEY/NAME where the REST route takes a UUID
 * (MCP v2 design §4: "args take human references … never guess"). These helpers read the app's
 * own picker/list routes with the caller's principal, so a reference resolves only to something
 * the person can already see, and an unknown/ambiguous one returns the candidates instead of a
 * guess. Each returns `{ ok: false, message }`; the calling tool relays it as its error result.
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

export type Lookup<T> = T | { ok: false; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rowsOf(json: unknown): Record<string, unknown>[] | null {
  const body = Array.isArray(json) ? json : (json as { data?: unknown } | null)?.data;
  return Array.isArray(body) ? (body as Record<string, unknown>[]) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A project by id, key (case-insensitive) or exact name, among the projects the caller can read. */
export async function resolveProject(
  ctx: ToolContext,
  reference: string,
): Promise<Lookup<ResolvedProject>> {
  const res = await ctx.callRest(ctx.principal, {
    method: 'GET',
    url: '/v1/projects',
    query: { limit: 100 },
  });
  if (res.statusCode >= 400)
    return { ok: false, message: `Could not list projects (HTTP ${res.statusCode}).` };
  const rows = rowsOf(res.json) ?? [];
  const wanted = reference.trim();
  const hit =
    rows.find((p) => str(p['id']) === wanted) ??
    rows.find((p) => str(p['key'])?.toLowerCase() === wanted.toLowerCase()) ??
    rows.find((p) => str(p['name'])?.toLowerCase() === wanted.toLowerCase());
  if (!hit) {
    const candidates = rows.slice(0, 20).map((p) => `${str(p['key'])} (${str(p['name'])})`);
    return {
      ok: false,
      message: `No project matches "${reference}". Candidates: ${candidates.join(', ') || 'none'}.`,
    };
  }
  return {
    ok: true,
    id: String(hit['id']),
    key: str(hit['key']) ?? '',
    name: str(hit['name']) ?? '',
  };
}

/** A work item by UUID or by its human key (e.g. US-412), with its current version. */
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
  if (res.statusCode >= 400 || res.json === null || typeof res.json !== 'object') {
    return { ok: false, message: `No work item matches "${reference}" (HTTP ${res.statusCode}).` };
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
    version: typeof item['version'] === 'number' ? item['version'] : -1,
  };
}

/**
 * A portfolio item (Epic/Feature) by key. There is no by-key route: the list is searched by the
 * key text for the type the prefix implies (EP-… epic, otherwise feature), then matched exactly.
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
    const res = await ctx.callRest(ctx.principal, {
      method: 'GET',
      url: '/v1/portfolio-items',
      query: { type, search: ref, limit: 50 },
    });
    if (res.statusCode >= 400) continue;
    const rows = rowsOf(res.json) ?? [];
    for (const row of rows) {
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
  if (res.statusCode >= 400 || res.json === null || typeof res.json !== 'object') {
    return {
      ok: false,
      message: `No test case matches "${testCaseKey}" (HTTP ${res.statusCode}).`,
    };
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
