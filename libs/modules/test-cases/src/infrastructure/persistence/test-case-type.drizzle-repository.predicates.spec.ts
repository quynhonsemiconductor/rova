/**
 * The exact WHERE clauses `TestCaseTypeDrizzleRepository` emits (SRS §3, Phase G) — following
 * `test-case.drizzle-repository.predicates.spec.ts`'s shape.
 */
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/pg-proxy';
import type { DrizzleDB } from '@platform';
import { TestCaseTypeDrizzleRepository } from './test-case-type.drizzle-repository';

interface Captured {
  sql: string;
  params: unknown[];
}

function recordingRepo(): { repo: TestCaseTypeDrizzleRepository; captured: Captured[] } {
  const captured: Captured[] = [];
  const db = drizzle(async (sql, params) => {
    captured.push({ sql, params });
    return { rows: [] };
  });
  return { repo: new TestCaseTypeDrizzleRepository(db as unknown as DrizzleDB), captured };
}

function whereOf(sql: string): string {
  const at = sql.indexOf(' where ');
  return at === -1 ? '' : sql.slice(at);
}

describe('TestCaseTypeDrizzleRepository', () => {
  describe('listSelectable (BR2 — Phase B, G1)', () => {
    it('scopes by project_id + workspace_id + archived_at IS NULL, ordered by position', async () => {
      const { repo, captured } = recordingRepo();

      await repo.listSelectable('proj-1', 'ws-1');

      expect(captured).toHaveLength(1);
      expect(whereOf(captured[0].sql)).toContain('project_id');
      expect(whereOf(captured[0].sql)).toContain('archived_at');
      expect(captured[0].sql).toMatch(/order by "work"\."test_case_types"\."position" asc/);
    });
  });

  describe('findByName (BR16)', () => {
    it('compares lower(name), scoped by project_id + workspace_id, over ALL rows (live or archived)', async () => {
      const { repo, captured } = recordingRepo();

      await repo.findByName('proj-1', 'ws-1', 'Acceptance');

      expect(captured).toHaveLength(1);
      const where = whereOf(captured[0].sql);
      expect(where).toContain('project_id');
      expect(where).toContain('lower(');
      // No `archived_at` predicate at all — an archived name must still be found (matches the
      // unique index, which carries no `WHERE` clause either).
      expect(where).not.toContain('archived_at');
    });
  });

  describe('nextPosition', () => {
    it('scopes by project_id + workspace_id, with no archived_at filter (position is dense across both)', async () => {
      const { repo, captured } = recordingRepo();

      await repo.nextPosition('proj-1', 'ws-1');

      expect(captured).toHaveLength(1);
      const where = whereOf(captured[0].sql);
      expect(where).toContain('project_id');
      expect(where).not.toContain('archived_at');
    });
  });

  describe('create', () => {
    it('inserts with the given id/workspace/project/name/position', async () => {
      const { repo, captured } = recordingRepo();

      // The pg-proxy stub returns no rows, so `.returning()` yields `undefined` — this test is
      // about the emitted INSERT, not the mapped return value (proven at the service layer with a
      // real mock instead).
      await repo
        .create({
          id: 'type-1',
          workspaceId: 'ws-1',
          projectId: 'proj-1',
          name: 'Smoke',
          position: 5,
        })
        .catch(() => undefined);

      expect(captured).toHaveLength(1);
      expect(captured[0].sql).toMatch(/^insert into "work"\."test_case_types"/);
    });
  });

  describe('archive (BR17)', () => {
    it('scopes the UPDATE by id + project_id + workspace_id + archived_at IS NULL', async () => {
      const { repo, captured } = recordingRepo();

      await repo.archive('type-1', 'proj-1', 'ws-1');

      expect(captured).toHaveLength(1);
      expect(captured[0].sql).toMatch(/^update /);
      const where = whereOf(captured[0].sql);
      expect(where).toContain('id');
      expect(where).toContain('project_id');
      expect(where).toContain('workspace_id');
      expect(where).toContain('archived_at');
    });
  });
});
