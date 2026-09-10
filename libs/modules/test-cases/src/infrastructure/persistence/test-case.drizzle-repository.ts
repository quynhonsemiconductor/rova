import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, getTableColumns, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { InjectDrizzle, buildPageResult, keysetCondition } from '@platform';
import type { DrizzleDB, CursorPayload, PagedResult } from '@platform';
import { testCases } from '../../../../../../db/schema/work';
import { users } from '../../../../../../db/schema/identity';
import type { TestCase } from '../../domain/test-case.types';
import type { TeamReadScope } from '../../domain/team-read-scope';
import { ITestCaseRepository } from '../../domain/ports/test-case.repository';

/**
 * Owner-name join aliases, module-level so the SELECT can never be built from two different
 * definitions of one name. `coalesce(display_name, email)` matches every other grid's name
 * resolution (`ownerNameJoins` in `WorkItemDrizzleRepository`) — a name is a property of the ROW,
 * never of a picker feed (CLAUDE.md).
 */
const TC_OWNER_USER = alias(users, 'tc_owner');
const TC_ASSIGNEE_USER = alias(users, 'tc_assignee');
const OWNER_NAME = sql<
  string | null
>`coalesce(${TC_OWNER_USER.displayName}, ${TC_OWNER_USER.email})`;
const ASSIGNEE_NAME = sql<
  string | null
>`coalesce(${TC_ASSIGNEE_USER.displayName}, ${TC_ASSIGNEE_USER.email})`;

@Injectable()
export class TestCaseDrizzleRepository implements ITestCaseRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  private selectWithNames() {
    return this.db
      .select({ ...getTableColumns(testCases), ownerName: OWNER_NAME, assigneeName: ASSIGNEE_NAME })
      .from(testCases)
      .leftJoin(TC_OWNER_USER, eq(TC_OWNER_USER.id, testCases.ownerId))
      .leftJoin(TC_ASSIGNEE_USER, eq(TC_ASSIGNEE_USER.id, testCases.assigneeId));
  }

  // `scope` is accepted but never applied as a predicate — see `team-read-scope.ts`: the
  // boundary is the caller's `requireReadable` on the parent Work Item, before either method runs.
  async listByWorkItem(
    workItemId: string,
    workspaceId: string,
    args: { limit: number; cursor: CursorPayload | null },
    _scope: TeamReadScope,
  ): Promise<PagedResult<TestCase>> {
    const base = and(
      eq(testCases.workItemId, workItemId),
      eq(testCases.workspaceId, workspaceId),
      sql`${testCases.deletedAt} IS NULL`,
    );
    const where = args.cursor
      ? and(base, keysetCondition(testCases.rank, testCases.id, args.cursor))
      : base;

    const [rows, totalRow] = await Promise.all([
      this.selectWithNames()
        .where(where)
        .orderBy(asc(testCases.rank), asc(testCases.id))
        .limit(args.limit + 1),
      this.db.select({ n: count() }).from(testCases).where(base),
    ]);

    return buildPageResult(
      rows.map((r) => this.mapRow(r)),
      args.limit,
      (r) => [r.rank],
      'asc',
      totalRow[0]?.n ?? 0,
    );
  }

  async countByWorkItem(
    workItemId: string,
    workspaceId: string,
    _scope: TeamReadScope,
  ): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(testCases)
      .where(
        and(
          eq(testCases.workItemId, workItemId),
          eq(testCases.workspaceId, workspaceId),
          sql`${testCases.deletedAt} IS NULL`,
        ),
      );
    return rows[0]?.n ?? 0;
  }

  async findById(id: string, workspaceId: string): Promise<TestCase | null> {
    const rows = await this.selectWithNames().where(
      and(
        eq(testCases.id, id),
        eq(testCases.workspaceId, workspaceId),
        sql`${testCases.deletedAt} IS NULL`,
      ),
    );
    return rows[0] ? this.mapRow(rows[0]) : null;
  }

  async findByKey(testCaseKey: string, workspaceId: string): Promise<TestCase | null> {
    const rows = await this.selectWithNames().where(
      and(
        eq(testCases.testCaseKey, testCaseKey),
        eq(testCases.workspaceId, workspaceId),
        sql`${testCases.deletedAt} IS NULL`,
      ),
    );
    return rows[0] ? this.mapRow(rows[0]) : null;
  }

  private mapRow(
    row: typeof testCases.$inferSelect & { ownerName: string | null; assigneeName: string | null },
  ): TestCase {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      teamId: row.teamId,
      workItemId: row.workItemId,
      testCaseKey: row.testCaseKey,
      name: row.name,
      description: row.description,
      objective: row.objective,
      preconditions: row.preconditions,
      validationInput: row.validationInput,
      validationExpectedResult: row.validationExpectedResult,
      postconditions: row.postconditions,
      notes: row.notes,
      type: row.type,
      method: row.method,
      priority: row.priority,
      ownerId: row.ownerId,
      ownerName: row.ownerName,
      assigneeId: row.assigneeId,
      assigneeName: row.assigneeName,
      rank: row.rank,
      lastVerdict: row.lastVerdict,
      lastRun: row.lastRun,
      lastResultId: row.lastResultId,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
