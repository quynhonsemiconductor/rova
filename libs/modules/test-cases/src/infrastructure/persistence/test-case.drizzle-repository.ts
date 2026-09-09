import { Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, getTableColumns, inArray, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { InjectDrizzle, buildPageResult, keysetCondition } from '@platform';
import type { DrizzleDB, CursorPayload, DbExecutor, PagedResult } from '@platform';
import { testCases, teams } from '../../../../../../db/schema/work';
import { users } from '../../../../../../db/schema/identity';
import type { TestCase } from '../../domain/test-case.types';
import type { TeamReadScope } from '../../domain/team-read-scope';
import {
  CreateTestCaseInput,
  ITestCaseRepository,
  UpdateTestCaseInput,
} from '../../domain/ports/test-case.repository';

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

/**
 * Team-name join — same shape as the owner/assignee ones above. NULL `teamId` (Project Backlog,
 * SRS §5) leaves this NULL through the left join; the caller renders the fallback string, never
 * this repository (CLAUDE.md: a name belongs to the row, an absent one stays absent here).
 */
const TC_TEAM = alias(teams, 'tc_team');

@Injectable()
export class TestCaseDrizzleRepository implements ITestCaseRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  private selectWithNames() {
    return this.db
      .select({
        ...getTableColumns(testCases),
        ownerName: OWNER_NAME,
        assigneeName: ASSIGNEE_NAME,
        teamName: TC_TEAM.name,
      })
      .from(testCases)
      .leftJoin(TC_OWNER_USER, eq(TC_OWNER_USER.id, testCases.ownerId))
      .leftJoin(TC_ASSIGNEE_USER, eq(TC_ASSIGNEE_USER.id, testCases.assigneeId))
      .leftJoin(TC_TEAM, eq(TC_TEAM.id, testCases.teamId));
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

  // ── Writes (Phase B) ─────────────────────────────────────────────────────

  async nextKeyNumber(workspaceId: string, executor?: DbExecutor): Promise<number> {
    const exec = executor ?? this.db;
    // '[0-9]+$' with no backslash — Drizzle's sql template drops a bare '\' before it reaches
    // Postgres, so '\d' would silently match nothing (portfolio-item.drizzle-repository.ts).
    const rows = await exec
      .select({
        n: sql<number>`COALESCE(MAX(substring(${testCases.testCaseKey} from '[0-9]+$')::int), 0)::int`,
      })
      .from(testCases)
      .where(eq(testCases.workspaceId, workspaceId));
    return (rows[0]?.n ?? 0) + 1;
  }

  /**
   * `pg_advisory_xact_lock` held until the surrounding transaction commits or rolls back — keyed on
   * the Work Item, so two Work Items' Test Case creates never contend (BR7's scope, not a project- or
   * workspace-wide one). Callers MUST take this before {@link findMaxRank} and pass the same `tx`.
   */
  async lockRankScope(workItemId: string, executor: DbExecutor): Promise<void> {
    await executor.execute(sql`select pg_advisory_xact_lock(hashtext(${workItemId}))`);
  }

  async findMaxRank(
    workItemId: string,
    workspaceId: string,
    executor: DbExecutor,
  ): Promise<string | null> {
    const rows = await executor
      .select({ rank: testCases.rank })
      .from(testCases)
      .where(
        and(
          eq(testCases.workItemId, workItemId),
          eq(testCases.workspaceId, workspaceId),
          isNull(testCases.deletedAt),
        ),
      )
      // `id` as tiebreaker keeps the pick deterministic when two rows share a rank.
      .orderBy(desc(testCases.rank), asc(testCases.id))
      .limit(1);
    return rows[0]?.rank ?? null;
  }

  async create(input: CreateTestCaseInput, executor: DbExecutor): Promise<TestCase> {
    await executor.insert(testCases).values({
      id: input.id,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      teamId: input.teamId,
      workItemId: input.workItemId,
      testCaseKey: input.testCaseKey,
      name: input.name,
      type: input.type,
      method: input.method,
      priority: input.priority,
      ownerId: input.ownerId,
      assigneeId: input.assigneeId,
      rank: input.rank,
      createdBy: input.createdBy,
    });
    // Re-select through the same name joins every other read uses (rather than trusting `RETURNING`
    // + a null name), on the SAME executor: an owner set at create must resolve to a real name in
    // the response, not `null`, and a stale connection would not yet see the row committed elsewhere.
    const rows = await executor
      .select({
        ...getTableColumns(testCases),
        ownerName: OWNER_NAME,
        assigneeName: ASSIGNEE_NAME,
        teamName: TC_TEAM.name,
      })
      .from(testCases)
      .leftJoin(TC_OWNER_USER, eq(TC_OWNER_USER.id, testCases.ownerId))
      .leftJoin(TC_ASSIGNEE_USER, eq(TC_ASSIGNEE_USER.id, testCases.assigneeId))
      .leftJoin(TC_TEAM, eq(TC_TEAM.id, testCases.teamId))
      .where(eq(testCases.id, input.id));
    return this.mapRow(rows[0]);
  }

  async update(
    id: string,
    input: UpdateTestCaseInput,
    workspaceId: string,
    executor?: DbExecutor,
  ): Promise<TestCase> {
    const exec = executor ?? this.db;
    // Built key-by-key rather than spread: `undefined` means "leave alone" and `null` means
    // "clear" for the nullable columns — spreading `input` would write nulls over untouched
    // fields (matches `PortfolioItemDrizzleRepository.update`).
    const set: Record<string, unknown> = { updatedAt: new Date() };
    const assign = <K extends keyof UpdateTestCaseInput>(key: K) => {
      if (input[key] !== undefined) set[key] = input[key];
    };
    assign('name');
    assign('description');
    assign('objective');
    assign('preconditions');
    assign('validationInput');
    assign('validationExpectedResult');
    assign('postconditions');
    assign('notes');
    assign('type');
    assign('method');
    assign('priority');
    assign('ownerId');
    assign('assigneeId');

    await exec
      .update(testCases)
      .set(set)
      .where(and(eq(testCases.id, id), eq(testCases.workspaceId, workspaceId)));

    const rows = await exec
      .select({
        ...getTableColumns(testCases),
        ownerName: OWNER_NAME,
        assigneeName: ASSIGNEE_NAME,
        teamName: TC_TEAM.name,
      })
      .from(testCases)
      .leftJoin(TC_OWNER_USER, eq(TC_OWNER_USER.id, testCases.ownerId))
      .leftJoin(TC_ASSIGNEE_USER, eq(TC_ASSIGNEE_USER.id, testCases.assigneeId))
      .leftJoin(TC_TEAM, eq(TC_TEAM.id, testCases.teamId))
      .where(
        and(
          eq(testCases.id, id),
          eq(testCases.workspaceId, workspaceId),
          sql`${testCases.deletedAt} IS NULL`,
        ),
      );
    return this.mapRow(rows[0]);
  }

  // ── Writes (Phase F) ─────────────────────────────────────────────────────

  async softDelete(id: string, workspaceId: string, executor?: DbExecutor): Promise<void> {
    const exec = executor ?? this.db;
    await exec
      .update(testCases)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(testCases.id, id), eq(testCases.workspaceId, workspaceId)));
  }

  async listLiveIdsByWorkItem(
    workItemId: string,
    workspaceId: string,
    executor: DbExecutor,
  ): Promise<string[]> {
    const rows = await executor
      .select({ id: testCases.id })
      .from(testCases)
      .where(
        and(
          eq(testCases.workItemId, workItemId),
          eq(testCases.workspaceId, workspaceId),
          isNull(testCases.deletedAt),
        ),
      );
    return rows.map((r) => r.id);
  }

  async softDeleteByWorkItem(
    workItemId: string,
    workspaceId: string,
    executor: DbExecutor,
  ): Promise<void> {
    await executor
      .update(testCases)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(testCases.workItemId, workItemId),
          eq(testCases.workspaceId, workspaceId),
          isNull(testCases.deletedAt),
        ),
      );
  }

  async findRanksByIds(
    ids: string[],
    workspaceId: string,
  ): Promise<Array<{ id: string; workItemId: string | null; rank: string }>> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select({ id: testCases.id, workItemId: testCases.workItemId, rank: testCases.rank })
      .from(testCases)
      .where(and(inArray(testCases.id, ids), eq(testCases.workspaceId, workspaceId)));
    return rows;
  }

  async updateRank(
    id: string,
    rank: string,
    workspaceId: string,
    executor?: DbExecutor,
  ): Promise<void> {
    const exec = executor ?? this.db;
    await exec
      .update(testCases)
      .set({ rank, updatedAt: new Date() })
      .where(and(eq(testCases.id, id), eq(testCases.workspaceId, workspaceId)));
  }

  private mapRow(
    row: typeof testCases.$inferSelect & {
      ownerName: string | null;
      assigneeName: string | null;
      teamName: string | null;
    },
  ): TestCase {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      teamId: row.teamId,
      teamName: row.teamName,
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
