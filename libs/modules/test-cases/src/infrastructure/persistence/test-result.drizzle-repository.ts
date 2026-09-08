import { Injectable } from '@nestjs/common';
import { and, desc, eq, getTableColumns, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { InjectDrizzle } from '@platform';
import type { DrizzleDB, DbExecutor } from '@platform';
import { testResults } from '../../../../../../db/schema/work';
import { users } from '../../../../../../db/schema/identity';
import type { TestResult } from '../../domain/test-result.types';
import {
  CreateTestResultInput,
  ITestResultRepository,
} from '../../domain/ports/test-result.repository';

/** Same name-resolution shape as `TestCaseDrizzleRepository`'s owner/assignee joins — a name is a
 *  property of the ROW (CLAUDE.md), never of a picker feed. */
const TR_TESTER_USER = alias(users, 'tr_tester');
const TESTER_NAME = sql<
  string | null
>`coalesce(${TR_TESTER_USER.displayName}, ${TR_TESTER_USER.email})`;

@Injectable()
export class TestResultDrizzleRepository implements ITestResultRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  private selectWithNames() {
    return this.db
      .select({ ...getTableColumns(testResults), testerName: TESTER_NAME })
      .from(testResults)
      .leftJoin(TR_TESTER_USER, eq(TR_TESTER_USER.id, testResults.testerId));
  }

  // BR14: `run_date desc, created_at desc` — the same ordering `trg_test_case_last_result`
  // itself uses, over the SAME index (`ix_test_results_case_run_date`). `id desc` is a final
  // tiebreaker for determinism when both are equal (query-ordering.ratchet.spec.ts's rule).
  async listByTestCase(testCaseId: string, workspaceId: string): Promise<TestResult[]> {
    const rows = await this.selectWithNames()
      .where(
        and(
          eq(testResults.testCaseId, testCaseId),
          eq(testResults.workspaceId, workspaceId),
          sql`${testResults.deletedAt} IS NULL`,
        ),
      )
      .orderBy(desc(testResults.runDate), desc(testResults.createdAt), desc(testResults.id));
    return rows.map((r) => this.mapRow(r));
  }

  async findById(id: string, workspaceId: string): Promise<TestResult | null> {
    const rows = await this.selectWithNames().where(
      and(
        eq(testResults.id, id),
        eq(testResults.workspaceId, workspaceId),
        sql`${testResults.deletedAt} IS NULL`,
      ),
    );
    return rows[0] ? this.mapRow(rows[0]) : null;
  }

  async nextKeyNumber(workspaceId: string, executor?: DbExecutor): Promise<number> {
    const exec = executor ?? this.db;
    const rows = await exec
      .select({
        n: sql<number>`COALESCE(MAX(substring(${testResults.testResultKey} from '[0-9]+$')::int), 0)::int`,
      })
      .from(testResults)
      .where(eq(testResults.workspaceId, workspaceId));
    return (rows[0]?.n ?? 0) + 1;
  }

  async create(input: CreateTestResultInput, executor: DbExecutor): Promise<TestResult> {
    await executor.insert(testResults).values({
      id: input.id,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      testCaseId: input.testCaseId,
      workItemId: input.workItemId,
      testResultKey: input.testResultKey,
      build: input.build,
      runDate: input.runDate,
      verdict: input.verdict,
      durationMinutes: input.durationMinutes,
      testerId: input.testerId,
      notes: input.notes,
      createdBy: input.createdBy,
    });
    // Re-select through the tester name join on the SAME executor, matching
    // `TestCaseDrizzleRepository.create`'s reasoning: a stale connection would not yet see the row
    // committed elsewhere, and `RETURNING` alone would leave `testerName` null.
    const rows = await executor
      .select({ ...getTableColumns(testResults), testerName: TESTER_NAME })
      .from(testResults)
      .leftJoin(TR_TESTER_USER, eq(TR_TESTER_USER.id, testResults.testerId))
      .where(eq(testResults.id, input.id));
    return this.mapRow(rows[0]);
  }

  private mapRow(row: typeof testResults.$inferSelect & { testerName: string | null }): TestResult {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      testCaseId: row.testCaseId,
      workItemId: row.workItemId,
      testResultKey: row.testResultKey,
      build: row.build,
      runDate: row.runDate,
      verdict: row.verdict as TestResult['verdict'],
      durationMinutes: row.durationMinutes,
      testerId: row.testerId,
      testerName: row.testerName,
      notes: row.notes,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
