import type { TeamStatus, TeamMemberStatus } from '../../../../../db/schema/enums';
export type { TeamStatus, TeamMemberStatus };

export interface Team {
  id: string;
  workspaceId: string;
  name: string;
  key: string;
  description: string | null;
  leadId: string | null;
  status: TeamStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** A project this team is actively linked to (via project_teams). */
export interface TeamProjectLink {
  projectId: string;
  key: string;
  name: string;
}

export interface TeamWithStats extends Team {
  memberCount: number;
  /** Active project links, oldest-first — the first is treated as "primary" in the list column. */
  projects: TeamProjectLink[];
}

export interface TeamMember {
  id: string;
  workspaceId: string;
  teamId: string;
  userId: string;
  status: TeamMemberStatus;
  joinedAt: Date;
  /** Resolved from identity.users at query time (repo LEFT join) — the roster renders them. */
  displayName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  /**
   * Whether this member holds the workspace-wide grant, so the roster can badge them
   * `Workspace Admin` rather than an access level (BA feature, 2026-08-20).
   *
   * A Workspace Admin may now be a TEAM member — operational scope only — while §2.1 still keeps them
   * off `work.project_members`. So a roster row for them carries no access level to show, and showing
   * `Admin` or `Editor` would state the thing the BA's rule forbids. Resolved per QUERY rather than
   * stored: the grant lives in `user_role_assignments`, and a duplicated boolean would be a second
   * source for a fact that changes when someone is promoted.
   */
  isWorkspaceAdmin?: boolean;
}

export interface CreateTeamInput {
  id: string;
  workspaceId: string;
  name: string;
  key: string;
  description?: string;
  leadId?: string;
}

export interface UpdateTeamInput {
  /** Correcting a key after a rename — see `UpdateProjectInput.key`. A team key never prefixed an
   * item id at all, so it was only ever a badge beside a name that is already on screen. */
  key?: string;
  name?: string;
  description?: string | null;
  leadId?: string | null;
  status?: TeamStatus;
}

/** Relations that create/update can set atomically alongside the team row. */
export interface TeamRelationsInput {
  /** Full set of project ids the team should be linked to (reconciled). */
  projectIds?: string[];
  /** Full set of user ids that should be members (reconciled). */
  memberUserIds?: string[];
}
