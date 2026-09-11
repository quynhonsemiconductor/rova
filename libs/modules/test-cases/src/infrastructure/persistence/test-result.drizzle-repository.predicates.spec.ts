/**
 * `TestResultDrizzleRepository.softDeleteByTestCaseIds` (F1/F4) — the one set-based write this
 * repository needs proven at the SQL level: the app doing explicitly, as a bulk UPDATE, what
 * `test_results.test_case_id`'s `ON DELETE cascade` cannot (that FK never fires for a soft
 * delete, which is an UPDATE, not a DELETE). Follows
 * `test-case.drizzle-repository.predicates.spec.ts`'s shape.
 */
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/pg-proxy';
import type { DrizzleDB } from '@platform';
import { TestResultDrizzleRepository } from './test-result.drizzle-repository';

interface Captured {
  sql: string;
  params: unknown[];
}

function recordingRepo(): { repo: TestResultDrizzleRepository; captured: Captured[] } {
  const captured: Captured[] = [];
  const db = drizzle(async (sql, params) => {
    captured.push({ sql, params });
    return { rows: [] };
  });
  return { repo: new TestResultDrizzleRepository(db as unknown as DrizzleDB), captured };
}

function whereOf(sql: string): string {
  const at = sql.indexOf(' where ');
  return at === -1 ? '' : sql.slice(at);
}

describe('TestResultDrizzleRepository.softDeleteByTestCaseIds (F1/F4)', () => {
  it('emits ONE set-based UPDATE scoped to LIVE rows of the given Test Case ids', async () => {
    const { repo, captured } = recordingRepo();
    const db = (repo as unknown as { db: unknown }).db;

    await repo.softDeleteByTestCaseIds(['tc-1', 'tc-2'], 'ws-1', db as never);

    expect(captured).toHaveLength(1);
    expect(captured[0].sql).toMatch(/^update /);
    expect(whereOf(captured[0].sql)).toContain('test_case_id');
    expect(whereOf(captured[0].sql)).toContain('workspace_id');
    expect(whereOf(captured[0].sql)).toContain('deleted_at');
  });

  it('is a no-op for an empty list — never an UPDATE with an empty IN()', async () => {
    const { repo, captured } = recordingRepo();
    const db = (repo as unknown as { db: unknown }).db;

    await repo.softDeleteByTestCaseIds([], 'ws-1', db as never);

    expect(captured).toHaveLength(0);
  });
});
