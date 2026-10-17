/**
 * Manage Filters, over REAL HTTP: every specified filter column is a SERVER predicate.
 *
 * `P2-BL-FR-005` / `-020` and Backlog AC-7 give the Backlog a Manage Filters popover whose chosen
 * columns "combine active filters after Apply"; `P2-IS-FR-022` inherits it on Iteration Status. The
 * requirement that makes it non-trivial is not the popover — it is WHERE the filtering happens.
 *
 * The gap this closes, and the reason the assertions are shaped the way they are:
 *
 *  • The Backlog had Type / Schedule State / Priority / Owner / Release server-side, and NO filter at
 *    all for the ID, Name and Est columns FR-006 names as text/number inputs.
 *  • Iteration Status had `q`, `type`, `scheduleState`, `isBlocked` and `assigneeId` on the API and
 *    used exactly ONE of them (`q`); Schedule State, Owner and Blocked were re-implemented in the
 *    browser over the already-fetched rows. That answers "which of the rows we fetched match?", not
 *    "which rows match?" — the two diverge the moment the set exceeds what was fetched.
 *
 * So the load-bearing assertion in each half is `finds a match that is NOT on the first page`. A test
 * that filters within page one passes just as well against a client-side filter and proves nothing.
 *
 * Driven through `app.inject()` rather than the services, deliberately: the number and boolean filters
 * arrive as QUERY STRINGS, and their coercion is part of the contract. `isBlocked` is the proof —
 * `z.coerce.boolean()` maps `'false'` to TRUE, so `?isBlocked=false` used to ask for blocked rows, and
 * no service-level test could have seen it. Same blind spot CLAUDE.md records for the guard defects.
 *
 * Fixtures live in `SEEDED.nxp` (no `createProject` — `test/e2e-fixtures.ratchet.spec.ts` caps those),
 * and in `SEEDED.nxp.iterationFutureId` rather than the current iteration, whose metrics several other
 * specs read.
 */
import 'reflect-metadata';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WorkItemsService } from '@modules/work-items';
import { AppModule } from '../../apps/api/src/app.module';
import { DEVELOPER_ID, SEEDED, adminActor, uniqueKey } from './support/flow-harness';
import { signIn } from './support/session';

interface BacklogRow {
  id: string;
  itemKey: string;
  title: string;
  assigneeId: string | null;
  storyPoints: string | null;
}
interface StatusRow {
  id: string;
  itemKey: string;
  title: string;
  scheduleState: string;
  isBlocked: boolean;
  toDo: number;
  taskEstimate: number;
}
interface Paged<T> {
  data?: T[];
  items?: T[];
  pageInfo: { total?: number; hasNextPage: boolean; nextCursor: string | null };
}

/**
 * One page size for every request, small enough that the fixtures cannot fit on page 1 of the
 * unfiltered list — the whole point of the "not on the first page" assertions.
 */
const PAGE = 5;

