/**
 * The exact WHERE clauses of the Iteration Status read-model — the GRID and the METRICS STRIP above
 * it — under the BA ruling of 2026-08-17: "Null means Project Backlog, accessible only to Workspace
 * Admin and Project Admin. Editor … cannot access team-less items. Enforce this consistently in API
 * queries, lists, reports, search, pickers and direct URLs."
 *
 * A PREDICATE spec, not a repository spec (hence the `.predicates.` name, following
 * `iteration.drizzle-repository.predicates.spec.ts`): the fault being guarded against is a condition
 * PRESENT ON ONE QUERY AND ABSENT ON ANOTHER, which is visible in the rendered SQL and invisible to
 * anything that goes through the mocked repository port — the service spec's `getMetrics` mock
 * returns whatever it is told to, whatever population the real query would have measured.
 *
 * The properties pinned here:
 *   1. an unrestricted caller (Workspace Admin, per-project `admin`) gets NO team predicate at all —
 *      not a tautology, not an `IN` over every team: literally absent;
 *   2. an EDITOR's team ids narrow the GRID and BOTH metric queries, so the strip can never be
 *      computed over a wider population than the rows below it (CLAUDE.md: "Eligibility must be
 *      counted in the SAME scope as the measurement" — the fault that produced the zero-point
 *      Velocity bars, twice);
 *   3. `teamIds: []` issues NO QUERY and returns nothing. Flattening it into "no filter" fails OPEN,
 *      and `inArray(col, [])` is not portable as "match nothing";
 *   4. the predicate is `team_id IN (…)` with NO `OR IS NULL`. A team-less STORY is the admin-only
 *      Project Backlog — the OPPOSITE of the team-less ITERATION in
 *      `iteration.drizzle-repository.predicates.spec.ts`, which is a shared timebox and stays
 *      visible. Two predicates over one column name, opposite treatments of NULL; only a test says
 *      which is which.
 */
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/pg-proxy';
import type { DrizzleDB } from '@platform';
import { IterationStatusDrizzleRepository } from './iteration-status.drizzle-repository';
import type { TeamReadScope } from '../../domain/team-read-scope';

interface Captured {
  sql: string;
  params: unknown[];
}

const ALL_TEAMS: TeamReadScope = { unrestricted: true };
const editorScope = (...teamIds: string[]): TeamReadScope => ({ unrestricted: false, teamIds });

const PAGE = { limit: 25, cursor: null };

/** A repository over a driver that records instead of executing. */
function recordingRepo(): { repo: IterationStatusDrizzleRepository; captured: Captured[] } {
  const captured: Captured[] = [];
  const db = drizzle(async (sql, params) => {
    captured.push({ sql, params });
    return { rows: [] };
  });
  return { repo: new IterationStatusDrizzleRepository(db as unknown as DrizzleDB), captured };
}

/**
 * Just the WHERE clause. `listItems` selects correlated subqueries that carry their own `where`, so
 * the OUTER one is taken as everything after the last `where` that follows the outer `from`.
 */
function whereClause(sql: string): string {
  const match = /\swhere\s(.*?)(?:\sorder by\s|\sgroup by\s|\slimit\s|$)/.exec(
    sql.slice(sql.lastIndexOf(' where ')),
  );
  if (!match) throw new Error(`No WHERE clause in: ${sql}`);
  return match[1];
}

