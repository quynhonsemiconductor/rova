import type { ToolContext } from './rest';

/**
 * Resolves the ids inside tool results to the identity a person recognises (MCP-PLAN §11).
 *
 * Work item rows carry `iterationId`, `teamId`, `releaseId`, `parentId` and person ids but only
 * two of the names (`assigneeName`, `devOwnerName`) are joined into the DTO. An agent that sees
 * `iterationId: "019f…"` cannot say which sprint a story is in, so each tool resolves the ids it
 * already holds through the app's OWN reference feeds — the same picker endpoints the web UI
 * calls, with the same principal and the same guards:
 *
 *   iteration  GET /v1/iterations/options?projectId   (project:view / iteration:view)
 *   release    GET /v1/releases/options?projectId     (project:view)
 *   team       GET /v1/workspaces/:id/teams           (scoped to readable projects)
 *   person     GET /v1/workspaces/:id/member-options  (scoped to readable projects)
 *   parent     GET /v1/work-items/:id                 (work_item:view)
 *
 * Each feed is fetched AT MOST ONCE per tool call and only when a row actually holds an id of
 * that kind, so a page of 20 work items costs one iteration feed and one people feed, not 40
 * lookups. A feed the principal cannot read, or an id the feed does not contain (a deleted
 * iteration, a person outside every project they can read), degrades to `{ id, name: null }`:
 * the answer is less readable, never wrong and never a denial of the tool they did ask for.
 *
 * These are READ-ONLY routes, reached through the same `callRest` bridge as the tool's own
 * route, so the MCP ratchet's rule holds: no tool bypasses the HTTP authorization layer.
 */

/** A resolved entity: the id plus whatever display identity the feed carries. */
export interface Ref {
  id: string;
  name: string | null;
  key: string | null;
}

/** A person as the picker feed names them; the email is deliberately not relayed. */
export interface PersonRef {
  id: string;
  name: string | null;
}

/** A work item referenced from another row (a parent). */
export interface WorkItemParentRef {
  id: string;
  itemKey: string | null;
  title: string | null;
}

export interface RefResolver {
  iteration(id: unknown, projectId: unknown): Promise<Ref | null>;
  release(id: unknown, projectId: unknown): Promise<Ref | null>;
  team(id: unknown): Promise<Ref | null>;
  person(id: unknown): Promise<PersonRef | null>;
  parent(id: unknown): Promise<WorkItemParentRef | null>;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function unknownRef(id: string): Ref {
  return { id, name: null, key: null };
}

/** Builds a resolver for ONE tool call; its caches are request-local by construction. */
export function createRefResolver(ctx: ToolContext): RefResolver {
  const feeds = new Map<string, Promise<Map<string, Ref> | null>>();
  const parents = new Map<string, Promise<WorkItemParentRef | null>>();

  async function rows(
    url: string,
    query?: Record<string, string | undefined>,
  ): Promise<Record<string, unknown>[] | null> {
    const res = await ctx.callRest(ctx.principal, {
      method: 'GET',
      url,
      ...(query ? { query } : {}),
    });
    if (res.statusCode >= 400) return null;
    const body = Array.isArray(res.json) ? res.json : (res.json as { data?: unknown } | null)?.data;
    return Array.isArray(body) ? (body as Record<string, unknown>[]) : null;
  }

  /** One feed per key; a failed fetch is cached as `null` too (no retry storm on a 403). */
  function feed(
    key: string,
    url: string,
    query: Record<string, string | undefined> | undefined,
    toRef: (row: Record<string, unknown>) => Ref,
    idField = 'id',
  ): Promise<Map<string, Ref> | null> {
    const cached = feeds.get(key);
    if (cached) return cached;
    const fetched = (async () => {
      const list = await rows(url, query);
      if (!list) return null;
      const map = new Map<string, Ref>();
      for (const row of list) {
        const id = str(row[idField]);
        if (id) map.set(id, toRef(row));
      }
      return map;
    })();
    feeds.set(key, fetched);
    return fetched;
  }

  const teamFeed = () =>
    feed('teams', `/v1/workspaces/${ctx.principal.workspaceId}/teams`, undefined, (row) => ({
      id: String(row['id']),
      name: str(row['name']),
      key: str(row['key']),
    }));

  const peopleFeed = () =>
    feed(
      'people',
      `/v1/workspaces/${ctx.principal.workspaceId}/member-options`,
      undefined,
      (row) => ({ id: String(row['userId']), name: str(row['displayName']), key: null }),
      'userId',
    );

  return {
    async iteration(id, projectId) {
      const ref = str(id);
      if (!ref) return null;
      const project = str(projectId);
      if (!project) return unknownRef(ref);
      const map = await feed(
        `iterations:${project}`,
        '/v1/iterations/options',
        { projectId: project },
        (row) => ({
          id: String(row['id']),
          name: str(row['name']),
          key: str(row['iterationKey']),
        }),
      );
      return map?.get(ref) ?? unknownRef(ref);
    },

    async release(id, projectId) {
      const ref = str(id);
      if (!ref) return null;
      const project = str(projectId);
      if (!project) return unknownRef(ref);
      const map = await feed(
        `releases:${project}`,
        '/v1/releases/options',
        { projectId: project },
        (row) => ({
          id: String(row['id']),
          name: str(row['name']),
          key: str(row['releaseKey']),
        }),
      );
      return map?.get(ref) ?? unknownRef(ref);
    },

    async team(id) {
      const ref = str(id);
      if (!ref) return null;
      const map = await teamFeed();
      return map?.get(ref) ?? unknownRef(ref);
    },

    async person(id) {
      const ref = str(id);
      if (!ref) return null;
      const map = await peopleFeed();
      const hit = map?.get(ref);
      return hit ? { id: hit.id, name: hit.name } : { id: ref, name: null };
    },

    async parent(id) {
      const ref = str(id);
      if (!ref) return null;
      const cached = parents.get(ref);
      if (cached) return cached;
      const fetched = (async (): Promise<WorkItemParentRef | null> => {
        const res = await ctx.callRest(ctx.principal, {
          method: 'GET',
          url: `/v1/work-items/${ref}`,
        });
        if (res.statusCode >= 400 || res.json === null || typeof res.json !== 'object') {
          return { id: ref, itemKey: null, title: null };
        }
        const row = res.json as Record<string, unknown>;
        return { id: ref, itemKey: str(row['itemKey']), title: str(row['title']) };
      })();
      parents.set(ref, fetched);
      return fetched;
    },
  };
}

/**
 * Prefer the DTO's own joined name over the picker feed: `assigneeName`/`devOwnerName` are
 * resolved server-side on the grid reads and also name a Workspace Admin (who has no
 * `project_members` row), which the workspace picker feed cannot always do.
 */
export function personRef(
  id: unknown,
  dtoName: unknown,
  resolved: PersonRef | null,
): PersonRef | null {
  const ref = str(id);
  if (!ref) return null;
  return { id: ref, name: str(dtoName) ?? resolved?.name ?? null };
}