// No `/v1` prefix: `Test.createTestingModule` builds the app without the bootstrap that sets the
// global prefix, so routes are mounted bare here.
describe('Manage Filters: every specified column filters SERVER-side (e2e)', () => {
  let app: NestFastifyApplication;
  let items: WorkItemsService;
  let token: string;

  /** Marker word shared by this run's fixtures, so they are isolatable inside a seeded project. */
  const MARK = uniqueKey('MF');
  const NEEDLE = `${MARK}needle`;
  const HAYSTACK = `${MARK}haystack`;

  /** Title `NEEDLE`, owner DEVELOPER, 13 points, in the future iteration — matches everything. */
  let bothId = '';
  let bothKey = '';
  /** Title `NEEDLE`, NO owner — matches the Name condition only. */
  let nameOnlyId = '';
  /** Title `HAYSTACK`, owner DEVELOPER — matches the Owner condition only. */
  let ownerOnlyId = '';
  /** In the future iteration, blocked, with a task carrying To Do = 7. */
  let blockedId = '';
  /** Every row this spec creates, so `afterAll` can remove them. */
  const created: string[] = [];

  function get(url: string) {
    return app.inject({ method: 'GET', url, headers: { cookie: token } });
  }

  async function backlog(query: string): Promise<Paged<BacklogRow>> {
    const res = await get(
      `/work-items/backlog?projectId=${SEEDED.nxp.projectId}&limit=${PAGE}&${query}`,
    );
    expect(res.statusCode, `GET backlog?${query}`).toBe(200);
    return JSON.parse(res.body) as Paged<BacklogRow>;
  }

  async function iterationStatus(query: string): Promise<Paged<StatusRow>> {
    const res = await get(
      `/iterations/${SEEDED.nxp.iterationFutureId}/status?limit=${PAGE}&${query}`,
    );
    expect(res.statusCode, `GET status?${query}`).toBe(200);
    return JSON.parse(res.body) as Paged<StatusRow>;
  }

  const ids = (page: Paged<{ id: string }>): string[] =>
    (page.data ?? page.items ?? []).map((r) => r.id);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    items = app.get(WorkItemsService);
    // The session cookie from test-login; this app has no CSRF hook (that is `bootstrapApp`'s), so this
    // needs no CSRF dance, and the test app registers no cookie plugin anyway.
    token = await signIn(app, 'admin@qnsc.dev');

    const actor = adminActor();
    const project = SEEDED.nxp.projectId;

    /**
     * ── Backlog fixtures. The FILLERS ARE CREATED FIRST, and that order is load-bearing.
     *
     * A new item appends to the END of the rank order, so the rows created last are the last page.
     * This block used to create the needles first and only three fillers after them, which left the
     * "not on page 1" premise resting on the SEEDED backlog being larger than one page — true on a
     * freshly seeded database and false in a full-suite run, where other specs have changed what the
     * first page holds. It passed in isolation and failed in the suite, which is the signature of a
     * fixture that depends on its neighbours (the `read-scoping` spec had the same shape: it compared
     * two paginated pages and only failed once the workspace passed 100 projects).
     *
     * Creating PAGE fillers before the needles makes the premise true by construction: whatever else
     * the database holds, at least PAGE rows now rank ahead of every row this spec asserts on.
     */
    for (let i = 0; i < PAGE; i++) {
      const lead = await items.createWorkItem(actor, project, 'story', `${HAYSTACK} lead ${i}`);
      created.push(lead.id);
    }

    const both = await items.createWorkItem(actor, project, 'story', `${NEEDLE} both`, {
      assigneeId: DEVELOPER_ID,
      teamId: SEEDED.nxp.teamAlphaId,
      storyPoints: '13.00',
    });
    bothId = both.id;
    bothKey = both.itemKey;
    created.push(bothId);

    nameOnlyId = (
      await items.createWorkItem(actor, project, 'story', `${NEEDLE} name only`, {
        storyPoints: '13.00',
      })
    ).id;
    created.push(nameOnlyId);

    ownerOnlyId = (
      await items.createWorkItem(actor, project, 'story', `${HAYSTACK} owner only`, {
        assigneeId: DEVELOPER_ID,
        teamId: SEEDED.nxp.teamAlphaId,
      })
    ).id;
    created.push(ownerOnlyId);

    // More filler AFTER the needles, so the FILTERED result is a genuine narrowing of a multi-row
    // marker set rather than "the only rows this run created". These do not carry the paging premise —
    // the PAGE rows created before the needles do.
    for (let i = 0; i < 3; i++) {
      const filler = await items.createWorkItem(actor, project, 'story', `${HAYSTACK} filler ${i}`);
      created.push(filler.id);
    }

    // ── Iteration Status fixtures, in the FUTURE iteration (planning, so assignable, and nothing
    // else reads its metrics).
    for (let i = 0; i < PAGE; i++) {
      const filler = await items.createWorkItem(
        actor,
        project,
        'story',
        `${HAYSTACK} sprint filler ${i}`,
        { iterationId: SEEDED.nxp.iterationFutureId },
      );
      created.push(filler.id);
    }
    const sprintNeedle = await items.createWorkItem(
      actor,
      project,
      'story',
      `${NEEDLE} sprint row`,
      {
        iterationId: SEEDED.nxp.iterationFutureId,
        assigneeId: DEVELOPER_ID,
        teamId: SEEDED.nxp.teamAlphaId,
        storyPoints: '13.00',
      },
    );
    blockedId = sprintNeedle.id;
    created.push(blockedId);
    await items.updateWorkItem(actor, blockedId, { isBlocked: true, blockedReason: 'fixture' });
    // Estimate and To Do are independent fields, and the FIRST estimate copies itself to To Do — so
    // both are passed explicitly to get a rollup pair that cannot be confused for one another.
    await items.createTask(actor, blockedId, `${MARK} task`, {
      estimateHours: '8.00',
      todoHours: '7.00',
    });
  });

  afterAll(async () => {
    // Clean up after itself. The suite historically had NO teardown in any of its 37 files, which is
    // how a dev database grew by ~84 projects a run and twice drove `portfolio_items.rank` into its
    // varchar(255) ceiling. These rows are cheap to remove and the marker makes them unambiguous.
    const actor = adminActor();
    for (const id of created) {
      await items.deleteWorkItem(actor, id).catch(() => undefined);
    }
    await app?.close();
  });

  // ── Backlog ────────────────────────────────────────────────────────────────────────────────────

  it('the fixtures are NOT on the first page of the unfiltered backlog', async () => {
    // The premise every assertion below rests on, asserted rather than assumed: if the needles were
    // on page 1, every "found it" result would also be true of a CLIENT-side filter and the suite
    // would be green for the wrong reason. It holds by construction now — `beforeAll` creates PAGE
    // filler rows before them — rather than by relying on how large the seeded backlog happens to be.
    const page1 = await backlog('');
    expect(page1.pageInfo.total ?? 0).toBeGreaterThan(PAGE);
    expect(ids(page1)).not.toContain(bothId);
    expect(ids(page1)).not.toContain(nameOnlyId);
  });

  it('the Name column filter finds a row that is not on the first page (FR-006, AC-8)', async () => {
    const page = await backlog(`title=${NEEDLE}`);
    // Both NEEDLE rows come back on the FIRST page of the filtered query — which is only possible
    // if the predicate ran in the database.
    expect(ids(page).sort()).toEqual([bothId, nameOnlyId].sort());
    expect(page.pageInfo.total).toBe(2);
  });

  it('the ID column filter is a server predicate too', async () => {
    const page = await backlog(`itemKey=${bothKey}`);
    expect(ids(page)).toEqual([bothId]);
  });

  it('the Est column number filter matches on story points', async () => {
    const page = await backlog(`title=${MARK}&planEstimate=13`);
    expect(ids(page).sort()).toEqual([bothId, nameOnlyId].sort());
  });

  it('an EMPTY number filter is not a filter for zero (a coercion trap)', async () => {
    // `z.coerce.number('')` is 0, so `?planEstimate=` would have asked for zero-point items — a
    // control that narrows the list while reading as untouched.
    //
    // Asserted as "empty changes NOTHING" rather than against a hard-coded total: the count depends on
    // how many fixture rows this spec creates, so a literal here breaks whenever the fixture grows and
    // says nothing about the behaviour under test. Two rows carry a plan estimate, so a filter that
    // really meant zero would drop them and the totals would differ.
    const untouched = await backlog(`title=${MARK}`);
    const withEmpty = await backlog(`title=${MARK}&planEstimate=`);
    expect(withEmpty.pageInfo.total).toBe(untouched.pageInfo.total);
    expect(withEmpty.pageInfo.total ?? 0).toBeGreaterThan(2);
  });

  it('P2-BL-TS-014: Name AND Owner combine — the result matches BOTH conditions', async () => {
    const page = await backlog(`title=${NEEDLE}&assigneeId=${DEVELOPER_ID}`);
    expect(ids(page)).toEqual([bothId]);
    // Each condition alone admits a row the combination must exclude, which is what makes this an
    // AND and not one filter quietly winning.
    expect(ids(await backlog(`title=${NEEDLE}`))).toContain(nameOnlyId);
    expect(ids(await backlog(`title=${MARK}&assigneeId=${DEVELOPER_ID}`))).toContain(ownerOnlyId);
  });

  it('the Owner filter resolves the Unassigned sentinel to IS NULL', async () => {
    // `assignee_id = 'unassigned'` matches nothing, and SQL equality never matches NULL either — so
    // an Unassigned option can only work as a server-resolved sentinel.
    const page = await backlog(`title=${NEEDLE}&assigneeId=unassigned`);
    expect(ids(page)).toEqual([nameOnlyId]);
  });

  it('P2-BL-TS-015: quick search works independently of the Manage Filters set', async () => {
    // (a) On its own — a key search still finds the item with no filters applied.
    expect(ids(await backlog(`q=${bothKey}`))).toEqual([bothId]);

    // (b) With a Manage Filters value applied — the filter does not disable quick search.
    expect(ids(await backlog(`q=${bothKey}&assigneeId=${DEVELOPER_ID}`))).toEqual([bothId]);

    // (c) And the converse, which is what proves INDEPENDENCE rather than coincidence: quick search
    // does not override the filter either. The key matches, the Owner condition does not, and the
    // answer is empty — not "the row, because the search found it".
    expect(ids(await backlog(`q=${bothKey}&assigneeId=unassigned`))).toEqual([]);
  });

  // ── Iteration Status ───────────────────────────────────────────────────────────────────────────

  it('Iteration Status: the Name filter finds a row that is not on the first page', async () => {
    const unfiltered = await iterationStatus('');
    expect(ids(unfiltered)).not.toContain(blockedId);
    expect(unfiltered.pageInfo.hasNextPage).toBe(true);

    const page = await iterationStatus(`title=${NEEDLE}`);
    expect(ids(page)).toEqual([blockedId]);
  });

  it('Iteration Status: Owner and Schedule State are server predicates, and combine', async () => {
    // Scoped by this run's marker, like every other assertion here: the suite has no teardown
    // anywhere and the seeded iteration accumulates rows, so an unscoped Owner query answers for
    // previous runs as well as this one.
    expect(ids(await iterationStatus(`title=${NEEDLE}&assigneeId=${DEVELOPER_ID}`))).toEqual([
      blockedId,
    ]);

    // The Unassigned sentinel, resolved SERVER-side to `IS NULL`. This screen used to carry a
    // client-only `__unassigned__` token because its filtering happened in the browser; sending that
    // to the API would have matched nothing, and `assignee_id = 'unassigned'` matches nothing either.
    const unowned = await iterationStatus(`title=${HAYSTACK}&assigneeId=unassigned`);
    expect(ids(unowned)).toHaveLength(PAGE);
    expect(ids(unowned)).not.toContain(blockedId);

    // The row's OWN state, read back rather than hardcoded: the create default is the service's
    // business, and a test that spells it out fails for a reason unrelated to filtering the moment
    // that default moves.
    const state = (await iterationStatus(`title=${NEEDLE}`)).items?.[0]?.scheduleState;
    expect(state).toBeTruthy();
    expect(ids(await iterationStatus(`title=${NEEDLE}&scheduleState=${state}`))).toEqual([
      blockedId,
    ]);
    // …and a state nothing in the fixture set is in returns nothing — the filter must narrow, never
    // hand back everything because the browser was going to do it.
    const otherState = state === 'accepted' ? 'idea' : 'accepted';
    expect(ids(await iterationStatus(`title=${NEEDLE}&scheduleState=${otherState}`))).toEqual([]);
  });

  it('Iteration Status: isBlocked=false does NOT return blocked rows', async () => {
    // The coercion trap this closes: `z.coerce.boolean()` is `Boolean(value)`, and
    // `Boolean('false')` is TRUE — so `?isBlocked=false` asked for exactly the opposite set. It was
    // invisible while the only caller was a "Blocked items only" checkbox that either sent `true`
    // or omitted the param.
    expect(ids(await iterationStatus(`title=${NEEDLE}&isBlocked=true`))).toEqual([blockedId]);
    expect(ids(await iterationStatus(`title=${NEEDLE}&isBlocked=false`))).toEqual([]);
  });

  it('Iteration Status: the Task Est and To Do filters test the SAME rollup the column shows', async () => {
    const byToDo = await iterationStatus(`title=${NEEDLE}&toDo=7`);
    expect(ids(byToDo)).toEqual([blockedId]);
    expect((byToDo.items ?? [])[0]?.toDo).toBe(7);

    const byTaskEst = await iterationStatus(`title=${NEEDLE}&taskEstimate=8`);
    expect(ids(byTaskEst)).toEqual([blockedId]);
    expect((byTaskEst.items ?? [])[0]?.taskEstimate).toBe(8);

    // Estimate and To Do are independent fields (Portfolio SRS:141-147): filtering on one must not
    // match the other's value, or the two predicates are reading one column.
    expect(ids(await iterationStatus(`title=${NEEDLE}&toDo=8`))).toEqual([]);
  });

  it('Iteration Status: quick search stays independent of Manage Filters (P2-IS-FR-020)', async () => {
    const key = (await iterationStatus(`title=${NEEDLE}`)).items?.[0]?.itemKey ?? '';
    expect(key).toBeTruthy();
    expect(ids(await iterationStatus(`q=${key}`))).toEqual([blockedId]);
    expect(ids(await iterationStatus(`q=${key}&isBlocked=true`))).toEqual([blockedId]);
    expect(ids(await iterationStatus(`q=${key}&isBlocked=false`))).toEqual([]);
  });
});
