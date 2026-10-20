import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { InjectDrizzle } from '@platform';
import type { DrizzleDB, DbExecutor } from '@platform';
import { projectMembers, teamMembers, projectTeams } from '../../../../../../db/schema/work';
import { users } from '../../../../../../db/schema/identity';
import type { ProjectMember, UpdateProjectMemberInput } from '../../domain/project.types';
import { IProjectMemberRepository } from '../../domain/ports/project-member.repository';
import { selectWorkspaceAdminProfiles, selectWorkspaceAdminUserIds } from '@modules/access';
import type { WorkspaceAdminProfile } from '@modules/access';

@Injectable()
export class ProjectMemberDrizzleRepository implements IProjectMemberRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  async findMember(projectId: string, userId: string): Promise<ProjectMember | null> {
    const rows = await this.db
      .select()
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, userId),
          eq(projectMembers.status, 'active'),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async findMemberById(id: string): Promise<ProjectMember | null> {
    const rows = await this.db
      .select()
      .from(projectMembers)
      .where(eq(projectMembers.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async listByProject(projectId: string): Promise<ProjectMember[]> {
    // Explicit project members.
    const explicit = await this.db
      .select({
        id: projectMembers.id,
        workspaceId: projectMembers.workspaceId,
        projectId: projectMembers.projectId,
        userId: projectMembers.userId,
        accessLevel: projectMembers.accessLevel,
        status: projectMembers.status,
        joinedAt: projectMembers.joinedAt,
        updatedAt: projectMembers.updatedAt,
        displayName: users.displayName,
        email: users.email,
        avatarUrl: users.avatarUrl,
      })
      .from(projectMembers)
      .leftJoin(users, eq(projectMembers.userId, users.id))
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.status, 'active')))
      .orderBy(projectMembers.joinedAt, asc(projectMembers.id));

    // Team-derived members: a user on a team LINKED to this project is a legitimate
    // Owner candidate on its work items even without an explicit project_members row
    // (TS-008 / P1-DC-012 — root cause of "added a team member, then they are not in
    // the Owner dropdown"). project_members and team_members stay separate tables
    // (this app deliberately does not collapse project and team the way Rally does);
    // this is read-only derivation for ownership eligibility, not a write-side sync,
    // so it can never drift the way a hook on addTeamMember would. Explicit members
    // win on conflict because they carry a real project role.
    const teamDerived = await this.db
      .select({
        id: teamMembers.id,
        workspaceId: teamMembers.workspaceId,
        projectId: projectTeams.projectId,
        userId: teamMembers.userId,
        status: teamMembers.status,
        joinedAt: teamMembers.joinedAt,
        updatedAt: teamMembers.createdAt,
        displayName: users.displayName,
        email: users.email,
        avatarUrl: users.avatarUrl,
      })
      .from(teamMembers)
      .innerJoin(
        projectTeams,
        and(
          eq(projectTeams.teamId, teamMembers.teamId),
          eq(projectTeams.projectId, projectId),
          eq(projectTeams.status, 'active'),
        ),
      )
      .leftJoin(users, eq(teamMembers.userId, users.id))
      .where(eq(teamMembers.status, 'active'));

    // Dedupe by userId: a user on >1 team linked to this project would otherwise
    // appear once per team. Explicit members win; among team-derived, first wins.
    const seenUserIds = new Set(explicit.map((m) => m.userId));
    const teamOnly = teamDerived
      .filter((m) => {
        if (seenUserIds.has(m.userId)) return false;
        seenUserIds.add(m.userId);
        return true;
      })
      .map((m) => ({
        ...m,
        accessLevel: null as string | null,
      })) as unknown as ProjectMember[];

    // Per-user team count, scoped to Teams LINKED to THIS project — the same
    // scoping every delivery surface uses to slice by team
    // (project_teams.projectId = this project, active on both sides). One
    // grouped query regardless of member count (O(1) round trips, not one per
    // member), merged into both member sets below by userId. This is what lets
    // the roster flag an Editor who holds the access level but has zero teams
    // to act in — a legal-but-useless grant, same shape as an unattached IAM
    // policy — without a per-row query.
    const teamCountRows = await this.db
      .select({
        userId: teamMembers.userId,
        teamCount: sql<number>`COUNT(DISTINCT ${teamMembers.teamId})::int`,
      })
      .from(teamMembers)
      .innerJoin(
        projectTeams,
        and(
          eq(projectTeams.teamId, teamMembers.teamId),
          eq(projectTeams.projectId, projectId),
          eq(projectTeams.status, 'active'),
        ),
      )
      .where(eq(teamMembers.status, 'active'))
      .groupBy(teamMembers.userId);
    const teamCountByUserId = new Map(teamCountRows.map((r) => [r.userId, r.teamCount]));

    const withTeamCount = (m: ProjectMember): ProjectMember => ({
      ...m,
      teamCount: teamCountByUserId.get(m.userId) ?? 0,
    });
    return [...explicit.map(withTeamCount), ...teamOnly.map(withTeamCount)];
  }

  /** §2.1 — see `selectWorkspaceAdminUserIds` for why this is one shared query. */
  async listWorkspaceAdminUserIds(workspaceId: string): Promise<string[]> {
    return selectWorkspaceAdminUserIds(this.db, workspaceId);
  }

  async listWorkspaceAdminProfiles(workspaceId: string): Promise<WorkspaceAdminProfile[]> {
    return selectWorkspaceAdminProfiles(this.db, workspaceId);
  }

  async updateMember(
    id: string,
    input: UpdateProjectMemberInput,
    tx?: DbExecutor,
  ): Promise<ProjectMember> {
    const rows = await (tx ?? this.db)
      .update(projectMembers)
      .set({
        ...(input.accessLevel !== undefined && { accessLevel: input.accessLevel }),
        ...(input.status !== undefined && { status: input.status }),
        updatedAt: new Date(),
      })
      .where(eq(projectMembers.id, id))
      .returning();
    return rows[0];
  }

  async removeMember(
    projectId: string,
    userId: string,
    actorId: string,
    tx?: DbExecutor,
  ): Promise<void> {
    const db = tx ?? this.db;
    await db
      .update(projectMembers)
      .set({ status: 'removed', updatedAt: new Date() })
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
    // No Access means NO access — the FE confirm dialog promises "their Team memberships
    // will be removed" on this exact action. Without this delete the rows survive, so
    // re-adding the user later silently restores their old team scope (and an Editor's
    // team-derived write boundary) with no re-assignment step and no trace.
    await db.delete(teamMembers).where(
      and(
        eq(teamMembers.userId, userId),
        inArray(
          teamMembers.teamId,
          this.db
            .select({ teamId: projectTeams.teamId })
            .from(projectTeams)
            .where(and(eq(projectTeams.projectId, projectId), eq(projectTeams.status, 'active'))),
        ),
      ),
    );
    // Unassign their tasks in this project's teams, same rule removeTeamMember already
    // enforces: Team Status folds in any user who still owns a task, so a No-Access
    // member otherwise stays visible in Team Status / assignee cells indefinitely.
    // Scoped by the project's actively-linked teams so tasks elsewhere are untouched.
    await db.execute(sql`
      UPDATE work.tasks t
      SET assignee_id = NULL, updated_by = ${actorId}, updated_at = NOW()
      WHERE t.assignee_id = ${userId}
        AND t.deleted_at IS NULL
        AND COALESCE(
              t.team_id,
              (SELECT wi.team_id FROM work.work_items wi WHERE wi.id = t.parent_id),
              (SELECT it.team_id FROM work.iterations it WHERE it.id = t.iteration_id)
            ) IN (
              SELECT pt.team_id FROM work.project_teams pt
              WHERE pt.project_id = ${projectId} AND pt.status = 'active'
            )
    `);
  }
}