describe('IterationStatusDrizzleRepository — the team-scope predicates', () => {
  describe('getMetrics (the strip)', () => {
    it('emits no team predicate for an unrestricted caller', async () => {
      const { repo, captured } = recordingRepo();

      await repo.getMetrics('it-1', 'ws-1', ALL_TEAMS);

      // Two queries: the points/defect aggregate over work_items, and the task aggregate.
      expect(captured).toHaveLength(2);
      for (const q of captured) expect(q.sql).not.toContain('"team_id"');
    });

    it("narrows BOTH aggregates by the editor's teams", async () => {
      const { repo, captured } = recordingRepo();

      await repo.getMetrics('it-1', 'ws-1', editorScope('team-a', 'team-b'));

      expect(captured).toHaveLength(2);
      const [points, taskAgg] = captured;

      // The points/defect aggregate: the ITEM's own team. Placeholder NUMBERS are not asserted —
      // `acceptedScheduleStatesSql()` binds its own params in the SELECT list, so they shift with a
      // change that has nothing to do with this predicate.
      expect(whereClause(points.sql)).toMatch(/"work_items"\."team_id" in \(\$\d+, \$\d+\)/);
      expect(points.params).toEqual(expect.arrayContaining(['it-1', 'ws-1', 'team-a', 'team-b']));

      // The task aggregate: the PARENT's team, because a task rolls up into the row shown below and
      // the per-row rollups in `listItems` sum all of a visible row's children. Counting tasks by
      // their own team would make this number disagree with the rows it summarises.
      const taskWhere = whereClause(taskAgg.sql);
      expect(taskWhere).toMatch(/"wi_task_parent"\."team_id" in \(\$\d+, \$\d+\)/);
      expect(taskAgg.params).toEqual(expect.arrayContaining(['it-1', 'ws-1', 'team-a', 'team-b']));
    });

    it('never admits a team-less row: no `IS NULL` alongside the IN', async () => {
      const { repo, captured } = recordingRepo();

      await repo.getMetrics('it-1', 'ws-1', editorScope('team-a'));

      // A team-less story/defect is the Project Backlog (admin-only), so `team_id IS NULL` must not
      // appear as an alternative to the IN. `deleted_at is null` is the only IS NULL these carry.
      for (const q of captured) {
        expect(whereClause(q.sql)).not.toContain('"team_id" is null');
      }
    });

    it('issues NO query and measures nothing when the editor holds no team', async () => {
      const { repo, captured } = recordingRepo();

      const metrics = await repo.getMetrics('it-1', 'ws-1', editorScope());

      expect(captured).toEqual([]);
      expect(metrics).toEqual({
        totalPlanEstimate: 0,
        acceptedPoints: 0,
        defectCount: 0,
        taskCount: 0,
        activeTaskCount: 0,
      });
    });
  });

  describe('listItems (the grid)', () => {
    it('emits no team predicate for an unrestricted caller', async () => {
      const { repo, captured } = recordingRepo();

      await repo.listItems('it-1', 'ws-1', {}, PAGE, ALL_TEAMS);

      expect(captured).toHaveLength(1);
      expect(whereClause(captured[0].sql)).not.toContain('"team_id"');
    });

    it("narrows to the editor's teams, with no OR IS NULL", async () => {
      const { repo, captured } = recordingRepo();

      await repo.listItems('it-1', 'ws-1', {}, PAGE, editorScope('team-a', 'team-b'));

      const where = whereClause(captured[0].sql);
      expect(where).toContain('"team_id" in (');
      expect(where).not.toContain('"team_id" is null');
      expect(captured[0].params).toEqual(
        expect.arrayContaining(['it-1', 'ws-1', 'team-a', 'team-b']),
      );
    });

    it('filters Start / Target End by a substring of the ISO date text, pinned with to_char', async () => {
      const { repo, captured } = recordingRepo();

      await repo.listItems(
        'it-1',
        'ws-1',
        { startDate: ' 2026-10 ', targetEndDate: '2026-11' },
        PAGE,
        ALL_TEAMS,
      );

      const where = whereClause(captured[0].sql);
      // `date::text` follows the session DateStyle (SQL / German render `10/05/2026`, `05.10.2026`),
      // so a `2026-10` month fragment would silently match nothing there. `to_char` pins the format.
      expect(where).toMatch(
        /to_char\("work"\."work_items"\."start_date", 'YYYY-MM-DD'\) ilike \$\d+/,
      );
      expect(where).toMatch(
        /to_char\("work"\."work_items"\."target_end_date", 'YYYY-MM-DD'\) ilike \$\d+/,
      );
      expect(where).not.toMatch(/"(start_date|target_end_date)"::text/);
      // The value is trimmed and wrapped as a substring match.
      expect(captured[0].params).toEqual(expect.arrayContaining(['%2026-10%', '%2026-11%']));
    });

    it('emits no date predicate for a blank Start / Target End filter', async () => {
      const { repo, captured } = recordingRepo();

      await repo.listItems('it-1', 'ws-1', { startDate: '  ', targetEndDate: '' }, PAGE, ALL_TEAMS);

      expect(whereClause(captured[0].sql)).not.toContain('to_char(');
    });

    it('issues NO query and returns an empty page when the editor holds no team', async () => {
      const { repo, captured } = recordingRepo();

      const page = await repo.listItems('it-1', 'ws-1', {}, PAGE, editorScope());

      expect(captured).toEqual([]);
      expect(page.data).toEqual([]);
      expect(page.pageInfo).toEqual({ nextCursor: null, hasNextPage: false, limit: 25 });
    });
  });

  /**
   * The property the two describes above exist FOR: one scope, one predicate, both queries. A metric
   * over a wider population than its own rows is what this repo has now fixed three times (Velocity's
   * eligibility join, `countScheduledWork`, and Release Tracking's shared eligibility predicate).
   */
  it('applies the SAME team ids to the strip and the grid', async () => {
    const { repo, captured } = recordingRepo();
    const scope = editorScope('team-a');

    await repo.getMetrics('it-1', 'ws-1', scope);
    await repo.listItems('it-1', 'ws-1', {}, PAGE, scope);

    const [points, taskAgg, items] = captured;
    for (const q of [points, taskAgg, items]) {
      expect(whereClause(q.sql)).toMatch(/"team_id" in \(\$\d+\)/);
      expect(q.params).toContain('team-a');
    }
  });
});
