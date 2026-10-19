import { Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { InjectDrizzle } from '@platform';
import type { DrizzleDB, DbExecutor } from '@platform';
import { workspaces, workspaceMembers } from '../../../../../../db/schema/workspace';
import { users } from '../../../../../../db/schema/identity';
import { account as identityAccount } from '../../../../../../db/schema/identity-auth';
import { projectMembers, projects } from '../../../../../../db/schema/work';
import { systemRoles, userRoleAssignments } from '../../../../../../db/schema/access';
import { teams, teamMembers } from '../../../../../../db/schema/work';
import type {
  WorkspaceMember,
  WorkspaceMemberOption,
  WorkspaceMemberWithProfile,
  WorkspaceMembership,
  AddMemberInput,
  UpdateMemberInput,
  MemberTeamSummary,
} from '../../domain/workspace.types';
import { IWorkspaceMemberRepository } from '../../domain/ports/workspace-member.repository';

@Injectable()
export class WorkspaceMemberDrizzleRepository implements IWorkspaceMemberRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  async findMember(workspaceId: string, userId: string): Promise<WorkspaceMember | null> {
    const rows = await this.db
      .select()
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async findMemberById(id: string): Promise<WorkspaceMember | null> {
    const rows = await this.db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Active workspace memberships for a user, most-recently-active first (login switcher). */
  async findMembershipsForUser(userId: string): Promise<WorkspaceMembership[]> {
    const rows = await this.db
      .select({
        workspaceId: workspaceMembers.workspaceId,
        name: workspaces.name,
        slug: workspaces.slug,
        lastActiveAt: workspaceMembers.lastActiveAt,
        roleSlug: systemRoles.slug,
        roleName: systemRoles.name,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .leftJoin(
        userRoleAssignments,
        and(
          eq(userRoleAssignments.userId, workspaceMembers.userId),
          eq(userRoleAssignments.workspaceId, workspaceMembers.workspaceId),
          eq(userRoleAssignments.scopeType, 'workspace'),
        ),
      )
      .leftJoin(systemRoles, eq(systemRoles.id, userRoleAssignments.roleId))
      .where(
        and(
          eq(workspaceMembers.userId, userId),
          eq(workspaceMembers.status, 'active'),
          // a deleted workspace keeps its member rows: it is not a workspace the person can be in
          isNull(workspaces.deletedAt),
        ),
      )
      .orderBy(desc(workspaceMembers.lastActiveAt), asc(workspaceMembers.id));

    return rows.map((r) => ({
      workspaceId: r.workspaceId,
      name: r.name,
      slug: r.slug,
      lastActiveAt: r.lastActiveAt ? r.lastActiveAt.toISOString() : null,
      roleSlug: r.roleSlug ?? null,
      roleName: r.roleName ?? null,
    }));
  }

  /**
   * The PICKER feed: identity and display only.
   *
   * A query of its own rather than a mapped projection of `listMembersWithProfile`, because the
   * property worth having is that `users.phone`, `users.last_login_at` and the role ids are never
   * SELECTED on the path that serves every delivery participant. A projection would keep them one
   * careless spread away from the response, which is the shape RBE-07 was.
   *
   * No `teams` fan-out either — that second query exists for the User Management Teams column and a
   * picker has no use for it.
   */
  async listMemberOptions(
    workspaceId: string,
    projectIds: string[] | null,
  ): Promise<WorkspaceMemberOption[]> {
    /**
     * The narrowed population: people the caller's OWN projects reference.
     *
     * Two sources, unioned, and the second is not optional. `project_members` alone cannot name a
     * project's owner — §2.1 (migration 0118) keeps a Workspace Admin OFF every roster, and a WA is
     * exactly who tends to own a project (every seeded project's `lead_id` is the admin user, with no
     * membership row by design). A picker built from the roster alone could therefore neither RESOLVE
     * nor OFFER the current owner, which is the both-directions failure the roster split exists to
     * avoid.
     *
     * An EMPTY list never reaches here — the service returns early — so `inArray` is never handed one,
     * which is not portable as "match nothing".
     */
    const scoped =
      projectIds === null
        ? undefined
        : or(
            inArray(
              workspaceMembers.userId,
              this.db
                .select({ userId: projectMembers.userId })
                .from(projectMembers)
                .where(
                  and(
                    inArray(projectMembers.projectId, projectIds),
                    eq(projectMembers.status, 'active'),
                  ),
                ),
            ),
            inArray(
              workspaceMembers.userId,
              this.db
                .select({ userId: sql<string>`${projects.leadId}` })
                .from(projects)
                .where(and(inArray(projects.id, projectIds), isNotNull(projects.leadId))),
            ),
          );

    const rows = await this.db
      .select({
        userId: workspaceMembers.userId,
        status: workspaceMembers.status,
        displayName: users.displayName,
        email: users.email,
        avatarUrl: users.avatarUrl,
      })
      .from(workspaceMembers)
      .leftJoin(users, eq(users.id, workspaceMembers.userId))
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), scoped))
      .orderBy(workspaceMembers.joinedAt, asc(workspaceMembers.id));

    return rows.map((r) => ({
      userId: r.userId,
      // Same fallback ladder the administrative roster uses, so one person never renders under two
      // different names depending on which feed a screen happens to read.
      displayName: r.displayName ?? r.email ?? r.userId,
      email: r.email ?? '',
      avatarUrl: r.avatarUrl ?? null,
      // Derived here, so the account state never leaves the repository. See
      // `WorkspaceMemberOption.assignable`.
      assignable: r.status === 'active',
    }));
  }

  /** Returns workspace members joined with user profile and current workspace-scope role. */
  async listMembersWithProfile(workspaceId: string): Promise<WorkspaceMemberWithProfile[]> {
    const rows = await this.db
      .select({
        id: workspaceMembers.id,
        workspaceId: workspaceMembers.workspaceId,
        userId: workspaceMembers.userId,
        status: workspaceMembers.status,
        joinedAt: workspaceMembers.joinedAt,
        createdAt: workspaceMembers.createdAt,
        displayName: users.displayName,
        email: users.email,
        avatarUrl: users.avatarUrl,
        phone: users.phone,
        lastLoginAt: users.lastLoginAt,
        roleAssignmentId: userRoleAssignments.id,
        roleId: userRoleAssignments.roleId,
        roleSlug: systemRoles.slug,
        roleName: systemRoles.name,
      })
      .from(workspaceMembers)
      .leftJoin(users, eq(users.id, workspaceMembers.userId))
      .leftJoin(
        userRoleAssignments,
        and(
          eq(userRoleAssignments.userId, workspaceMembers.userId),
          eq(userRoleAssignments.scopeType, 'workspace'),
        ),
      )
      .leftJoin(systemRoles, eq(systemRoles.id, userRoleAssignments.roleId))
      .where(eq(workspaceMembers.workspaceId, workspaceId))
      .orderBy(workspaceMembers.joinedAt, asc(workspaceMembers.id));

    // Active team memberships per user (single grouped query, no N+1).
    const teamsByUser: Record<string, MemberTeamSummary[]> = {};
    if (rows.length > 0) {
      const userIds = rows.map((r) => r.userId);
      const teamRows = await this.db
        .select({
          userId: teamMembers.userId,
          id: teams.id,
          key: teams.key,
          name: teams.name,
        })
        .from(teamMembers)
        .innerJoin(teams, eq(teamMembers.teamId, teams.id))
        .where(
          and(
            eq(teamMembers.workspaceId, workspaceId),
            inArray(teamMembers.userId, userIds),
            eq(teamMembers.status, 'active'),
          ),
        )
        .orderBy(teams.name, asc(teams.id));
      for (const tr of teamRows) {
        (teamsByUser[tr.userId] ??= []).push({ id: tr.id, key: tr.key, name: tr.name });
      }
    }

    // The workspace-scoped role leftJoin emits one row per role assignment, so a
    // user with a stray duplicate assignment would render as duplicate member
    // rows. Collapse to one row per membership (first wins, ordered by joinedAt).
    const seen = new Set<string>();
    const unique = rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));

    return unique.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      userId: r.userId,
      status: r.status,
      joinedAt: r.joinedAt ?? new Date(),
      createdAt: r.createdAt,
      displayName: r.displayName ?? r.email ?? r.userId,
      email: r.email ?? '',
      avatarUrl: r.avatarUrl ?? null,
      phone: r.phone ?? null,
      lastLoginAt: r.lastLoginAt ?? null,
      roleAssignmentId: r.roleAssignmentId ?? null,
      roleId: r.roleId ?? null,
      roleSlug: r.roleSlug ?? null,
      roleName: r.roleName ?? null,
      teams: teamsByUser[r.userId] ?? [],
    }));
  }

  async findUserEmail(userId: string): Promise<string | null> {
    const rows = await this.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0]?.email ?? null;
  }

  async findSsoSubjects(userId: string, provider: 'entra'): Promise<string[]> {
    // identity 8: the Microsoft identity of a user is its `account` row (`provider_id = 'microsoft'`, `account_id` = the Entra `oid`).
    // This read the v7 `sso_identities`, which nothing writes any more (a guest who signed in on v8 has no row there, so every
    // oid-bound invitation was refused) and which is dropped at day 30.
    const providerId = provider === 'entra' ? 'microsoft' : provider;
    const rows = await this.db
      .select({ sub: identityAccount.accountId })
      .from(identityAccount)
      .where(and(eq(identityAccount.userId, userId), eq(identityAccount.providerId, providerId)));
    return rows.map((r) => r.sub);
  }

  async grantWorkspaceRole(
    input: { workspaceId: string; userId: string; roleId: string; grantedBy: string },
    tx?: DbExecutor,
  ): Promise<void> {
    await (tx ?? this.db)
      .insert(userRoleAssignments)
      .values({
        workspaceId: input.workspaceId,
        userId: input.userId,
        roleId: input.roleId,
        scopeType: 'workspace',
        scopeId: null,
        grantedBy: input.grantedBy,
      })
      .onConflictDoNothing();
  }

  async addMember(input: AddMemberInput, tx?: DbExecutor): Promise<WorkspaceMember> {
    const rows = await (tx ?? this.db)
      .insert(workspaceMembers)
      .values({
        id: input.id,
        workspaceId: input.workspaceId,
        userId: input.userId,
        roleId: input.roleId ?? null,
        status: 'active',
        joinedAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    return rows[0];
  }

  async updateMember(
    id: string,
    input: UpdateMemberInput,
    tx?: DbExecutor,
  ): Promise<WorkspaceMember> {
    const rows = await (tx ?? this.db)
      .update(workspaceMembers)
      .set({
        ...(input.roleId !== undefined && { roleId: input.roleId }),
        ...(input.status !== undefined && { status: input.status }),
        updatedAt: new Date(),
      })
      .where(eq(workspaceMembers.id, id))
      .returning();
    return rows[0];
  }

  async removeMember(workspaceId: string, userId: string, tx?: DbExecutor): Promise<void> {
    await (tx ?? this.db)
      .update(workspaceMembers)
      .set({ status: 'removed', updatedAt: new Date() })
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
      );
  }

  async isMember(workspaceId: string, userId: string): Promise<boolean> {
    const result = await this.findMember(workspaceId, userId);
    return result !== null && result.status === 'active';
  }

  async touchLastActive(userId: string, workspaceId: string): Promise<void> {
    await this.db
      .update(workspaceMembers)
      .set({ lastActiveAt: new Date(), updatedAt: new Date() })
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
      );
  }

  async countActiveAdmins(workspaceId: string): Promise<number> {
    // Count users holding the workspace-scoped 'admin' system role via the
    // authoritative role-assignment tables (not the denormalised members.roleId).
    const rows = await this.db
      .select({ cnt: count() })
      .from(workspaceMembers)
      .innerJoin(
        userRoleAssignments,
        and(
          eq(userRoleAssignments.userId, workspaceMembers.userId),
          eq(userRoleAssignments.workspaceId, workspaceMembers.workspaceId),
          eq(userRoleAssignments.scopeType, 'workspace'),
        ),
      )
      .innerJoin(
        systemRoles,
        and(
          eq(systemRoles.id, userRoleAssignments.roleId),
          eq(systemRoles.slug, 'workspace_admin'),
        ),
      )
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.status, 'active')),
      );
    return Number(rows[0]?.cnt ?? 0);
  }

  async isActiveAdmin(workspaceId: string, userId: string): Promise<boolean> {
    const rows = await this.db
      .select({ cnt: count() })
      .from(workspaceMembers)
      .innerJoin(
        userRoleAssignments,
        and(
          eq(userRoleAssignments.userId, workspaceMembers.userId),
          eq(userRoleAssignments.workspaceId, workspaceMembers.workspaceId),
          eq(userRoleAssignments.scopeType, 'workspace'),
        ),
      )
      .innerJoin(
        systemRoles,
        and(
          eq(systemRoles.id, userRoleAssignments.roleId),
          eq(systemRoles.slug, 'workspace_admin'),
        ),
      )
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
          eq(workspaceMembers.status, 'active'),
        ),
      );
    return Number(rows[0]?.cnt ?? 0) > 0;
  }
}
