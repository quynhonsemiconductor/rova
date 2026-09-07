/**
 * Error codes — machine-readable, surfaced in OpenAPI, used by the FE to branch on `code`.
 * Rules: append-only, never reuse or renumber a deleted code, RESOURCE_REASON convention.
 */

export const ErrorCodes = {
  // Generic
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
  INVALID_CURSOR: 'INVALID_CURSOR',
  INVALID_FILTER: 'INVALID_FILTER',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  BAD_REQUEST: 'BAD_REQUEST',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',

  // Auth / Identity
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  AUTH_TOKEN_INVALID: 'AUTH_TOKEN_INVALID',
  AUTH_SESSION_REVOKED: 'AUTH_SESSION_REVOKED',
  AUTH_REFRESH_TOKEN_REUSE: 'AUTH_REFRESH_TOKEN_REUSE',
  AUTH_MFA_REQUIRED: 'AUTH_MFA_REQUIRED',
  SSO_NOT_CONFIGURED: 'SSO_NOT_CONFIGURED',
  SSO_TOKEN_INVALID: 'SSO_TOKEN_INVALID',
  SSO_CLAIMS_MISSING: 'SSO_CLAIMS_MISSING',
  SSO_TENANT_NOT_FOUND: 'SSO_TENANT_NOT_FOUND',
  SSO_CONNECTION_DISABLED: 'SSO_CONNECTION_DISABLED',
  SSO_DOMAIN_NOT_ALLOWED: 'SSO_DOMAIN_NOT_ALLOWED',
  SSO_JIT_DISABLED: 'SSO_JIT_DISABLED',
  SSO_NO_ACCESS: 'SSO_NO_ACCESS',
  DEV_LOGIN_DISABLED: 'DEV_LOGIN_DISABLED',
  EMAIL_ALREADY_REGISTERED: 'EMAIL_ALREADY_REGISTERED',
  SIGNUP_DISABLED: 'SIGNUP_DISABLED',
  /** Avatar upload requested but the public-assets CDN/bucket is not configured. */
  AVATAR_STORAGE_UNCONFIGURED: 'AVATAR_STORAGE_UNCONFIGURED',

  // Workspace
  ACCOUNT_DEACTIVATED: 'ACCOUNT_DEACTIVATED',
  WORKSPACE_NOT_FOUND: 'WORKSPACE_NOT_FOUND',
  WORKSPACE_ARCHIVED: 'WORKSPACE_ARCHIVED',
  WORKSPACE_ACCESS_DENIED: 'WORKSPACE_ACCESS_DENIED',
  WORKSPACE_SLUG_TAKEN: 'WORKSPACE_SLUG_TAKEN',
  WORKSPACE_MEMBER_NOT_FOUND: 'WORKSPACE_MEMBER_NOT_FOUND',
  WORKSPACE_MEMBER_ALREADY_EXISTS: 'WORKSPACE_MEMBER_ALREADY_EXISTS',

  // Project
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  PROJECT_KEY_TAKEN: 'PROJECT_KEY_TAKEN',
  PROJECT_ARCHIVED: 'PROJECT_ARCHIVED',
  PROJECT_PERMISSION_DENIED: 'PROJECT_PERMISSION_DENIED',
  /** An Editor with no active Team in the project has no delivery scope (§2.2, GAP-P4-RBAC-003 AC1). */
  EDITOR_NO_TEAM_SCOPE: 'EDITOR_NO_TEAM_SCOPE',
  /** The record belongs to a Team this Editor is not assigned to (§3.2, GAP-P4-RBAC-003 AC3). */
  TEAM_NOT_IN_SCOPE: 'TEAM_NOT_IN_SCOPE',
  /**
   * `team_id IS NULL` is the Project Backlog, and only a Workspace Admin or Project Admin may reach
   * it (BA ruling 2026-08-17). Distinct from `TEAM_NOT_IN_SCOPE` on purpose: "no Team" and "another
   * Team" are different facts, and only one of them is something the reader can act on.
   */
  PROJECT_BACKLOG_ADMIN_ONLY: 'PROJECT_BACKLOG_ADMIN_ONLY',
  /** An Editor must choose one of their Teams when creating a Work Item (BA ruling 2026-08-17). */
  WORK_ITEM_TEAM_REQUIRED: 'WORK_ITEM_TEAM_REQUIRED',
  PROJECT_LEAD_NOT_MEMBER: 'PROJECT_LEAD_NOT_MEMBER',
  PROJECT_INVALID_DATE_RANGE: 'PROJECT_INVALID_DATE_RANGE',
  LABEL_NOT_FOUND: 'LABEL_NOT_FOUND',

  // Work item
  WORK_ITEM_NOT_FOUND: 'WORK_ITEM_NOT_FOUND',
  WORK_ITEM_RANK_CONFLICT: 'WORK_ITEM_RANK_CONFLICT',
  WORK_ITEM_INVALID_TRANSITION: 'WORK_ITEM_INVALID_TRANSITION',
  WORK_ITEM_INVALID_PARENT_TYPE: 'WORK_ITEM_INVALID_PARENT_TYPE',
  WORK_ITEM_CIRCULAR_PARENT: 'WORK_ITEM_CIRCULAR_PARENT',
  WORK_ITEM_MAX_DEPTH_EXCEEDED: 'WORK_ITEM_MAX_DEPTH_EXCEEDED',
  WORK_ITEM_PARENT_SCOPE_MISMATCH: 'WORK_ITEM_PARENT_SCOPE_MISMATCH',
  WORK_ITEM_STORY_HAS_NO_PRIORITY: 'WORK_ITEM_STORY_HAS_NO_PRIORITY',
  WORK_ITEM_STATE_MIRROR_CONFLICT: 'WORK_ITEM_STATE_MIRROR_CONFLICT',
  WORK_ITEM_NOT_BACKLOG_TYPE: 'WORK_ITEM_NOT_BACKLOG_TYPE',
  WORK_ITEM_EMPTY_SELECTION: 'WORK_ITEM_EMPTY_SELECTION',
  /**
   * RETIRED by the BA's ruling of 2026-08-20 — nothing throws it. A defect is deletable (§3.2:81), and
   * the Phase 3.4 rule it carried is gone; see `WorkItemsService.deleteWorkItem`.
   *
   * Kept because this map is append-only and never reuses a code: a client branching on it still
   * compiles, and it will simply never arrive.
   */
  DEFECT_DELETE_FORBIDDEN: 'DEFECT_DELETE_FORBIDDEN',
  // Work item relations (F6)
  WORK_ITEM_RELATION_SELF: 'WORK_ITEM_RELATION_SELF',
  WORK_ITEM_RELATION_EXISTS: 'WORK_ITEM_RELATION_EXISTS',
  WORK_ITEM_RELATION_CYCLE: 'WORK_ITEM_RELATION_CYCLE',
  WORK_ITEM_RELATION_NOT_FOUND: 'WORK_ITEM_RELATION_NOT_FOUND',
  WORK_ITEM_RELATION_CROSS_WORKSPACE: 'WORK_ITEM_RELATION_CROSS_WORKSPACE',
  TASK_NESTING_NOT_ALLOWED: 'TASK_NESTING_NOT_ALLOWED',
  TASK_ITERATION_DERIVED: 'TASK_ITERATION_DERIVED',

  // Milestones
  MILESTONE_NOT_FOUND: 'MILESTONE_NOT_FOUND',
  MILESTONE_INVALID_TRANSITION: 'MILESTONE_INVALID_TRANSITION',
  MILESTONE_PROJECT_MISMATCH: 'MILESTONE_PROJECT_MISMATCH',
  MILESTONE_TEAM_MISMATCH: 'MILESTONE_TEAM_MISMATCH',
  MILESTONE_INVALID_ARTIFACT_TYPE: 'MILESTONE_INVALID_ARTIFACT_TYPE',
  MILESTONE_PROJECT_NOT_IN_WORKSPACE: 'MILESTONE_PROJECT_NOT_IN_WORKSPACE',
  MILESTONE_TEAM_NOT_IN_WORKSPACE: 'MILESTONE_TEAM_NOT_IN_WORKSPACE',
  MILESTONE_RELEASE_NOT_IN_WORKSPACE: 'MILESTONE_RELEASE_NOT_IN_WORKSPACE',

  // Portfolio items (P5.1 — Epic + Feature share one table)
  PORTFOLIO_ITEM_NOT_FOUND: 'PORTFOLIO_ITEM_NOT_FOUND',
  PORTFOLIO_ITEM_INVALID_TYPE: 'PORTFOLIO_ITEM_INVALID_TYPE',
  PORTFOLIO_ITEM_PROJECT_MISMATCH: 'PORTFOLIO_ITEM_PROJECT_MISMATCH',
  /** A project move is refused while the Feature is allocated on a capacity plan. */
  PORTFOLIO_ITEM_HAS_CAPACITY_ALLOCATION: 'PORTFOLIO_ITEM_HAS_CAPACITY_ALLOCATION',
  /** Restoring a Feature is refused while its Epic is still archived. */
  PORTFOLIO_PARENT_ARCHIVED: 'PORTFOLIO_PARENT_ARCHIVED',
  /** A Project is set at creation and never changes (`P5-PI-003`, WID-FR-017, §3.1 AC5). */
  PORTFOLIO_ITEM_PROJECT_IMMUTABLE: 'PORTFOLIO_ITEM_PROJECT_IMMUTABLE',
  /** Every write except Restore is refused on an archived item — it is not actionable work. */
  PORTFOLIO_ITEM_ARCHIVED: 'PORTFOLIO_ITEM_ARCHIVED',
  PORTFOLIO_ITEM_TEAM_MISMATCH: 'PORTFOLIO_ITEM_TEAM_MISMATCH',
  PORTFOLIO_ITEM_INVALID_PARENT: 'PORTFOLIO_ITEM_INVALID_PARENT',
  /** Archiving an Epic that still has active child Features would orphan them. */
  PORTFOLIO_EPIC_HAS_ACTIVE_FEATURES: 'PORTFOLIO_EPIC_HAS_ACTIVE_FEATURES',
  /**
   * Archiving a Feature that still has child work items would orphan them — the same rule as the Epic
   * guard above, one level down. `P5-PI-011` in the 2026-08-14 DEV Handoff.
   */
  PORTFOLIO_FEATURE_HAS_ACTIVE_WORK_ITEMS: 'PORTFOLIO_FEATURE_HAS_ACTIVE_WORK_ITEMS',
  /** Drop neighbours arrived out of order — a stale client view of the rank order. */
  PORTFOLIO_ITEM_RANK_CONFLICT: 'PORTFOLIO_ITEM_RANK_CONFLICT',

  // Capacity planning (P5.2 — one plan per project+release)
  CAPACITY_PLAN_NOT_FOUND: 'CAPACITY_PLAN_NOT_FOUND',
  /** `uq_capacity_plan_project_release` — a release already has a plan. */
  CAPACITY_PLAN_EXISTS: 'CAPACITY_PLAN_EXISTS',
  /** The release named does not belong to the project named. */
  CAPACITY_PLAN_RELEASE_MISMATCH: 'CAPACITY_PLAN_RELEASE_MISMATCH',
  /** A published plan is read-only until it is reverted to draft. */
  CAPACITY_PLAN_NOT_DRAFT: 'CAPACITY_PLAN_NOT_DRAFT',
  /** Reverting something that is already a draft. */
  CAPACITY_PLAN_NOT_PUBLISHED: 'CAPACITY_PLAN_NOT_PUBLISHED',
  /**
   * Nothing to publish: no teams, no allocations, and never published before.
   *
   * All three conditions, per Rally — a plan that HAS been published may be re-published even
   * once emptied, which is how a planner undoes an over-eager clear-out.
   */
  CAPACITY_PLAN_EMPTY: 'CAPACITY_PLAN_EMPTY',
  CAPACITY_TEAM_NOT_FOUND: 'CAPACITY_TEAM_NOT_FOUND',
  CAPACITY_TEAM_ALREADY_ADDED: 'CAPACITY_TEAM_ALREADY_ADDED',
  CAPACITY_ALLOCATION_NOT_FOUND: 'CAPACITY_ALLOCATION_NOT_FOUND',
  /** Only a Feature is allocatable — an Epic rolls up through its child Features. */
  CAPACITY_ALLOCATION_NOT_FEATURE: 'CAPACITY_ALLOCATION_NOT_FEATURE',
  // The BA flow's eligibility rules for adding a Feature to a plan (§4.4).
  CAPACITY_ALLOCATION_WRONG_PROJECT: 'CAPACITY_ALLOCATION_WRONG_PROJECT',
  CAPACITY_ALLOCATION_ARCHIVED: 'CAPACITY_ALLOCATION_ARCHIVED',
  CAPACITY_ALLOCATION_CANCELLED: 'CAPACITY_ALLOCATION_CANCELLED',
  CAPACITY_ALLOCATION_OTHER_RELEASE: 'CAPACITY_ALLOCATION_OTHER_RELEASE',
  /** Rally's `Move To Another Plan` refuses these four. */
  CAPACITY_MOVE_SAME_PLAN: 'CAPACITY_MOVE_SAME_PLAN',
  CAPACITY_MOVE_OTHER_PROJECT: 'CAPACITY_MOVE_OTHER_PROJECT',
  CAPACITY_MOVE_ALREADY_ON_TARGET: 'CAPACITY_MOVE_ALREADY_ON_TARGET',
  CAPACITY_MOVE_RELEASE_MISMATCH: 'CAPACITY_MOVE_RELEASE_MISMATCH',
  /** The (plan, item, team) slot an allocation is being moved onto is already occupied. */
  CAPACITY_ALLOCATION_TEAM_TAKEN: 'CAPACITY_ALLOCATION_TEAM_TAKEN',
  CAPACITY_ALLOCATION_ALREADY_UNASSIGNED: 'CAPACITY_ALLOCATION_ALREADY_UNASSIGNED',
  /** A release cannot be deleted while a capacity plan is built on it. */
  RELEASE_HAS_CAPACITY_PLAN: 'RELEASE_HAS_CAPACITY_PLAN',
  /** Unlinking a team from a project is refused while it sits on one of that project's plans. */
  PROJECT_TEAM_HAS_CAPACITY_PLAN: 'PROJECT_TEAM_HAS_CAPACITY_PLAN',
  /**
   * An Unallocated row cannot be a Feature's primary team assignment.
   *
   * It names no team, so there is nobody to own the work — the same rule
   * `ck_capacity_primary_has_team` enforces in the database.
   */
  CAPACITY_PRIMARY_NEEDS_TEAM: 'CAPACITY_PRIMARY_NEEDS_TEAM',

  /** A task inherits its Feature from its work product. */
  WORK_ITEM_FEATURE_LINK_NOT_ALLOWED: 'WORK_ITEM_FEATURE_LINK_NOT_ALLOWED',
  /** Rally attaches the story hierarchy to the LOWEST portfolio level — a Feature, not an Epic. */
  WORK_ITEM_FEATURE_LINK_NOT_FEATURE: 'WORK_ITEM_FEATURE_LINK_NOT_FEATURE',
  /** An archived Feature is invisible on every portfolio surface, so nothing may roll into it. */
  WORK_ITEM_FEATURE_LINK_ARCHIVED: 'WORK_ITEM_FEATURE_LINK_ARCHIVED',

  // Workflow
  WORKFLOW_STATUS_NOT_FOUND: 'WORKFLOW_STATUS_NOT_FOUND',
  WORKFLOW_TRANSITION_NOT_ALLOWED: 'WORKFLOW_TRANSITION_NOT_ALLOWED',

  // Iteration (Rally timeboxes — Phase 2)
  ITERATION_NOT_FOUND: 'ITERATION_NOT_FOUND',
  ITERATION_NOT_PLANNING: 'ITERATION_NOT_PLANNING',
  ITERATION_NOT_COMMITTED: 'ITERATION_NOT_COMMITTED',
  ITERATION_PROJECT_MISMATCH: 'ITERATION_PROJECT_MISMATCH',
  ITERATION_TEAM_MISMATCH: 'ITERATION_TEAM_MISMATCH',
  ITERATION_INVALID_DATE_RANGE: 'ITERATION_INVALID_DATE_RANGE',
  ITERATION_EMPTY: 'ITERATION_EMPTY',
  ITERATION_NOT_ALL_ACCEPTED: 'ITERATION_NOT_ALL_ACCEPTED',
  ITERATION_INVALID_STATE_TRANSITION: 'ITERATION_INVALID_STATE_TRANSITION',
  /**
   * A delete would CASCADE the iteration's frozen Burndown history away, and the snapshot cron
   * only ever writes TODAY — so those days cannot be measured again.
   */
  ITERATION_HAS_REPORT_HISTORY: 'ITERATION_HAS_REPORT_HISTORY',

  // Release
  RELEASE_NOT_FOUND: 'RELEASE_NOT_FOUND',
  RELEASE_PROJECT_MISMATCH: 'RELEASE_PROJECT_MISMATCH',
  RELEASE_NOT_DELETABLE: 'RELEASE_NOT_DELETABLE',
  RELEASE_ALREADY_SHIPPED: 'RELEASE_ALREADY_SHIPPED',
  RELEASE_INVALID_DATE_RANGE: 'RELEASE_INVALID_DATE_RANGE',
  RELEASE_INVALID_TRANSITION: 'RELEASE_INVALID_TRANSITION',

  // API tokens (machine credentials — see migration 0125)
  API_TOKEN_NOT_FOUND: 'API_TOKEN_NOT_FOUND',
  API_TOKEN_UNKNOWN_SCOPE: 'API_TOKEN_UNKNOWN_SCOPE',
  API_TOKEN_CANNOT_MANAGE_TOKENS: 'API_TOKEN_CANNOT_MANAGE_TOKENS',

  // Access / Permission
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  ROLE_NOT_FOUND: 'ROLE_NOT_FOUND',
  ROLE_ASSIGNMENT_NOT_FOUND: 'ROLE_ASSIGNMENT_NOT_FOUND',
  ROLE_IMMUTABLE: 'ROLE_IMMUTABLE',
  ROLE_IN_USE: 'ROLE_IN_USE',
  ROLE_WILDCARD_FORBIDDEN: 'ROLE_WILDCARD_FORBIDDEN',
  PROJECT_SCOPE_RETIRED: 'PROJECT_SCOPE_RETIRED',
  INVITED_ROLE_IS_PROJECT_TIER: 'INVITED_ROLE_IS_PROJECT_TIER',
  ROLE_PERMISSION_ESCALATION: 'ROLE_PERMISSION_ESCALATION',

  // User
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USER_DEACTIVATED: 'USER_DEACTIVATED',

  // Password reset
  PASSWORD_RESET_TOKEN_INVALID: 'PASSWORD_RESET_TOKEN_INVALID',
  PASSWORD_RESET_TOKEN_EXPIRED: 'PASSWORD_RESET_TOKEN_EXPIRED',

  // Workspace invitations
  INVITATION_NOT_FOUND: 'INVITATION_NOT_FOUND',
  INVITATION_NOT_PENDING: 'INVITATION_NOT_PENDING',
  INVITATION_RESEND_TOO_SOON: 'INVITATION_RESEND_TOO_SOON',
  INVITATION_ALREADY_USED: 'INVITATION_ALREADY_USED',
  INVITATION_EXPIRED: 'INVITATION_EXPIRED',
  INVITATION_EMAIL_MISMATCH: 'INVITATION_EMAIL_MISMATCH',
  SOLE_ADMIN_VIOLATION: 'SOLE_ADMIN_VIOLATION',

  // Teams
  TEAM_NOT_FOUND: 'TEAM_NOT_FOUND',
  TEAM_KEY_TAKEN: 'TEAM_KEY_TAKEN',
  TEAM_ALREADY_ARCHIVED: 'TEAM_ALREADY_ARCHIVED',
  TEAM_MEMBER_NOT_FOUND: 'TEAM_MEMBER_NOT_FOUND',
  TEAM_MEMBER_ALREADY_EXISTS: 'TEAM_MEMBER_ALREADY_EXISTS',
  TEAM_MEMBER_NOT_WORKSPACE_MEMBER: 'TEAM_MEMBER_NOT_WORKSPACE_MEMBER',
  /**
   * A team roster row is project-scoped work, so a candidate must already belong to a project the team
   * serves (BA report 2026-08-21). Distinct from `TEAM_MEMBER_NOT_WORKSPACE_MEMBER`, which is the
   * tenant boundary: this one refuses somebody who IS in the workspace but has no access to the
   * team's projects, and it is the reader's cue to grant project access first rather than to look for
   * a different person. A Workspace Admin never hits it (§2.1 keeps them off project rosters while
   * their workspace-wide grant covers every project).
   */
  TEAM_MEMBER_NOT_PROJECT_MEMBER: 'TEAM_MEMBER_NOT_PROJECT_MEMBER',
  /**
   * A Team Lead must be an active member of that team (`PM-FR-021` / AC15, BA 2026-08-22). The label
   * confers no access and no Owner eligibility, so a lead who is not on the roster is a claim about
   * the delivery model that the roster itself contradicts.
   */
  TEAM_LEAD_NOT_MEMBER: 'TEAM_LEAD_NOT_MEMBER',
  /**
   * `Owner` / `Dev Owner` must satisfy the shared assignment rule (BA `c42df59`, 2026-08-22): with a
   * Team, an active Project Admin, an Editor assigned to that Team, or a Workspace Admin who is a
   * member of it; with no Team, a Project Admin only. Distinct from a team-SCOPE refusal — this is
   * about who may be given the work, not about who may read it.
   */
  WORK_ITEM_ASSIGNEE_NOT_ELIGIBLE: 'WORK_ITEM_ASSIGNEE_NOT_ELIGIBLE',
  /** Delete is an operation on the ARCHIVE: archive the team first (`TeamService.deleteTeam`). */
  TEAM_NOT_ARCHIVED: 'TEAM_NOT_ARCHIVED',
  /**
   * The team still holds delivery or report history, so deleting it would dangle rows that carry no
   * foreign key and CASCADE away frozen snapshots (DB design §488). The message names the sources.
   */
  TEAM_HAS_HISTORY: 'TEAM_HAS_HISTORY',

  // Project teams / members
  PROJECT_TEAM_ALREADY_LINKED: 'PROJECT_TEAM_ALREADY_LINKED',
  PROJECT_TEAM_LINK_NOT_FOUND: 'PROJECT_TEAM_LINK_NOT_FOUND',
  PROJECT_TEAM_NOT_FOUND: 'PROJECT_TEAM_NOT_FOUND',
  PROJECT_MEMBER_NOT_FOUND: 'PROJECT_MEMBER_NOT_FOUND',
  PROJECT_MEMBER_ALREADY_EXISTS: 'PROJECT_MEMBER_ALREADY_EXISTS',
  /**
   * §2.1: a Workspace Admin is not added as a Project user — its authority is the
   * workspace-wide grant, so the `project_members` row grants it nothing and only
   * misrepresents the model. Refused rather than silently dropped, so a UI cannot show a
   * member the roster does not list.
   */
  PROJECT_MEMBER_IS_WORKSPACE_ADMIN: 'PROJECT_MEMBER_IS_WORKSPACE_ADMIN',
  /**
   * PRJ-08 / §2.2: an Editor is scoped to Teams, so it must hold at least one of the project's.
   * Refused only where the level and the Teams arrive in ONE write, and never for a project that has
   * no Team to assign — see `assertTeamAssignmentForLevel` in `@modules/access` for both reasons.
   */
  PROJECT_EDITOR_REQUIRES_TEAM: 'PROJECT_EDITOR_REQUIRES_TEAM',
  ASSIGNEE_NOT_WORKSPACE_MEMBER: 'ASSIGNEE_NOT_WORKSPACE_MEMBER',

  // Team Status
  TEAM_STATUS_INVALID_CAPACITY: 'TEAM_STATUS_INVALID_CAPACITY',
  TEAM_STATUS_TEAM_REQUIRED: 'TEAM_STATUS_TEAM_REQUIRED',
  TEAM_STATUS_INVALID_TITLE: 'TEAM_STATUS_INVALID_TITLE',

  // Collaboration
  COMMENT_NOT_FOUND: 'COMMENT_NOT_FOUND',
  ATTACHMENT_NOT_FOUND: 'ATTACHMENT_NOT_FOUND',
  ATTACHMENT_NOT_PENDING: 'ATTACHMENT_NOT_PENDING',
  ATTACHMENT_SIZE_MISMATCH: 'ATTACHMENT_SIZE_MISMATCH',
  /** Client sent a malformed checksum at presign time. */
  ATTACHMENT_INVALID_CHECKSUM: 'ATTACHMENT_INVALID_CHECKSUM',
  /** Confirm called before the object actually landed in the bucket. */
  ATTACHMENT_NOT_UPLOADED: 'ATTACHMENT_NOT_UPLOADED',
  /** Stored bytes do not match the checksum declared at presign time. */
  ATTACHMENT_CHECKSUM_MISMATCH: 'ATTACHMENT_CHECKSUM_MISMATCH',
  ATTACHMENT_FILE_TOO_LARGE: 'ATTACHMENT_FILE_TOO_LARGE',
  ATTACHMENT_INVALID_TYPE: 'ATTACHMENT_INVALID_TYPE',
  ATTACHMENT_LIMIT_EXCEEDED: 'ATTACHMENT_LIMIT_EXCEEDED',
  ATTACHMENT_NOT_OWNER: 'ATTACHMENT_NOT_OWNER',
  COMMENT_NOT_OWNED: 'COMMENT_NOT_OWNED',
  TIME_LOG_NOT_FOUND: 'TIME_LOG_NOT_FOUND',
  TIME_LOG_NOT_OWNER: 'TIME_LOG_NOT_OWNER',

  // Notifications
  NOTIFICATION_NOT_FOUND: 'NOTIFICATION_NOT_FOUND',

  // Audit
  AUDIT_LOG_NOT_FOUND: 'AUDIT_LOG_NOT_FOUND',

  // Reporting
  REPORT_INVALID_DATE_RANGE: 'REPORT_INVALID_DATE_RANGE',

  // Test Case & Test Result (Phase 7)
  TEST_CASE_NOT_FOUND: 'TEST_CASE_NOT_FOUND',
  TEST_RESULT_NOT_FOUND: 'TEST_RESULT_NOT_FOUND',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

// The error-category taxonomy and its HTTP-status mapping are framework-level
// invariants owned by @quynhonsemiconductor/platform-http. Re-exported here so product code keeps
// importing them from '@platform' while there is a SINGLE source of truth (no drift).
// The product-specific `ErrorCode` catalog above stays local (product policy).
export { type ErrorCategory, CATEGORY_HTTP_STATUS } from '@quynhonsemiconductor/platform-http';
