import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { InjectDrizzle } from '@platform';
import type { DrizzleDB, DbExecutor } from '@platform';
import {
  teams,
  teamMembers,
  projects,
  projectTeams,
  capacityPlans,
  capacityPlanTeams,
} from '../../../../../../db/schema/work';
import type {
  Team,
  TeamWithStats,
  TeamProjectLink,
  CreateTeamInput,
  UpdateTeamInput,
} from '../../domain/team.types';
import { ITeamRepository } from '../../domain/ports/team.repository';

@Injectable()
export class TeamDrizzleRepository implements ITeamRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  // Every read carries an explicit workspace_id predicate. This is defence in
  // depth that holds even when the query runs outside an RLS workspace context
  // (e.g. a superuser connection in dev, where RLS is bypassed) — workspace
  // isolation never depends on RLS + connection role alone.
  async findById(id: string, workspaceId: string): Promise<Team | null> {
    const rows = await this.db
      .select()
      .from(teams)
      .where(and(eq(teams.id, id), eq(teams.workspaceId, workspaceId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async findByKey(workspaceId: string, key: string): Promise<Team | null> {
    const rows = await this.db
      .select()
      .from(teams)
      .where(and(eq(teams.workspaceId, workspaceId), eq(teams.key, key)))
      .limit(1);
    return rows[0] ?? null;
  }

  async listByWorkspaceWithStats(
    workspaceId: string,
    includeInactive = false,
  ): Promise<TeamWithStats[]> {
    const rows = await this.db
      .select()
      .from(teams)
      .where(
        includeInactive
          ? eq(teams.workspaceId, workspaceId)
          : and(eq(teams.workspaceId, workspaceId), eq(teams.status, 'active')),
      )
      .orderBy(teams.name, asc(teams.id));

    if (rows.length === 0) {
      return [];
    }

    // Count active members per team (no N+1: single grouped query).
    const teamIds = rows.map((t) => t.id);
    const countRows = await this.db
      .select({
        teamId: teamMembers.teamId,
        count: sql<number>`SUM(CASE WHEN ${teamMembers.status} = 'active' THEN 1 ELSE 0 END)::int`,
      })
      .from(teamMembers)
      .where(inArray(teamMembers.teamId, teamIds))
      .groupBy(teamMembers.teamId);

    const countMap: Record<string, number> = {};
    for (const row of countRows) {
      countMap[row.teamId] = row.count;
    }

    // Active project links per team (single join, oldest-first per team).
    const linkRows = await this.db
      .select({
        teamId: projectTeams.teamId,
        projectId: projectTeams.projectId,
        key: projects.key,
        name: projects.name,
        linkedAt: projectTeams.linkedAt,
      })
      .from(projectTeams)
      .innerJoin(projects, eq(projectTeams.projectId, projects.id))
      .where(and(inArray(projectTeams.teamId, teamIds), eq(projectTeams.status, 'active')))
      .orderBy(projectTeams.linkedAt, asc(projectTeams.id));

    const projectsMap: Record<string, TeamProjectLink[]> = {};
    for (const row of linkRows) {
      (projectsMap[row.teamId] ??= []).push({
        projectId: row.projectId,
        key: row.key,
        name: row.name,
      });
    }

    return rows.map((t) => ({
      ...t,
      memberCount: countMap[t.id] ?? 0,
      projects: projectsMap[t.id] ?? [],
    }));
  }

  async listActiveProjectIds(teamId: string): Promise<string[]> {
    const rows = await this.db
      .select({ projectId: projectTeams.projectId })
      .from(projectTeams)
      .where(and(eq(projectTeams.teamId, teamId), eq(projectTeams.status, 'active')));
    return rows.map((r) => r.projectId);
  }

  async countProjectsInWorkspace(workspaceId: string, projectIds: string[]): Promise<number> {
    if (projectIds.length === 0) return 0;
    const rows = await this.db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), inArray(projects.id, projectIds)));
    return rows[0]?.count ?? 0;
  }

  async findBlockingCapacityPlans(
    workspaceId: string,
    teamId: string,
    projectIds: string[],
  ): Promise<Array<{ planKey: string }>> {
    if (projectIds.length === 0) return [];
    return this.db
      .select({ planKey: capacityPlans.planKey })
      .from(capacityPlanTeams)
      .innerJoin(capacityPlans, eq(capacityPlans.id, capacityPlanTeams.planId))
      .where(
        and(
          eq(capacityPlanTeams.teamId, teamId),
          eq(capacityPlans.workspaceId, workspaceId),
          inArray(capacityPlans.projectId, projectIds),
        ),
      )
      .limit(3);
  }

  async setProjectLinks(
    workspaceId: string,
    teamId: string,
    projectIds: string[],
    tx: DbExecutor,
  ): Promise<void> {
    const now = new Date();

    // Deactivate any active link not in the desired set.
    const deactivate = tx
      .update(projectTeams)
      .set({ status: 'unlinked', unlinkedAt: now })
      .where(
        projectIds.length > 0
          ? and(
              eq(projectTeams.teamId, teamId),
              eq(projectTeams.status, 'active'),
              notInArray(projectTeams.projectId, projectIds),
            )
          : and(eq(projectTeams.teamId, teamId), eq(projectTeams.status, 'active')),
      );
    await deactivate;

    // Upsert each desired link to active (reactivates a previously-unlinked row).
    for (const projectId of projectIds) {
      await tx
        .insert(projectTeams)
        .values({
          id: uuidv7(),
          workspaceId,
          projectId,
          teamId,
          status: 'active',
          linkedAt: now,
          unlinkedAt: null,
        })
        .onConflictDoUpdate({
          target: [projectTeams.projectId, projectTeams.teamId],
          set: { status: 'active', linkedAt: now, unlinkedAt: null },
        });
    }
  }

  async create(input: CreateTeamInput, tx?: DbExecutor): Promise<Team> {
    const rows = await (tx ?? this.db)
      .insert(teams)
      .values({
        id: input.id,
        workspaceId: input.workspaceId,
        name: input.name,
        key: input.key.toUpperCase(),
        description: input.description ?? null,
        leadId: input.leadId ?? null,
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    return rows[0];
  }

  async update(id: string, input: UpdateTeamInput, tx?: DbExecutor): Promise<Team> {
    const rows = await (tx ?? this.db)
      .update(teams)
      .set({
        ...(input.key !== undefined && { key: input.key }),
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.leadId !== undefined && { leadId: input.leadId }),
        ...(input.status !== undefined && { status: input.status }),
        updatedAt: new Date(),
      })
      .where(eq(teams.id, id))
      .returning();
    return rows[0];
  }

  /**
   * One statement, one row per source that still points at this team. See the port for WHY each source
   * is here: half of them have no foreign key (so a delete dangles them) and the other half cascade
   * (so a delete destroys frozen report history).
   *
   * Raw SQL rather than a builder because this is a UNION of counts over eight unrelated tables, and
   * the shape is the point — a reader has to be able to see at a glance that nothing was left out.
   * Zero rows are filtered in SQL so the caller's "is it empty?" is the whole check.
   */
  async countHistoryReferences(
    teamId: string,
    workspaceId: string,
  ): Promise<Array<{ source: string; count: number }>> {
    const rows = await this.db.execute<{ source: string; count: number }>(sql`
      select source, count from (
        select 'work items' as source, count(*)::int as count
          from work.work_items where team_id = ${teamId} and workspace_id = ${workspaceId}
        union all
        select 'tasks', count(*)::int
          from work.tasks where team_id = ${teamId} and workspace_id = ${workspaceId}
        union all
        select 'iterations', count(*)::int
          from work.iterations where team_id = ${teamId} and workspace_id = ${workspaceId}
        union all
        select 'portfolio items', count(*)::int
          from work.portfolio_items where team_id = ${teamId} and workspace_id = ${workspaceId}
        union all
        select 'capacity plans', count(*)::int
          from work.capacity_plan_teams where team_id = ${teamId}
        union all
        select 'capacity allocations', count(*)::int
          from work.capacity_plan_allocations where team_id = ${teamId}
        union all
        select 'member capacity rows', count(*)::int
          from work.member_capacity where team_id = ${teamId}
        union all
        select 'recorded report history', count(*)::int
          from work.iteration_daily_snapshots where team_id = ${teamId}
      ) counts
      where count > 0
      order by source
    `);
    return rows.rows;
  }

  /**
   * Deletes the team, its roster and its project links, in that caller's transaction.
   *
   * Roster and links first: neither carries a foreign key to `teams`, so the database would leave both
   * behind pointing at nothing. Order matters only for readability here — there is no constraint to
   * satisfy, which is precisely the hazard.
   */
  async deleteTeam(teamId: string, workspaceId: string, tx?: DbExecutor): Promise<void> {
    const exec = tx ?? this.db;
    await exec.delete(teamMembers).where(eq(teamMembers.teamId, teamId));
    await exec.delete(projectTeams).where(eq(projectTeams.teamId, teamId));
    await exec.delete(teams).where(and(eq(teams.id, teamId), eq(teams.workspaceId, workspaceId)));
  }
}
