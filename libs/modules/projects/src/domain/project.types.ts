import type { ProjectAccessLevel } from '@shared-kernel';
import type {
  WorkflowStatusCategory,
  ProjectStatus,
  ProjectTeamStatus,
  ProjectMemberStatus,
} from '../../../../../db/schema/enums';
export type { WorkflowStatusCategory, ProjectStatus, ProjectTeamStatus, ProjectMemberStatus };

export interface Project {
  id: string;
  workspaceId: string;
  key: string;
  name: string;
  description: string | null;
  leadId: string | null;
  startDate: string | null;
  endDate: string | null;
  status: ProjectStatus;
  settings: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface WorkflowStatus {
  id: string;
  workspaceId: string;
  projectId: string;
  name: string;
  category: WorkflowStatusCategory;
  color: string | null;
  position: number;
  isDefault: boolean;
  createdAt: Date;
}

export interface WorkflowTransition {
  id: string;
  workspaceId: string;
  projectId: string;
  fromStatusId: string | null;
  toStatusId: string;
  name: string | null;
  requiredRole: string | null;
  createdAt: Date;
}

export interface CreateProjectInput {
  id: string;
  workspaceId: string;
  key: string;
  name: string;
  description?: string;
  leadId?: string;
  startDate?: string | null;
  endDate?: string | null;
}

/**
 * Service-layer input for creating a project. Distinct from the persistence
 * {@link CreateProjectInput} (which carries the generated id/workspaceId): this
 * is what the HTTP layer passes in, including the optional team links to seed.
 */
export interface CreateProjectRequest {
  key: string;
  name: string;
  description?: string;
  leadId?: string;
  startDate?: string | null;
  endDate?: string | null;
  teamIds?: string[];
  /**
   * The per-project estimate scale (§4.2, §6.2). Part of the CREATE, not a follow-up write:
   * §4.2 lists every one of these as a required Create Project field, and they used to reach the
   * database through a second, best-effort `PATCH :id/estimation-settings` that the SPA SKIPPED
   * whenever the six values equalled the defaults and swallowed on failure — so a required
   * setting was optional in practice and, on the common path, no `work.project_settings` row
   * existed at all.
   *
   * OPTIONAL here on purpose, and it is the OVERRIDE that is optional, never the row:
   * `createProject` writes the row unconditionally, from these values or from
   * `DEFAULT_PROJECT_ESTIMATION_SETTINGS`. Machine callers and fixtures that predate the field
   * therefore keep working and still end up with a row.
   *
   * Accepting it here does not widen who may set it: the route carries `project:create`, which
   * the catalogue grants to `workspace_admin` alone — the same principal
   * `PATCH :id/estimation-settings` requires via `workspace:edit`.
   */
  estimationSettings?: ProjectEstimationSettings;
}

/**
 * Per-project T-shirt → points scale + hours/point (SRS §6.2), persisted in
 * `work.project_settings`. The HTTP DTO in `project-request.dto.ts` mirrors it for the wire +
 * codegen; `ProjectsService` re-exports it, which is where callers outside the module read it
 * from. It lives in the domain because `CreateProjectRequest` carries it — one shape, not two.
 */
export interface ProjectEstimationSettings {
  xsPoints: number;
  sPoints: number;
  mPoints: number;
  lPoints: number;
  xlPoints: number;
  /**
   * Stored, validated, displayed, editable by a Workspace Admin — and read by NO calculation,
   * deliberately. An audit asked whether PM-FR-008 leaves this unwired; it does not.
   *
   * PM-FR-008 is a SCOPE constraint, not a formula: "Point-to-hour conversion is used only by
   * Capacity Planning and Reports", and §2.2's Not Included is explicit that "Capacity Planning
   * and Report calculations" are outside this module — "This module stores only the Project
   * estimation configuration they consume." Storing it, enforcing `> 0` and restricting the edit
   * to a Workspace Admin (§6.2) is the whole of what PM-FR-008 asks for here.
   *
   * Neither named consumer has anywhere to put it, and each says so in its own SRS. Team
   * Capacity's four measures are `SUM(memberCapacity.capacityHours)` and
   * `SUM(task.{estimate,todo,actuals})` — hours drawn from hours columns, with no points on
   * either side of any comparison. A capacity plan's `unit` is fixed at creation to `points` or
   * `count`, and `measureSql` compares demand against the team's capacity in that SAME unit
   * precisely so a stored number can never be reinterpreted. §6.2 closes it: "Saving
   * configuration does not populate or change Task Estimate hours."
   *
   * So there is no dormant conversion to wire up and no hardcoded 8 standing in for one — every
   * literal 8 in this feature is this field's own default. Deriving hours from points would be
   * new product against two SRSs; it needs a requirement first (an hours-unit plan, or an hours
   * column on a report), then a consumer. Equally, do not delete the field: §4.2 and §6.2 make
   * it a required, editable, displayed setting.
   */
  hoursPerPoint: number;
}

export interface UpdateProjectInput {
  /**
   * Correcting a key after a rename. The key was specified immutable when it prefixed every item
   * id in the project (`PROJ-NN`), so changing it would have rewritten every identifier in sight.
   * `0036_type_prefixed_item_keys` moved item keys to a type prefix (`US-1`) and `0060` moved the
   * counters to the workspace, which left the key a display badge and the immutability without the
   * reason it was written for.
   *
   * Optional, and only ever changed when supplied: a rename must not silently rewrite it, because a
   * key is on screen, in the project switcher and in search, and several were chosen rather than
   * derived (`KB` for `Knowledge Base`).
   */
  key?: string;
  name?: string;
  description?: string | null;
  leadId?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  status?: ProjectStatus;
  settings?: Record<string, unknown>;
}

/** Project enriched with aggregated stats for the list endpoint */
export interface ProjectWithStats extends Project {
  memberCount: number;
  teamCount: number;
  leadName: string | null;
}

/**
 * Per-project rollup for the Home "Project Health" widget. Computed server-side
 * in a bounded, batched query set (no per-project N+1) and returned already
 * sorted by "attention" (blocked, then open defects, then name).
 */
export interface ProjectHealth {
  id: string;
  key: string;
  name: string;
  leadId: string | null;
  leadName: string | null;
  activeSprintName: string | null;
  /** done / total * 100, rounded; 0 when the project has no items. */
  progressPercent: number;
  openDefects: number;
  blockedCount: number;
}

export interface CreateWorkflowStatusInput {
  id: string;
  workspaceId: string;
  projectId: string;
  name: string;
  category: WorkflowStatusCategory;
  color?: string;
  position: number;
  isDefault?: boolean;
}

export interface CreateWorkflowTransitionInput {
  id: string;
  workspaceId: string;
  projectId: string;
  fromStatusId?: string | null;
  toStatusId: string;
  name?: string;
}

export interface ProjectTeamLink {
  id: string;
  workspaceId: string;
  projectId: string;
  teamId: string;
  status: ProjectTeamStatus;
  linkedAt: Date;
  unlinkedAt: Date | null;
  name?: string;
  key?: string;
}

export interface ProjectMember {
  id: string;
  workspaceId: string;
  projectId: string;
  userId: string;
  accessLevel: string | null;
  status: ProjectMemberStatus;
  joinedAt: Date;
  updatedAt: Date;
  /** Joined from users table */
  displayName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  /**
   * Count of this user's ACTIVE `team_members` rows for Teams LINKED to this
   * project (`project_teams` scoped to this projectId, active on both sides) —
   * the same two-tier scoping the reports and Team Status use (team rows plus the shared ones)
   * writes. Only `listByProject` computes this for real; other repository
   * methods leave it undefined and the DTO mapper defaults to 0, matching how
   * the other joined-from-users fields above are already handled.
   */
  teamCount?: number;
  /**
   * TRUE for the SYNTHESIZED Workspace Admin row, which is not a `work.project_members` record.
   *
   * The Project `Users & Permissions` list shows every active Workspace Admin as a system-generated,
   * read-only row (BA report 2026-08-21): fixed badge, no Access Level control, no Remove. §2.1 still
   * keeps them OFF `work.project_members`, so the row is composed on read and `memberCount` — counted
   * from the table — is unaffected. Undefined on every real row.
   */
  isWorkspaceAdmin?: boolean;
}

// `AddProjectMemberInput` is gone with the write it described: creating a grant is
// `GrantProjectAccessInput` in `@modules/access` now, one shape for all three §5 journeys.

export interface UpdateProjectMemberInput {
  roleId?: string;
  accessLevel?: ProjectAccessLevel;
  status?: ProjectMemberStatus;
}
