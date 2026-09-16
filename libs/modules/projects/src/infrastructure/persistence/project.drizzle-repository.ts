import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { InjectDrizzle, buildPageResult, keysetCondition } from '@platform';
import type { DrizzleDB, DbExecutor, CursorPayload, PagedResult } from '@platform';
import {
  projects,
  workspaceItemCounters,
  projectMembers,
  projectTeams,
  workItems,
  workflowStatuses,
  iterations,
} from '../../../../../../db/schema/work';
import type { WorkItemType } from '../../domain/ports/project.repository';
import { users } from '../../../../../../db/schema/identity';
import type {
  Project,
  ProjectWithStats,
  ProjectHealth,
  CreateProjectInput,
  UpdateProjectInput,
} from '../../domain/project.types';
import { IProjectRepository } from '../../domain/ports/project.repository';
import { selectWorkspaceAdminUserIds } from '@modules/access';

@Injectable()
export class ProjectDrizzleRepository implements IProjectRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  async findById(id: string, workspaceId: string): Promise<Project | null> {
    const rows = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.workspaceId, workspaceId)))
      .limit(1);
    return (rows[0] as Project | undefined) ?? null;
  }

  async findByKey(workspaceId: string, key: string): Promise<Project | null> {
    const rows = await this.db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.workspaceId, workspaceId),
          eq(projects.key, key),
          isNull(projects.deletedAt),
        ),
      )
      .limit(1);
    return (rows[0] as Project | undefined) ?? null;
  }

  async listByWorkspace(
    workspaceId: string,
    { limit, cursor }: { limit: number; cursor: CursorPayload | null },
  ): Promise<PagedResult<Project>> {
    const conditions = [eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)];

    if (cursor) {
      conditions.push(keysetCondition(projects.createdAt, projects.id, cursor));
    }

    const rows = await this.db
      .select()
      .from(projects)
      .where(and(...conditions))
      .orderBy(asc(projects.createdAt), asc(projects.id))
      .limit(limit + 1);

    return buildPageResult(rows as Project[], limit, (p) => [p.createdAt.toISOString()]);
  }

  async listByWorkspaceWithStats(
    workspaceId: string,
    { limit, cursor }: { limit: number; cursor: CursorPayload | null },
    readableProjectIds: string[] | null,
  ): Promise<PagedResult<ProjectWithStats>> {
    const conditions = [eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)];

    /**
     * `null` is UNRESTRICTED; an array — including an EMPTY one — restricts.
     *
     * The empty case has to short-circuit rather than fall through: `inArray(col, [])` is not portable
     * across drivers as "match nothing", and getting it wrong here would return the whole workspace to
     * a principal with no readable projects. Failing closed is the only acceptable direction.
     */
    if (readableProjectIds !== null) {
      if (readableProjectIds.length === 0) {
        return buildPageResult<ProjectWithStats>([], limit, (p) => [p.createdAt.toISOString()]);
      }
      conditions.push(inArray(projects.id, readableProjectIds));
    }

    if (cursor) {
      conditions.push(keysetCondition(projects.createdAt, projects.id, cursor));
    }

    const rows = await this.db
      .select()
      .from(projects)
      .where(and(...conditions))
      .orderBy(asc(projects.createdAt), asc(projects.id))
      .limit(limit + 1);

    const page = buildPageResult(rows as Project[], limit, (p) => [p.createdAt.toISOString()]);

    if (page.data.length === 0) {
      return { ...page, data: [] };
    }

    // Count active members per project (no N+1: single query).
    //
    // Workspace Admins are excluded, because this number is rendered as the SIZE of the roster
    // `listProjectMembers` returns and §2.1 keeps a WA out of that roster — a count that includes
    // a member the list beside it omits is the two-readers-disagreeing bug, not a rounding
    // difference. One shared predicate, so the two cannot drift; see
    // `selectWorkspaceAdminUserIds`.
    const projectIds = page.data.map((p) => p.id);
    const adminUserIds = await selectWorkspaceAdminUserIds(this.db, workspaceId);
    const memberCountRows = await this.db
      .select({
        projectId: projectMembers.projectId,
        count: sql<number>`SUM(CASE WHEN ${projectMembers.status} = 'active' THEN 1 ELSE 0 END)::int`,
      })
      .from(projectMembers)
      .where(
        and(
          inArray(projectMembers.projectId, projectIds),
          // `notInArray(col, [])` is not portable as "match everything", so the empty case —
          // a workspace with no admin — is skipped rather than emitted.
          ...(adminUserIds.length > 0 ? [notInArray(projectMembers.userId, adminUserIds)] : []),
        ),
      )
      .groupBy(projectMembers.projectId);

    const countMap: Record<string, number> = {};
    for (const row of memberCountRows) {
      countMap[row.projectId] = row.count;
    }

    // Count linked active teams per project (no N+1: single query)
    const teamCountRows = await this.db
      .select({
        projectId: projectTeams.projectId,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(projectTeams)
      .where(and(inArray(projectTeams.projectId, projectIds), eq(projectTeams.status, 'active')))
      .groupBy(projectTeams.projectId);

    const teamCountMap: Record<string, number> = {};
    for (const row of teamCountRows) {
      teamCountMap[row.projectId] = row.count;
    }

    // Resolve lead display names (no N+1: single query)
    const leadIds = [
      ...new Set(page.data.map((p) => p.leadId).filter((id): id is string => id != null)),
    ];
    const leadNameMap: Record<string, string> = {};
    if (leadIds.length > 0) {
      const leadRows = await this.db
        .select({ id: users.id, displayName: users.displayName })
        .from(users)
        .where(inArray(users.id, leadIds));
      for (const u of leadRows) {
        leadNameMap[u.id] = u.displayName;
      }
    }

    return {
      ...page,
      data: page.data.map((p) => ({
        ...p,
        memberCount: countMap[p.id] ?? 0,
        teamCount: teamCountMap[p.id] ?? 0,
        leadName: p.leadId != null ? (leadNameMap[p.leadId] ?? null) : null,
      })),
    };
  }

  /**
   * Bounded, attention-sorted per-project health rollup for the Home widget.
   * Computed with a fixed, small set of batched queries (active projects, one
   * grouped work-item aggregate, committed iterations, lead names) — NOT one
   * query per project — so cost is independent of project count.
   */
  async listHealthByWorkspace(
    workspaceId: string,
    { limit }: { limit: number },
    readableProjectIds: string[] | null,
  ): Promise<ProjectHealth[]> {
    const conditions = [
      eq(projects.workspaceId, workspaceId),
      eq(projects.status, 'active'),
      isNull(projects.deletedAt),
    ];

    /**
     * Same sentinel contract as `listByWorkspaceWithStats`: `null` is UNRESTRICTED, an array —
     * including an EMPTY one — restricts, and the empty case short-circuits because
     * `inArray(col, [])` is not portable as "match nothing".
     *
     * This widget was scoped by `workspace_id` alone, which meant a principal with access to no
     * project at all received every active project's key, name, lead name, active sprint name,
     * open-defect count, blocked count and progress percentage. The route's own
     * `@AuthorizedInService` decorator claimed it was "scoped by listReadableProjectIds, like the
     * list above" — it was not, and nothing checked, because the spec that citation named did not
     * exist. Found the moment `test/e2e/project-authz.e2e.spec.ts` was written.
     */
    if (readableProjectIds !== null) {
      if (readableProjectIds.length === 0) return [];
      conditions.push(inArray(projects.id, readableProjectIds));
    }

    // 1. Active projects in the workspace the caller may read.
    const projectRows = await this.db
      .select({
        id: projects.id,
        key: projects.key,
        name: projects.name,
        leadId: projects.leadId,
      })
      .from(projects)
      .where(and(...conditions));
    if (projectRows.length === 0) return [];

    // 2. Work-item rollup per project — ONE grouped query over the workspace.
    //    "done" is the workflow-status category (matches the grid's definition).
    const aggRows = await this.db
      .select({
        projectId: workItems.projectId,
        total: sql<number>`count(*)::int`,
        done: sql<number>`sum(case when ${workflowStatuses.category} = 'done' then 1 else 0 end)::int`,
        openDefects: sql<number>`sum(case when ${workItems.type} = 'defect' and ${workflowStatuses.category} <> 'done' then 1 else 0 end)::int`,
        blocked: sql<number>`sum(case when ${workItems.isBlocked} then 1 else 0 end)::int`,
      })
      .from(workItems)
      .innerJoin(workflowStatuses, eq(workflowStatuses.id, workItems.statusId))
      .where(and(eq(workItems.workspaceId, workspaceId), isNull(workItems.deletedAt)))
      .groupBy(workItems.projectId);
    const aggMap = new Map(aggRows.map((r) => [r.projectId, r]));

    // 3. Active (committed) iteration name per project — ONE query.
    const iterRows = await this.db
      .select({ projectId: iterations.projectId, name: iterations.name })
      .from(iterations)
      .where(and(eq(iterations.workspaceId, workspaceId), eq(iterations.state, 'committed')));
    const sprintMap = new Map<string, string>();
    for (const r of iterRows) if (!sprintMap.has(r.projectId)) sprintMap.set(r.projectId, r.name);

    // 4. Lead display names — ONE query.
    const leadIds = [
      ...new Set(projectRows.map((p) => p.leadId).filter((id): id is string => id != null)),
    ];
    const leadNameMap = new Map<string, string>();
    if (leadIds.length > 0) {
      const leadRows = await this.db
        .select({ id: users.id, displayName: users.displayName })
        .from(users)
        .where(inArray(users.id, leadIds));
      for (const u of leadRows) leadNameMap.set(u.id, u.displayName);
    }

    // Assemble, sort by attention (blocked, then open defects, then name), cap.
    const rows: ProjectHealth[] = projectRows.map((p) => {
      const a = aggMap.get(p.id);
      const total = a?.total ?? 0;
      const done = a?.done ?? 0;
      return {
        id: p.id,
        key: p.key,
        name: p.name,
        leadId: p.leadId,
        leadName: p.leadId != null ? (leadNameMap.get(p.leadId) ?? null) : null,
        activeSprintName: sprintMap.get(p.id) ?? null,
        progressPercent: total > 0 ? Math.round((done / total) * 100) : 0,
        openDefects: a?.openDefects ?? 0,
        blockedCount: a?.blocked ?? 0,
      };
    });
    rows.sort(
      (x, y) =>
        y.blockedCount - x.blockedCount ||
        y.openDefects - x.openDefects ||
        x.name.localeCompare(y.name),
    );
    return rows.slice(0, limit);
  }

  async create(input: CreateProjectInput, tx?: DbExecutor): Promise<Project> {
    const rows = await (tx ?? this.db)
      .insert(projects)
      .values({
        id: input.id,
        workspaceId: input.workspaceId,
        key: input.key,
        name: input.name,
        description: input.description,
        leadId: input.leadId,
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
      })
      .returning();
    return rows[0] as Project;
  }

  async update(
    id: string,
    input: UpdateProjectInput,
    workspaceId: string,
    tx?: DbExecutor,
  ): Promise<Project> {
    const rows = await (tx ?? this.db)
      .update(projects)
      .set({
        ...(input.key !== undefined && { key: input.key }),
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.leadId !== undefined && { leadId: input.leadId }),
        ...(input.startDate !== undefined && { startDate: input.startDate }),
        ...(input.endDate !== undefined && { endDate: input.endDate }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.settings !== undefined && { settings: input.settings }),
        updatedAt: new Date(),
      })
      .where(and(eq(projects.id, id), eq(projects.workspaceId, workspaceId)))
      .returning();
    return rows[0] as Project;
  }

  async softDelete(id: string, workspaceId: string, tx?: DbExecutor): Promise<void> {
    await (tx ?? this.db)
      .update(projects)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(projects.id, id), eq(projects.workspaceId, workspaceId)));
  }

  async initCounter(workspaceId: string, tx?: DbExecutor): Promise<void> {
    const db = tx ?? this.db;
    // Seed a workspace-wide counter row for every work-item type so any type can
    // be created. Idempotent — the first project in a workspace seeds them; later
    // projects no-op. (Counter is per-workspace, not per-project.)
    const types = ['story', 'task', 'defect'] as const;
    for (const itemType of types) {
      await db
        .insert(workspaceItemCounters)
        .values({ workspaceId, itemType, lastItemNumber: 0 })
        .onConflictDoNothing();
    }
  }

  async incrementCounter(
    workspaceId: string,
    itemType: WorkItemType,
    tx?: DbExecutor,
  ): Promise<number> {
    const db = tx ?? this.db;
    // Upsert-then-increment so a workspace that predates its counter row (or was
    // never seeded) still allocates from 1 instead of throwing on a missing row.
    const rows = await db
      .insert(workspaceItemCounters)
      .values({ workspaceId, itemType, lastItemNumber: 1 })
      .onConflictDoUpdate({
        target: [workspaceItemCounters.workspaceId, workspaceItemCounters.itemType],
        set: {
          lastItemNumber: sql`${workspaceItemCounters.lastItemNumber} + 1`,
          updatedAt: new Date(),
        },
      })
      .returning({ lastItemNumber: workspaceItemCounters.lastItemNumber });
    return rows[0].lastItemNumber;
  }

  async getMaxItemNumber(workspaceId: string, itemType: WorkItemType): Promise<number> {
    const row = await this.db
      .select({ max: sql<number>`COALESCE(MAX(${workspaceItemCounters.lastItemNumber}), 0)` })
      .from(workspaceItemCounters)
      .where(
        and(
          eq(workspaceItemCounters.workspaceId, workspaceId),
          eq(workspaceItemCounters.itemType, itemType),
        ),
      );
    return row[0].max;
  }
}
