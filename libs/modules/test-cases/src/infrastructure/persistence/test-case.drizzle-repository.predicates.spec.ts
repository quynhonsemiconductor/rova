/**
 * The exact WHERE clauses `TestCaseDrizzleRepository` emits — following
 * `quality.drizzle-repository.predicates.spec.ts`'s shape, but proving the OPPOSITE property.
 *
 * D7 (Phase 7 plan): Test Case team scope is inherited entirely from the parent Work Item via
 * `TestCasesService.requireReadableWorkItem` — there is deliberately NO second team predicate on
 * `test_cases`. `scope` is still a required parameter on the two list-shaped reads (a structural
 * guard against a future call site skipping the boundary), but it must never be turned into a
 * `team_id` predicate here: doing so would give the module TWO different definitions of team
 * scope (the parent Work Item's, and a second one on the child rows) that could disagree.
 */
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/pg-proxy';
import type { DrizzleDB } from '@platform';
import { TestCaseDrizzleRepository } from './test-case.drizzle-repository';
import type { TeamReadScope } from '../../domain/team-read-scope';

interface Captured {
  sql: string;
  params: unknown[];
}

const ALL_TEAMS: TeamReadScope = { unrestricted: true };
const editorScope = (...teamIds: string[]): TeamReadScope => ({ unrestricted: false, teamIds });

function recordingRepo(): { repo: TestCaseDrizzleRepository; captured: Captured[] } {
  const captured: Captured[] = [];
  const db = drizzle(async (sql, params) => {
    captured.push({ sql, params });
    return { rows: [] };
  });
  return { repo: new TestCaseDrizzleRepository(db as unknown as DrizzleDB), captured };
}

function whereOf(sql: string): string {
  const at = sql.indexOf(' where ');
  return at === -1 ? '' : sql.slice(at);
}

describe('TestCaseDrizzleRepository — scope is REQUIRED but never a predicate (D7)', () => {
  describe.each([
    ['unrestricted', ALL_TEAMS],
    ['an editor scope', editorScope('team-a', 'team-b')],
    ['an EMPTY editor scope', editorScope()],
  ] as const)('listByWorkItem with %s', (_label, scope) => {
    it('filters by work_item_id + deleted_at IS NULL, and emits no team_id predicate at all', async () => {
      const { repo, captured } = recordingRepo();

      await repo.listByWorkItem('wi-1', 'ws-1', { limit: 50, cursor: null }, scope);

      // One SELECT (the page) + one SELECT (the total).
      expect(captured).toHaveLength(2);
      for (const q of captured) {
        expect(whereOf(q.sql)).toContain('work_item_id');
        expect(whereOf(q.sql)).toContain('deleted_at');
        expect(whereOf(q.sql)).not.toContain('team_id');
      }
    });
  });

  it('orders the page by rank (AC2), never by team', async () => {
    const { repo, captured } = recordingRepo();

    await repo.listByWorkItem('wi-1', 'ws-1', { limit: 50, cursor: null }, ALL_TEAMS);

    expect(captured[0].sql).toMatch(/order by "work"\."test_cases"\."rank" asc/);
  });

  describe.each([
    ['unrestricted', ALL_TEAMS],
    ['an editor scope', editorScope('team-a')],
    ['an EMPTY editor scope', editorScope()],
  ] as const)('countByWorkItem with %s', (_label, scope) => {
    it('counts by work_item_id + deleted_at IS NULL, with no team_id predicate', async () => {
      const { repo, captured } = recordingRepo();

      await repo.countByWorkItem('wi-1', 'ws-1', scope);

      expect(captured).toHaveLength(1);
      expect(whereOf(captured[0].sql)).toContain('work_item_id');
      expect(whereOf(captured[0].sql)).not.toContain('team_id');
    });
  });

  it('findById is a plain (id, workspace_id) lookup with NO scope parameter at all', async () => {
    const { repo, captured } = recordingRepo();

    // TypeScript itself enforces the missing third argument (IWorkItemRepository.findById shape) —
    // this asserts the runtime SQL carries no team_id either, so a future signature change that
    // re-adds a scope param without a predicate would not silently start narrowing rows.
    await repo.findById('tc-1', 'ws-1');

    expect(captured).toHaveLength(1);
    expect(whereOf(captured[0].sql)).not.toContain('team_id');
  });

  it('findByKey is a plain (key, workspace_id) lookup with NO scope parameter at all', async () => {
    const { repo, captured } = recordingRepo();

    await repo.findByKey('TC-1', 'ws-1');

    expect(captured).toHaveLength(1);
    expect(whereOf(captured[0].sql)).not.toContain('team_id');
  });

  describe('findMaxRank (BR7 — Phase B)', () => {
    it('scopes by work_item_id + workspace_id + deleted_at IS NULL, ordered rank desc, id asc', async () => {
      const { repo, captured } = recordingRepo();

      // `findMaxRank` takes the caller's transaction executor (never the pool) — a plain db proxy
      // stands in for `tx` here since only the emitted SQL is under test.
      const db = (repo as unknown as { db: unknown }).db;
      await repo.findMaxRank('wi-1', 'ws-1', db as never);

      expect(captured).toHaveLength(1);
      expect(whereOf(captured[0].sql)).toContain('work_item_id');
      expect(whereOf(captured[0].sql)).toContain('deleted_at');
      expect(captured[0].sql).toMatch(/order by "work"\."test_cases"\."rank" desc/);
      expect(whereOf(captured[0].sql)).not.toContain('team_id');
    });
  });

  describe('listSelectableTypes (BR2 — Phase B)', () => {
    it('scopes by project_id + workspace_id + archived_at IS NULL, ordered by position', async () => {
      const { repo, captured } = recordingRepo();

      await repo.listSelectableTypes('proj-1', 'ws-1');

      expect(captured).toHaveLength(1);
      expect(whereOf(captured[0].sql)).toContain('project_id');
      expect(whereOf(captured[0].sql)).toContain('archived_at');
      expect(captured[0].sql).toMatch(/order by "work"\."test_case_types"\."position" asc/);
    });
  });
});
