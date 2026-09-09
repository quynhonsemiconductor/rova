import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { InjectDrizzle } from '@platform';
import type { DrizzleDB, DbExecutor } from '@platform';
import { testCaseTypes } from '../../../../../../db/schema/work';
import type { TestCaseTypeOption } from '../../domain/ports/test-case.repository';
import type {
  ITestCaseTypeRepository,
  TestCaseType,
  CreateTestCaseTypeInput,
} from '../../domain/ports/test-case-type.repository';

function mapRow(row: typeof testCaseTypes.$inferSelect): TestCaseType {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    name: row.name,
    position: row.position,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  };
}

@Injectable()
export class TestCaseTypeDrizzleRepository implements ITestCaseTypeRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  async listSelectable(projectId: string, workspaceId: string): Promise<TestCaseTypeOption[]> {
    const rows = await this.db
      .select({ id: testCaseTypes.id, name: testCaseTypes.name, position: testCaseTypes.position })
      .from(testCaseTypes)
      .where(
        and(
          eq(testCaseTypes.projectId, projectId),
          eq(testCaseTypes.workspaceId, workspaceId),
          isNull(testCaseTypes.archivedAt),
        ),
      )
      // `id` as a final tiebreaker keeps the order deterministic, matching every other ranked
      // read in this repo (`query-ordering.ratchet.spec.ts`).
      .orderBy(asc(testCaseTypes.position), asc(testCaseTypes.name), asc(testCaseTypes.id));
    return rows;
  }

  async findByName(
    projectId: string,
    workspaceId: string,
    name: string,
  ): Promise<TestCaseType | null> {
    const rows = await this.db
      .select()
      .from(testCaseTypes)
      .where(
        and(
          eq(testCaseTypes.projectId, projectId),
          eq(testCaseTypes.workspaceId, workspaceId),
          sql`lower(${testCaseTypes.name}) = lower(${name})`,
        ),
      )
      .limit(1);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async nextPosition(
    projectId: string,
    workspaceId: string,
    executor?: DbExecutor,
  ): Promise<number> {
    const exec = executor ?? this.db;
    const rows = await exec
      .select({ n: sql<number>`COALESCE(MAX(${testCaseTypes.position}), -1) + 1` })
      .from(testCaseTypes)
      .where(
        and(eq(testCaseTypes.projectId, projectId), eq(testCaseTypes.workspaceId, workspaceId)),
      );
    return rows[0]?.n ?? 0;
  }

  async create(input: CreateTestCaseTypeInput, executor?: DbExecutor): Promise<TestCaseType> {
    const exec = executor ?? this.db;
    const rows = await exec
      .insert(testCaseTypes)
      .values({
        id: input.id,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        name: input.name,
        position: input.position,
      })
      .returning();
    return mapRow(rows[0]);
  }

  async archive(
    id: string,
    projectId: string,
    workspaceId: string,
    executor?: DbExecutor,
  ): Promise<TestCaseType | null> {
    const exec = executor ?? this.db;
    const rows = await exec
      .update(testCaseTypes)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(testCaseTypes.id, id),
          eq(testCaseTypes.projectId, projectId),
          eq(testCaseTypes.workspaceId, workspaceId),
          isNull(testCaseTypes.archivedAt),
        ),
      )
      .returning();
    return rows[0] ? mapRow(rows[0]) : null;
  }
}
