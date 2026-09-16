/**
 * Every gated route's permission code must be one its INTENDED AUDIENCE can actually hold.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The dev principal is `admin@qnsc.dev`, a Workspace Admin, and `workspace:*` grants everything.
 * So a route gated on a code no ordinary user can hold answers 200 for the only person who ever
 * clicks it, and 403 for everyone else. That is not a hypothetical failure mode — it is the
 * documented cause of three separate defects in this repository:
 *
 *   • `report:view` was missing from PROJECT_ADMIN and PROJECT_MEMBER, so all five report routes
 *     403'd everyone except a WA. It survived to migration 0092.
 *   • `GET /work-items/by-key` carried `workspace:view`, which is admin-reserved. It is the sole
 *     resolver behind `/item/$itemKey`, so every notification click and every ID cell 403'd for
 *     both non-admin roles — while the service's own check would have allowed them.
 *   • Gating the project roster (correctly) left every Editor seeing `Unassigned` on every owned
 *     item, because the roster was also the only owner feed.
 *
 * CLAUDE.md names the pattern: "a gate chosen for where the id lives rather than for what the
 * action is … invisible in testing because the dev principal is a Workspace Admin whose
 * `workspace:*` masks every one of them."
 *
 * WHAT THIS ADDS OVER THE SPECS THAT ALREADY EXIST
 * -----------------------------------------------
 *   • `test/route-policy.ratchet.spec.ts` reads SOURCE TEXT and counts undecorated handlers. Its
 *     own docblock calls it "a smoke detector, not an authorization test" — it cannot tell
 *     `workspace:view` from a code an Editor holds.
 *   • `RouteAuthzAudit` refuses to boot when a route declares NOTHING. It does not read the code.
 *   • `iteration-timebox-gate`, `capacity-access-gate` and `roster-split-gate` do exactly the right
 *     check — on three controllers and twelve handlers. This is the same check swept across the
 *     WHOLE surface, so the next instance cannot land in the eleven controllers nobody wrote a
 *     gate spec for.
 *
 * It reads the DECORATOR METADATA `PolicyGuard` itself reads (`POLICY_KEY`) and applies the guard's
 * own decision function (`permissionGrants`) to the catalogue's own per-level permission sets. It
 * runs in the unit suite, on every change, with no database.
 *
 * WHAT IT CANNOT SEE, and where that is covered
 * --------------------------------------------
 * It does not exercise `PolicyGuard`, so it cannot catch a `scope` that resolves the project from
 * the wrong field, nor a DTO whose ValidationPipe rejects the request before the guard runs.
 * `test/e2e/authz-cluster.e2e.spec.ts` drives those over real HTTP with a real per-project Editor.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AUTHZ_MODE_KEY, POLICY_KEY } from '@modules/access';
import {
  ACCESS_LEVEL_PERMISSIONS,
  PROJECT_ACCESS_LEVEL,
  ROLE_PERMISSIONS,
  isProjectTierPermission,
  permissionGrants,
  type Permission,
  type ProjectAccessLevel,
} from '@shared-kernel';

import { AccessController } from '../libs/modules/access/src/interface/http/access.controller';
import { AuditController } from '../libs/modules/audit/src/interface/http/audit.controller';
import { CapacityPlansController } from '../libs/modules/capacity/src/interface/http/capacity-plans.controller';
import { CollaborationController } from '../libs/modules/collaboration/src/interface/http/collaboration.controller';
import { PortfolioCollaborationController } from '../libs/modules/collaboration/src/interface/http/portfolio-collaboration.controller';
import { AuthController } from '../libs/modules/identity/src/interface/http/auth.controller';
import { BffController } from '../libs/modules/identity/src/interface/http/bff/bff.controller';
import { IdentityController } from '../libs/modules/identity/src/interface/http/identity.controller';
import { IterationsController } from '../libs/modules/iterations/src/interface/http/iterations.controller';
import { MilestonesController } from '../libs/modules/milestones/src/interface/http/milestones.controller';
import { NotificationPreferencesController } from '../libs/modules/notifications/src/interface/http/notification-preferences.controller';
import { NotificationSseController } from '../libs/modules/notifications/src/interface/http/notification-sse.controller';
import { NotificationsController } from '../libs/modules/notifications/src/interface/http/notifications.controller';
import { PortfolioAttachmentsController } from '../libs/modules/portfolio/src/interface/http/portfolio-attachments.controller';
import { PortfolioItemsController } from '../libs/modules/portfolio/src/interface/http/portfolio-items.controller';
import { ProjectsController } from '../libs/modules/projects/src/interface/http/projects.controller';
import { QualityController } from '../libs/modules/quality/src/interface/http/quality.controller';
import { ReleasesController } from '../libs/modules/releases/src/interface/http/releases.controller';
import { ReportingController } from '../libs/modules/reporting/src/interface/http/reporting.controller';
import { ScmWebhookController } from '../libs/modules/scm/src/interface/http/scm-webhook.controller';
import { ScmController } from '../libs/modules/scm/src/interface/http/scm.controller';
import { TeamStatusController } from '../libs/modules/team-status/src/interface/http/team-status.controller';
import { WorkItemsController } from '../libs/modules/work-items/src/interface/http/work-items.controller';
import { WorkflowController } from '../libs/modules/workflow/src/interface/http/workflow.controller';
import { TeamController } from '../libs/modules/workspace/src/interface/http/team.controller';
import { WorkspaceController } from '../libs/modules/workspace/src/interface/http/workspace.controller';

/**
 * Every HTTP controller in the repo. Listed by IMPORT rather than discovered from the filesystem
 * so the reflection below reads the real decorator metadata — `route-policy.ratchet.spec.ts`
 * already owns the source-text scan, and its docblock records what a regex misses (an unanchored
 * `/@RequirePermission/` matched a PROSE mention and silently excluded nine routes).
 *
 * `git ls-files 'libs/**\/*.controller.ts' 'apps/**\/*.controller.ts'` is the list; the count is
 * asserted below so a new controller cannot be added without appearing here.
 */
const CONTROLLERS = [
  AccessController,
  AuditController,
  AuthController,
  BffController,
  CapacityPlansController,
  CollaborationController,
  IdentityController,
  IterationsController,
  MilestonesController,
  NotificationPreferencesController,
  NotificationSseController,
  NotificationsController,
  PortfolioAttachmentsController,
  PortfolioCollaborationController,
  PortfolioItemsController,
  ProjectsController,
  QualityController,
  ReleasesController,
  ReportingController,
  ScmController,
  ScmWebhookController,
  TeamController,
  TeamStatusController,
  WorkItemsController,
  WorkflowController,
  WorkspaceController,
] as const;

/**
 * Who a route is FOR. Not derived from the code — that would make the assertion tautological and
 * it would have agreed with every one of the three defects above. This is the BA's audience, and
 * the code is what gets checked against it.
 *
 *   `editor`          a per-Project Editor must be able to call it (and so must an Admin — the
 *                     catalogue's tier sets are monotonic).
 *   `admin`           a per-Project Admin, and NOT an Editor. The §5 admin surfaces: Portfolio,
 *                     Capacity Planning, Reports, and per §3.2 `Plan > Timeboxes` — Iterations,
 *                     Releases and Milestones alike.
 *   `workspace-admin` neither project level. Workspace administration, and the six §3.1 structural
 *                     rows below.
 */
type Audience = 'editor' | 'admin' | 'workspace-admin';

/**
 * The six PROJECT-TIER routes that only a Workspace Admin may call.
 *
 * §3.1 marks every structural row Hidden for a per-Project Admin — archive/restore/delete Project
 * and assign Project access — and gives it Read-only on "View Project Details and Teams". So
 * `project:archive`, `project:restore`, `project:delete` and `project:manage_members` are
 * project-TIER (they target one existing project, which is what decides the tier) while being held
 * by `workspace_admin` alone.
 *
 * Enumerated rather than inferred, because "a project-tier code no project level holds" is
 * otherwise indistinguishable from the `report:view` defect — which was exactly that shape.
 */
const STRUCTURAL_WORKSPACE_ADMIN_ROUTES = new Set([
  'ProjectsController.addProjectMember',
  'ProjectsController.archiveProject',
  'ProjectsController.deleteProject',
  'ProjectsController.removeProjectMember',
  'ProjectsController.restoreProject',
  'ProjectsController.updateProjectMember',
]);

/**
 * Every route carrying `@RequirePermission`, and who it is for.
 *
 * EXHAUSTIVE, and asserted in both directions — a new gated route fails here until someone says
 * who it is for, and an entry naming a deleted handler fails too (the rot that
 * `coverage-include.spec.ts` exists to prevent). Routes declaring an `AuthzMode` instead of a code
 * are deliberately absent: there is no code to check, and `route-policy.ratchet.spec.ts` plus
 * `RouteAuthzAudit` already hold that surface.
 */
const AUDIENCE: Record<string, Audience> = {
  // ── AccessController ──
  /**
   * The role catalogue, with every role's full `permissions` array. Workspace Admin, because
   * `roles:view` is workspace-tier and only that tier holds it — and because the only surface still
   * reading this route is the Audit Log tab, which is `audit:view`, the same tier.
   *
   * It used to be `@SharedRead`, i.e. readable by any authenticated caller including one with no
   * assignments at all, and it appeared in `READ_AUDIENCE_GAPS` below for exactly that reason. The
   * entry is gone because the gap is: see the route's own docblock for why the "every member sees it
   * in a picker" justification stopped being true when custom roles were deleted.
   */
  'AccessController.listRoles': 'workspace-admin',
  'AccessController.getUserAssignments': 'workspace-admin',
  'AccessController.revokeRole': 'workspace-admin',

  // ── AuditController ──
  'AuditController.list': 'workspace-admin',

  // ── CapacityPlansController ── P5-CAP-AC-010: "Editor/No Access do not access Capacity
  // Planning." Also pinned per-handler by `capacity-access-gate.spec.ts`.
  'CapacityPlansController.addTeam': 'admin',
  'CapacityPlansController.allocate': 'admin',
  'CapacityPlansController.createPlan': 'admin',
  'CapacityPlansController.deletePlan': 'admin',
  'CapacityPlansController.forecastTeamCapacity': 'admin',
  'CapacityPlansController.getPlan': 'admin',
  'CapacityPlansController.listPlans': 'admin',
  'CapacityPlansController.moveItemToPlan': 'admin',
  'CapacityPlansController.publishPlan': 'admin',
  'CapacityPlansController.removeAllocation': 'admin',
  'CapacityPlansController.removeItemFromPlan': 'admin',
  'CapacityPlansController.removeTeam': 'admin',
  'CapacityPlansController.revertPlan': 'admin',
  'CapacityPlansController.setPrimaryAllocation': 'admin',
  'CapacityPlansController.setTeamCapacity': 'admin',
  'CapacityPlansController.updateAllocation': 'admin',
  'CapacityPlansController.updatePlan': 'admin',

  // ── CollaborationController ── comments on a work item: the Editor's own surface.
  'CollaborationController.createComment': 'editor',
  'CollaborationController.listComments': 'editor',

  // ── IterationsController ── the §3.2 split, pinned per-handler by
  // `iteration-timebox-gate.spec.ts`: `Plan > Timeboxes` is Hidden for an Editor, while
  // `Iteration Status` and every iteration PICKER are not.
  'IterationsController.acceptIteration': 'admin',
  'IterationsController.commitIteration': 'admin',
  'IterationsController.createIteration': 'admin',
  'IterationsController.createIterationItem': 'editor',
  'IterationsController.deleteIteration': 'admin',
  'IterationsController.getActivity': 'admin',
  'IterationsController.getAssignmentOptions': 'editor',
  'IterationsController.getIteration': 'admin',
  'IterationsController.getIterationStatus': 'editor',
  /**
   * The timebox RECORD, in a page. `admin`, and it USED to be `editor` — the entry directly below
   * `READ_AUDIENCE_GAPS['IterationsController.listIterations']`, which is now deleted, because this
   * is the fix that closed it. §3.2 marks `Plan > Timeboxes` Hidden for an Editor, and the grid is
   * the only surface left reading this route.
   */
  'IterationsController.listIterations': 'admin',
  /**
   * The REFERENCE feed split out of it, and the one that made moving the record possible: the four
   * §3.2 Editor surfaces (Iteration Status, the Backlog filter, Team Status, Quality) plus both
   * report scope pickers read this instead. Same split as `GET /releases/options`,
   * `GET /milestones/options` and the two `member-options` feeds — the sixth time that shape has
   * been the answer.
   */
  'IterationsController.listIterationReferences': 'editor',
  'IterationsController.rolloverIteration': 'admin',
  'IterationsController.updateIteration': 'admin',

  // ── MilestonesController ── §3.2 admin surface, except `options`: the REFERENCE feed split out
  // of the grid, and the one route here an Editor must reach — the Milestone picker on the Work
  // Item sidebar and Iteration Status. Same split as `GET /releases/options`.
  'MilestonesController.createMilestone': 'admin',
  'MilestonesController.listMilestoneOptions': 'editor',
  'MilestonesController.deleteMilestone': 'admin',
  'MilestonesController.getActivity': 'admin',
  'MilestonesController.getMilestone': 'admin',
  'MilestonesController.listMilestoneArtifactIds': 'admin',
  'MilestonesController.listMilestoneArtifacts': 'admin',
  'MilestonesController.listMilestoneProjects': 'admin',
  'MilestonesController.listMilestoneReleases': 'admin',
  'MilestonesController.listMilestoneTeams': 'admin',
  'MilestonesController.listMilestones': 'admin',
  'MilestonesController.setMilestoneArtifacts': 'admin',
  'MilestonesController.setMilestoneProjects': 'admin',
  'MilestonesController.setMilestoneReleases': 'admin',
  'MilestonesController.setMilestoneTeams': 'admin',
  'MilestonesController.updateMilestone': 'admin',

  // ── PortfolioAttachmentsController ── §5 admin surface.
  'PortfolioAttachmentsController.confirm': 'admin',
  'PortfolioAttachmentsController.content': 'admin',
  'PortfolioAttachmentsController.downloadUrl': 'admin',
  'PortfolioAttachmentsController.list': 'admin',
  'PortfolioAttachmentsController.presign': 'admin',
  'PortfolioAttachmentsController.remove': 'admin',

  // ── PortfolioCollaborationController ── §5 admin surface.
  'PortfolioCollaborationController.createComment': 'admin',
  'PortfolioCollaborationController.deleteComment': 'admin',
  'PortfolioCollaborationController.listComments': 'admin',
  'PortfolioCollaborationController.updateComment': 'admin',

  // ── PortfolioItemsController ── §5 admin surface. (`listItems` is `@AuthorizedInService`: the
  // project id is optional, so no decorator can express the check — see `portfolio-isolation`.)
  'PortfolioItemsController.archiveItem': 'admin',
  'PortfolioItemsController.createItem': 'admin',
  'PortfolioItemsController.getActivity': 'admin',
  'PortfolioItemsController.getItem': 'admin',
  'PortfolioItemsController.listChildFeatures': 'admin',
  'PortfolioItemsController.listChildren': 'admin',
  /**
   * The ONE Editor-facing route on an otherwise admin controller, and the exception is the point:
   * this is the `Feature` field's picker feed, not the Portfolio surface. §5.2:124 makes that field
   * the only way a Story's Feature membership is ever set and §3.2:79 gives an Editor
   * Create/View/Edit/Delete over Story/Defect, so it is gated on `work_item:view`. Everything else
   * here stays `portfolio:*`, which P5-PI-FR-017 withholds from an Editor.
   */
  'PortfolioItemsController.listFeatureOptions': 'editor',
  'PortfolioItemsController.rankItem': 'admin',
  'PortfolioItemsController.unarchiveItem': 'admin',
  'PortfolioItemsController.updateItem': 'admin',

  // ── ProjectsController ── §3.1: the structural rows are WA-only and carry `workspace:edit`
  // (workspace-tier), deliberately NOT `project:edit` — which stays in the Admin set because it
  // also gates label and workflow-status configuration, i.e. delivery configuration.
  'ProjectsController.addProjectMember': 'workspace-admin',
  'ProjectsController.archiveProject': 'workspace-admin',
  'ProjectsController.createLabel': 'admin',
  'ProjectsController.createProject': 'workspace-admin',
  'ProjectsController.deleteLabel': 'admin',
  'ProjectsController.deleteProject': 'workspace-admin',
  'ProjectsController.getActivity': 'editor',
  'ProjectsController.getEstimationSettings': 'editor',
  'ProjectsController.getProject': 'editor',
  'ProjectsController.linkTeam': 'workspace-admin',
  'ProjectsController.listLabels': 'editor',
  // The owner / assignee feed. `admin` here is this week's regression verbatim: gating the roster
  // left every Editor seeing `Unassigned` on every owned item, because the owner NAME is derived
  // from this list and a 403 defaulted to `[]`.
  'ProjectsController.listProjectMemberOptions': 'editor',
  'ProjectsController.listProjectMembers': 'editor',
  'ProjectsController.listProjectTeams': 'editor',
  'ProjectsController.listStatuses': 'editor',
  'ProjectsController.listTransitions': 'editor',
  'ProjectsController.removeProjectMember': 'workspace-admin',
  'ProjectsController.restoreProject': 'workspace-admin',
  'ProjectsController.unlinkTeam': 'workspace-admin',
  'ProjectsController.updateEstimationSettings': 'workspace-admin',
  'ProjectsController.updateLabel': 'admin',
  'ProjectsController.updateProject': 'workspace-admin',
  'ProjectsController.updateProjectMember': 'workspace-admin',

  // ── QualityController ── §5 Editor row: "Quality Defects View = Assigned Teams".
  'QualityController.listDefects': 'editor',

  // ── ReleasesController ── §3.2 marks `Plan > Releases` Hidden for an Editor, so the grid and
  // everything on it is `admin`. `options` is the REFERENCE feed split out of it, and is the one
  // route here an Editor must reach: it is what labels the Release column and fills the picker on
  // the Backlog, the Work Item sidebar and Quality. Same split as the two `member-options` feeds.
  'ReleasesController.createRelease': 'admin',
  'ReleasesController.deleteRelease': 'admin',
  'ReleasesController.getActivity': 'admin',
  'ReleasesController.getRelease': 'admin',
  'ReleasesController.listReleaseArtifacts': 'admin',
  'ReleasesController.listReleaseOptions': 'editor',
  'ReleasesController.listReleases': 'admin',
  'ReleasesController.updateRelease': 'admin',

  // ── ReportingController ── §5 admin surface. `report:view` reaching PROJECT_ADMIN at all is
  // migration 0092; before it, all five answered 403 to everyone but a WA.
  'ReportingController.getIterationBurndown': 'admin',
  'ReportingController.getReleaseBurnup': 'admin',
  'ReportingController.getReleaseTracking': 'admin',
  'ReportingController.getTeamCapacity': 'admin',
  'ReportingController.getVelocity': 'admin',

  // ── ScmController ── the integration is workspace configuration; the two per-item reads are
  // the work-item detail's SCM panel and belong to whoever can see the item.
  'ScmController.availableInstallations': 'workspace-admin',
  'ScmController.connectInstallation': 'workspace-admin',
  'ScmController.createRepository': 'workspace-admin',
  'ScmController.deleteRepository': 'workspace-admin',
  'ScmController.disconnectInstallation': 'workspace-admin',
  'ScmController.listChangesets': 'editor',
  'ScmController.listConnections': 'editor',
  'ScmController.listInstallations': 'workspace-admin',
  'ScmController.listRepositories': 'workspace-admin',
  'ScmController.syncRepository': 'workspace-admin',

  // ── TeamController ── §3.1 makes create/edit/deactivate Team and Team membership WA-only.
  'TeamController.addTeamMember': 'workspace-admin',
  'TeamController.createTeam': 'workspace-admin',
  'TeamController.removeTeamMember': 'workspace-admin',
  'TeamController.updateTeam': 'workspace-admin',
  // Deleting an archived team is team configuration, so the same audience as create/edit/deactivate —
  // and the same code, because a new `teams:delete` would reach no existing workspace without a
  // backfill migration for an audience that cannot differ from this one.
  'TeamController.deleteTeam': 'workspace-admin',

  // ── TeamStatusController ── §5 gives the Editor `Team Status | View` (their own teams' hours)
  // and not the edit. `team_status:edit` is the Admin code.
  'TeamStatusController.getTeamStatus': 'editor',
  'TeamStatusController.updateCapacity': 'admin',
  'TeamStatusController.updateTask': 'admin',

  // ── WorkItemsController ── the Editor's whole job. Every handler here, deliberately: an Editor
  // is a "delivery contributor" (§2.2) and `work_item:*` is the set that says so. `by-key`,
  // `reorder` and `summary` are `@AuthorizedInService` — item keys are workspace-unique, so the
  // owning project is unknown until the row loads.
  'WorkItemsController.addLabel': 'editor',
  'WorkItemsController.bulkAssignIteration': 'editor',
  'WorkItemsController.bulkAssignRelease': 'editor',
  'WorkItemsController.confirmAttachment': 'editor',
  'WorkItemsController.createRelation': 'editor',
  'WorkItemsController.createTask': 'editor',
  'WorkItemsController.createWorkItem': 'editor',
  'WorkItemsController.deleteAttachment': 'editor',
  'WorkItemsController.deleteRelation': 'editor',
  'WorkItemsController.deleteTimeLog': 'editor',
  'WorkItemsController.deleteWorkItem': 'editor',
  'WorkItemsController.getActivity': 'editor',
  'WorkItemsController.getAttachmentContent': 'editor',
  'WorkItemsController.getAttachmentDownloadUrl': 'editor',
  // Split's preview. `work_item:view`, not `work_item:edit`, DELIBERATELY: a reader may open a Story
  // and be told the action is unavailable, so the edit check (BR-04) is a FIELD of the answer
  // (`ineligibleReason: 'not_editable'`) rather than a 403. Audience `editor` because splitting a
  // Story is an Editor action (§3.2:79) and the preview is what decides whether to offer it — this is
  // the "a gate chosen for what the action IS, not for where the id lives" reading.
  'WorkItemsController.getSplitPreview': 'editor',
  'WorkItemsController.getTaskTotals': 'editor',
  'WorkItemsController.getWorkItem': 'editor',
  'WorkItemsController.listAttachments': 'editor',
  'WorkItemsController.listBacklog': 'editor',
  'WorkItemsController.listRelations': 'editor',
  // The Parent Story picker feed. `editor` because logging a Defect and naming the Story it was
  // found against is an Editor action (§3.2:79) — the same audience as `listBacklog`, which used to
  // serve this picker and hid every sprint-scheduled Story from it.
  'WorkItemsController.listStoryOptions': 'editor',
  'WorkItemsController.listTasks': 'editor',
  'WorkItemsController.listTimeLogs': 'editor',
  'WorkItemsController.listWatchers': 'editor',
  'WorkItemsController.listWorkItemLabels': 'editor',
  'WorkItemsController.listWorkItemMilestones': 'editor',
  'WorkItemsController.listWorkItems': 'editor',
  'WorkItemsController.logTime': 'editor',
  'WorkItemsController.moveWorkItem': 'editor',
  'WorkItemsController.presignAttachment': 'editor',
  'WorkItemsController.rankWorkItem': 'editor',
  'WorkItemsController.removeLabel': 'editor',
  'WorkItemsController.setWorkItemMilestones': 'editor',
  'WorkItemsController.unwatch': 'editor',
  'WorkItemsController.updateTimeLog': 'editor',
  'WorkItemsController.updateWorkItem': 'editor',
  'WorkItemsController.watch': 'editor',

  // ── WorkflowController ── workflow statuses and transitions are delivery CONFIGURATION, which
  // §3.1's own summary gives a per-Project Admin.
  'WorkflowController.createStatus': 'admin',
  'WorkflowController.createTransition': 'admin',
  'WorkflowController.deleteStatus': 'admin',
  'WorkflowController.deleteTransition': 'admin',
  'WorkflowController.reorderStatuses': 'admin',

  // ── WorkspaceController ── the administrative half of the RBE-07 roster split; the picker feed
  // `listMemberOptions` carries no code and is scoped in the service (see `roster-split-gate`).
  'WorkspaceController.addMember': 'workspace-admin',
  'WorkspaceController.cancelInvitation': 'workspace-admin',
  'WorkspaceController.createWorkspace': 'workspace-admin',
  'WorkspaceController.deleteWorkspace': 'workspace-admin',
  'WorkspaceController.getSettings': 'workspace-admin',
  'WorkspaceController.inviteMember': 'workspace-admin',
  'WorkspaceController.listInvitations': 'workspace-admin',
  'WorkspaceController.listMembersWithProfile': 'workspace-admin',
  'WorkspaceController.removeMember': 'workspace-admin',
  'WorkspaceController.resendInvitation': 'workspace-admin',
  // Same actor and same credential-issuing power as resend — it ROTATES the accept
  // token and hands it to the inviter — so the same audience decides both.
  'WorkspaceController.buildInvitationLink': 'workspace-admin',
  'WorkspaceController.updateMember': 'workspace-admin',
  'WorkspaceController.updateSettings': 'workspace-admin',
  'WorkspaceController.updateWorkspace': 'workspace-admin',
};

/**
 * A WRITE that names a reference, and the permission that gates READING that reference.
 *
 * This is the other half of the class, and the half a per-route check structurally cannot see: the
 * gate on `PATCH /work-items/:id` is right, the gate on `GET /releases` is right, and the
 * COMBINATION lets a level assign a Release it cannot list. That is this week's owner-picker
 * regression in a different namespace — a 403 (or an empty `listReadableProjectIds`) on a feed,
 * defaulted to `[]` by the SPA, rendering as "there are none".
 *
 * The catalogue's own second invariant states the rule for one namespace ("a role granting `X:edit`
 * always holds the matching `X:view` — you can't manage what you can't see"). These are the pairs
 * that cross a namespace, where nothing was checking it.
 */
interface ReferenceFeed {
  /** The write, as an `AUDIENCE` key. */
  write: string;
  /** The field or route that names the reference — for the failure message. */
  via: string;
  /**
   * The route serving the picker feed, as an `AUDIENCE` key. Its permission is read by REFLECTION
   * rather than restated here, so splitting a feed out of an administrative grid (which is the fix
   * for a gap below) is picked up without editing this table.
   */
  feedRoute?: string;
  /** The permission gating the feed when the narrowing lives in the SERVICE, not on the route. */
  feedPermission?: Permission;
  /** Human label for the failure message. */
  feed: string;
}

const REFERENCE_FEEDS: readonly ReferenceFeed[] = [
  {
    write: 'WorkItemsController.bulkAssignRelease',
    via: 'PATCH /work-items/bulk-release',
    feedRoute: 'ReleasesController.listReleaseOptions',
    feed: 'GET /releases/options',
  },
  {
    write: 'WorkItemsController.updateWorkItem',
    via: 'UpdateWorkItemSchema.releaseId',
    feedRoute: 'ReleasesController.listReleaseOptions',
    feed: 'GET /releases/options',
  },
  {
    write: 'WorkItemsController.setWorkItemMilestones',
    via: 'PUT /work-items/:id/milestones',
    feedRoute: 'MilestonesController.listMilestoneOptions',
    feed: 'GET /milestones/options',
  },
  /**
   * `UpdateWorkItemSchema.featureId` → `GET /portfolio-items/options`, and the history is worth
   * keeping: this slot held a note saying the pair was DELIBERATELY ABSENT because, measured over
   * HTTP, the parent-Feature picker was populated for an Editor even though they hold no
   * `portfolio:view`. That measurement was right and its explanation was the defect — the picker
   * read `GET /portfolio-items`, and `listReadableProjectIds` unioned in every project the caller
   * had a membership row on WITHOUT filtering by the permission it was asked about. Closing that
   * over-grant emptied the picker, which is what turned this from "not a gap" into a real one.
   *
   * So the note's own instruction ("do not re-add this pair without measuring it first") was
   * followed: it was measured, it failed, and the answer was a reference feed rather than
   * re-opening the read. The lesson it recorded still stands, though — where a narrowing lives in
   * a service, the catalogue is not the gate, and this file cannot see it.
   */
  {
    write: 'WorkItemsController.updateWorkItem',
    via: 'UpdateWorkItemSchema.featureId',
    feedRoute: 'PortfolioItemsController.listFeatureOptions',
    feed: 'GET /portfolio-items/options',
  },
  // ── The pairs that HOLD, kept deliberately: a one-sided check passes just as well when the
  // feed is over-gated, which is the direction that broke the owner picker.
  {
    write: 'WorkItemsController.bulkAssignIteration',
    via: 'PATCH /work-items/bulk-iteration',
    feedRoute: 'IterationsController.getAssignmentOptions',
    feed: 'GET /iterations/options',
  },
  {
    write: 'WorkItemsController.updateWorkItem',
    via: 'UpdateWorkItemSchema.assigneeId',
    feedRoute: 'ProjectsController.listProjectMemberOptions',
    feed: 'GET /projects/:id/member-options',
  },
  {
    write: 'WorkItemsController.addLabel',
    via: 'POST /work-items/:id/labels',
    feedRoute: 'ProjectsController.listLabels',
    feed: 'GET /projects/:id/labels',
  },
  {
    write: 'WorkItemsController.updateWorkItem',
    via: 'UpdateWorkItemSchema.statusId',
    feedRoute: 'ProjectsController.listStatuses',
    feed: 'GET /projects/:id/statuses',
  },
  {
    write: 'WorkItemsController.updateWorkItem',
    via: 'UpdateWorkItemSchema.teamId',
    feedRoute: 'ProjectsController.listProjectTeams',
    feed: 'GET /projects/:id/teams',
  },
];

/**
 * The reference feeds a level can WRITE but not READ, today. LIVE DEFECTS, declared so they are
 * counted rather than hidden — the `@AuthzGap` pattern.
 *
 * Both are outside this change's reach: fixing them means either granting the Editor the read code
 * (a catalogue entry PLUS a backfill migration, since `bootstrap.ts` upserts tier roles with
 * `set: { name }`, so a new permission never reaches an existing workspace) or splitting the feed
 * from the surface — the way RBE-07 split the roster, `timebox:view` split `Plan > Timeboxes`, and
 * `GET /releases/options` was just split out of `GET /releases`. The second is the shape that has
 * been chosen three times now, and it needs a controller change in `libs/modules/milestones` and
 * `libs/modules/portfolio`.
 *
 * Asserted as an EXACT SET, so it can only be edited deliberately: fixing one fails this test
 * until the entry is removed, and a NEW gap fails it too. Key is `level|write|feedPermission`.
 */
const KNOWN_REFERENCE_FEED_GAPS: readonly string[] = [
  // EMPTY, and it should stay that way. Two gaps were open when this sweep was written — the
  // Release picker (`GET /releases` was `release:view`, Admin-only, while `PATCH bulk-release` is
  // `work_item:edit`) and the Milestone picker (`GET /milestones` is `milestone:view` while
  // `PUT :id/milestones` is `work_item:edit`). Both were closed by splitting a reference feed out
  // of the administrative grid — `GET /releases/options` and `GET /milestones/options`, both
  // `project:view` — which is now the fourth and fifth time that shape has been the answer, after
  // the two `member-options` feeds and `timebox:view`.
  //
  // A NEW entry here is a decision to ship a picker somebody cannot populate. Argue it in review.
];

// ── Ratchets — these may only move in the tightening direction ────────────────
/**
 * Routes whose audience is a PROJECT level, i.e. the ones a Workspace Admin's `workspace:*` would
 * mask. MAY ONLY RISE.
 *
 * This is the number that matters, and it is why the ratchet is on this and not on the table size:
 * the cheap way to make a failure here go away is to relabel the route `workspace-admin`, which
 * "fixes" the test by declaring the defect intentional. That lowers this count and fails.
 *
 * Measured by forcing the baseline high and reading the count the failure reports — not by grepping,
 * which counts decorator TEXT and so cannot tell a class-level decorator, a commented one or a prose
 * mention from a real gate. 137 of 176 gated routes (81 admin + 56 editor), out of 215 handlers, on
 * 2026-08-14.
 *
 * Raised 137→138 by the iteration feed split, which added `listIterationReferences` (editor) and
 * moved `listIterations` from editor to admin — still project-tier, so still counted. Measured
 * 2026-08-15 by forcing this constant high and reading the count the failure reports: **139**. Never
 * by grep — CLAUDE.md records a grep answering 8 where the real count was 2.
 *
 * It sat at 138 for part of that day, one BELOW the measurement, because the extra route belonged to
 * a change running concurrently and baking someone else's contribution into a floor would fail this
 * file if that change landed on its own. Both landed together, so the floor is the measurement again.
 */
const MIN_PROJECT_TIER_ROUTES_COVERED = 139;

/**
 * Sanity floor: if the reflection stops finding routes, fail loudly rather than silently. A scan
 * that finds nothing reports no violations, which is indistinguishable from a clean surface —
 * `RouteAuthzAudit` has the same floor for the same reason, and it fired there for real.
 *
 * Deliberately loose (215 discovered) because it is a liveness check, not a ratchet: the exact
 * inventory is held by the exhaustiveness assertions below, which name what changed.
 */
const MIN_ROUTES_FOUND = 200;
/** `git ls-files 'libs/**\/*.controller.ts' 'apps/**\/*.controller.ts'` minus HealthController. */
const CONTROLLER_COUNT = 26;

interface DiscoveredRoute {
  key: string;
  method: string;
  path: string;
  code: Permission | undefined;
  mode: string | undefined;
}

/** Every route handler, read exactly as `RouteAuthzAudit` reads them (`PATH_METADATA` present). */
function discoverRoutes(): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  for (const ctor of CONTROLLERS) {
    const prototype = ctor.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === 'constructor') continue;
      const handler = prototype[name];
      if (typeof handler !== 'function') continue;
      if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;
      const policy = Reflect.getMetadata(POLICY_KEY, handler) as
        { permission?: Permission } | undefined;
      const mode = Reflect.getMetadata(AUTHZ_MODE_KEY, handler) as { mode?: string } | undefined;
      routes.push({
        key: `${ctor.name}.${name}`,
        method: String(Reflect.getMetadata(METHOD_METADATA, handler)),
        path: String(Reflect.getMetadata(PATH_METADATA, handler)),
        code: policy?.permission,
        mode: mode?.mode,
      });
    }
  }
  return routes;
}

/** The project access levels that can call a route gated on `code`. */
function levelsHolding(code: Permission): ProjectAccessLevel[] {
  return PROJECT_ACCESS_LEVEL.filter((level) =>
    permissionGrants(ACCESS_LEVEL_PERMISSIONS[level], code),
  );
}

/** What the declared code actually implies about who may call the route. */
function actualAudience(code: Permission): Audience {
  const levels = levelsHolding(code);
  if (levels.includes('editor')) return 'editor';
  if (levels.includes('admin')) return 'admin';
  return 'workspace-admin';
}

const ROUTES = discoverRoutes();
/** A route carrying `@RequirePermission`, narrowed so `code` needs no non-null assertion. */
type GatedRoute = DiscoveredRoute & { code: Permission };
const GATED: GatedRoute[] = ROUTES.filter((r): r is GatedRoute => r.code !== undefined);

describe("every gated route's code is one its intended audience can hold", () => {
  it('finds the controller surface it claims to sweep', () => {
    // A reflection scan that finds nothing reports no violations, which is indistinguishable from
    // a clean surface. Same floor, and the same reason, as `RouteAuthzAudit`.
    expect(CONTROLLERS.length, 'controllers imported').toBe(CONTROLLER_COUNT);
    expect(ROUTES.length, 'route handlers discovered').toBeGreaterThanOrEqual(MIN_ROUTES_FOUND);
    expect(GATED.length, 'routes carrying @RequirePermission').toBeGreaterThan(0);
  });

  it('classifies every gated route, and names no route that no longer exists', () => {
    const unclassified = GATED.filter((r) => AUDIENCE[r.key] === undefined);
    expect(
      unclassified.length,
      `${unclassified.length} gated route(s) have no declared audience:\n` +
        unclassified.map((r) => `  ${r.key}  (${r.code})`).join('\n') +
        `\n\nAdd each to AUDIENCE saying who the route is FOR — 'editor', 'admin' or ` +
        `'workspace-admin'. Deciding that is the whole point: a code chosen for where the id ` +
        `lives rather than for what the action is is invisible to the Workspace Admin who runs ` +
        `the app locally.`,
    ).toBe(0);

    const live = new Set(GATED.map((r) => r.key));
    const stale = Object.keys(AUDIENCE).filter((key) => !live.has(key));
    expect(
      stale.length,
      `${stale.length} AUDIENCE entr(ies) name a handler that no longer carries ` +
        `@RequirePermission:\n  ${stale.join('\n  ')}\n\nA stale entry is how a table stops ` +
        `describing the code it claims to check.`,
    ).toBe(0);
  });

  it('gates each route on a code its intended audience actually holds', () => {
    const wrong = GATED.filter((r) => actualAudience(r.code) !== AUDIENCE[r.key]).map(
      (r) =>
        `  ${r.key}\n      declares ${r.code} (reachable by: ` +
        `${levelsHolding(r.code).join(', ') || 'workspace_admin only'})\n` +
        `      intended audience: ${AUDIENCE[r.key]}, actual: ${actualAudience(r.code)}`,
    );

    expect(
      wrong.length,
      `${wrong.length} route(s) are gated on a code their intended audience cannot hold, or can ` +
        `hold when they should not:\n${wrong.join('\n')}\n\n` +
        `Either the code is wrong for the route, or the catalogue no longer grants it to the ` +
        `level that needs it. The second is the report:view defect: a permission added to ` +
        `db/permissions.catalog.ts needs a BACKFILL MIGRATION to reach an existing workspace, ` +
        `because db/seeds/bootstrap.ts upserts tier roles with set: { name }.`,
    ).toBe(0);
  });

  it('never gates a project-level route on a WORKSPACE-tier code', () => {
    /**
     * The `GET /work-items/by-key` shape, stated as an invariant. `workspace:*` is admin-reserved
     * and neither project level holds ANY `workspace:*` code, so a workspace-tier code on a route
     * an Editor or a per-project Admin must call is unconditionally a dead gate — no catalogue
     * edit can rescue it. The tier-safe overloads make it easy to reach for: a workspace-tier code
     * takes no scope, so it is what compiles when the project id is awkward to name.
     */
    const dead = GATED.filter(
      (r) => AUDIENCE[r.key] !== 'workspace-admin' && !isProjectTierPermission(r.code),
    ).map((r) => `  ${r.key} declares the workspace-tier ${r.code} but is for ${AUDIENCE[r.key]}`);

    expect(
      dead.length,
      `${dead.length} route(s) carry a workspace-tier code while serving a project-tier ` +
        `audience:\n${dead.join('\n')}\n\nNo per-project grant can ever satisfy this — it 403s ` +
        `every non-admin caller while answering 200 for the Workspace Admin who tests it. If the ` +
        `project id is only knowable after loading the row, that is @AuthorizedInService with a ` +
        `pinning spec, not a workspace-tier code.`,
    ).toBe(0);
  });

  it('leaves a project-tier code unreachable by any project level only where §3.1 says so', () => {
    /**
     * The `report:view` shape from the other side: a project-tier code that NO project level
     * holds. Six routes are legitimately in that state — §3.1 reserves Project archive / restore /
     * delete and Project access assignment for the Workspace Admin — and enumerating them is what
     * makes the seventh visible.
     */
    const unreachable = GATED.filter(
      (r) =>
        isProjectTierPermission(r.code) &&
        levelsHolding(r.code).length === 0 &&
        !STRUCTURAL_WORKSPACE_ADMIN_ROUTES.has(r.key),
    ).map((r) => `  ${r.key} → ${r.code}`);

    expect(
      unreachable.length,
      `${unreachable.length} project-tier route(s) declare a code no project access level holds, ` +
        `and are not one of the six §3.1 structural rows:\n${unreachable.join('\n')}\n\n` +
        `This is the shape of the report:view defect — the code exists, the route is correctly ` +
        `project-tier, and the catalogue grants it to nobody who would call it.`,
    ).toBe(0);

    // Both directions: an entry that stopped being unreachable means §3.1 moved, or a level was
    // granted a structural code. Either is a decision, not a silent improvement.
    const noLongerStructural = [...STRUCTURAL_WORKSPACE_ADMIN_ROUTES].filter((key) => {
      const route = GATED.find((r) => r.key === key);
      return !route || levelsHolding(route.code).length > 0;
    });
    expect(
      noLongerStructural.length,
      `${noLongerStructural.length} route(s) listed as §3.1 structural are no longer ` +
        `Workspace-Admin-only:\n  ${noLongerStructural.join('\n  ')}`,
    ).toBe(0);
  });

  it('lets any level that can WRITE a reference also READ the feed it picks from', () => {
    const violations: string[] = [];
    const label = new Map<string, ReferenceFeed>();

    for (const pair of REFERENCE_FEEDS) {
      const write = GATED.find((r) => r.key === pair.write);
      if (!write) {
        // A throw, not a soft expectation: the loop below would otherwise skip the pair silently
        // and this test would report "no gaps" for a table that names a route nobody serves.
        throw new Error(`REFERENCE_FEEDS names ${pair.write}, which is not a gated route`);
      }

      // Read the feed's code off the route where there is one, so a feed SPLIT lands here without
      // this table being edited; fall back to the declared code where the narrowing is in-service.
      const feedCode = pair.feedPermission ?? GATED.find((r) => r.key === pair.feedRoute)?.code;
      if (!feedCode) {
        throw new Error(
          `REFERENCE_FEEDS entry for ${pair.write} resolves no feed permission — feedRoute ` +
            `'${pair.feedRoute}' is not a gated route and no feedPermission was given.`,
        );
      }

      for (const level of PROJECT_ACCESS_LEVEL) {
        const codes = ACCESS_LEVEL_PERMISSIONS[level];
        if (!permissionGrants(codes, write.code)) continue;
        if (permissionGrants(codes, feedCode)) continue;
        const key = `${level}|${pair.write}|${feedCode}`;
        label.set(key, pair);
        violations.push(key);
      }
    }

    const found = [...new Set(violations)].sort();
    const known = [...KNOWN_REFERENCE_FEED_GAPS].sort();
    const detail = (keys: string[]) =>
      keys
        .map((key) => {
          const pair = label.get(key) ?? REFERENCE_FEEDS.find((p) => p.write === key.split('|')[1]);
          return `  ${key}\n      writes via ${pair?.via}\n      cannot read ${pair?.feed}`;
        })
        .join('\n');

    const appeared = found.filter((key) => !known.includes(key));
    expect(
      appeared.length,
      `${appeared.length} NEW write-without-read gap(s):\n${detail(appeared)}\n\n` +
        `A level that may set a reference must be able to list it. Otherwise the picker is empty ` +
        `and the SPA's \`data ?? []\` renders that as "there are none" — the owner-picker ` +
        `regression, in a new namespace. Do not add to KNOWN_REFERENCE_FEED_GAPS to silence this.`,
    ).toBe(0);

    const fixed = known.filter((key) => !found.includes(key));
    expect(
      fixed.length,
      `${fixed.length} gap(s) in KNOWN_REFERENCE_FEED_GAPS no longer exist:\n${detail(fixed)}\n\n` +
        `Remove them — the list is the record of what is still broken, and a stale entry makes it ` +
        `read as worse than it is.`,
    ).toBe(0);
  });

  it(`covers at least ${MIN_PROJECT_TIER_ROUTES_COVERED} routes an Editor or per-project Admin must reach`, () => {
    const covered = GATED.filter((r) => AUDIENCE[r.key] !== 'workspace-admin');
    expect(
      covered.length,
      `Project-tier route coverage FELL to ${covered.length} (baseline ` +
        `${MIN_PROJECT_TIER_ROUTES_COVERED}). These are the routes a Workspace Admin's ` +
        `workspace:* masks, so this number falling means either a route was deleted or one was ` +
        `relabelled 'workspace-admin' to make an assertion above pass. The second is not a fix.`,
    ).toBeGreaterThanOrEqual(MIN_PROJECT_TIER_ROUTES_COVERED);
  });

  it('keeps the tier sets monotonic, so an Editor audience implies an Admin one', () => {
    // `AUDIENCE` reads 'editor' as "at least an Editor", which is only meaningful while
    // project_member ⊆ project_admin — the catalogue's first stated invariant. Asserted here
    // because every 'editor' entry above silently depends on it.
    const missing = ROLE_PERMISSIONS.project_member.filter(
      (code) => !permissionGrants(ROLE_PERMISSIONS.project_admin, code),
    );
    expect(
      missing.length,
      `project_member holds ${missing.length} code(s) project_admin does not: ${missing.join(', ')}`,
    ).toBe(0);
  });
});

/**
 * ── The READ-AUDIENCE contract ───────────────────────────────────────────────────────────────────
 *
 * THE RULE, in one sentence: **an endpoint that returns a field a participant may not see is
 * ADMINISTRATIVE, and it must not be the only feed for a picker.**
 *
 * The block above checks the GATE against the intended audience. This one checks the PAYLOAD against
 * it, which is the half that failed silently three times:
 *
 *   • `GET /workspaces/:id/members-with-profile` returned `phone`, `lastLoginAt` and every role id
 *     with NO authorization code at all — because it was also the owner-picker feed, so gating it
 *     would have 403'd ordinary delivery screens. Recorded in CLAUDE.md as deferred behind "split the
 *     feed first"; it stayed open for a week.
 *   • `GET /projects/:id/members` returns `accessLevel`, `status` and `teamCount` and its decorator is
 *     `project:view`, which every level holds. It is narrowed in the SERVICE — so the payload is
 *     administrative while the gate is not, and nothing recorded that.
 *   • `MemberOptionResponseSchema` — the reference feed created to fix the first bullet — shipped a
 *     person's account `status` while its own docblock said "four display fields and nothing else".
 *
 * All three are payload facts. A gate sweep cannot see any of them, and neither can a docblock.
 *
 * HOW IT WORKS
 * The response DTO is read off `swagger/apiResponse` (`{ type }`) or, for a paged route, off
 * `swagger/apiExtraModels` — the two shapes `@ApiResponse` and `@ApiPagedResponse` actually record.
 * `createZodDto` exposes the schema as a static, so the FIELD NAMES come from the zod shape rather
 * than from a regex over the DTO file. A route that declares no response type is invisible here, and
 * that is a known limit: `ProjectsController.listProjectTeams` and `TeamController.*` return plain
 * objects.
 *
 * WHY THE SENSITIVE SET IS SPLIT IN TWO
 * `status` is the field that forces it. On a PERSON it is an account state (`active | suspended |
 * removed`) and belongs to User Management; on a release, a milestone or a project it is the record's
 * own lifecycle and every participant sees it in a grid. One flat list would either miss the first or
 * flag every entity in the product — which is how a ratchet stops being read.
 */

/** Fields nobody but an administrator may read, on ANY schema. */
const ALWAYS_ADMIN_FIELDS = [
  'phone',
  'lastLoginAt',
  'lastLogin',
  'permissions',
  'invitedBy',
  'acceptedBy',
  'resendCount',
  'deactivatedAt',
] as const;

/**
 * Fields nobody but an administrator may read ON A PERSON. Each is a §3.1 administration fact:
 * `accessLevel` and `teamCount` are the "Assign Project access and Team membership" row, the role
 * fields are the Permission Model, and `status` is "Invite / disable / remove company user".
 */
const PERSON_ADMIN_FIELDS = [
  'accessLevel',
  'teamCount',
  'roleId',
  'roleIds',
  'roleName',
  'roleSlug',
  'roleAssignmentId',
  'status',
] as const;

/**
 * Fields nobody but an administrator may read on a PLANNING RECORD — the narrative and the forecast a
 * §3.2/§5 admin surface owns, as opposed to the identity a picker needs.
 *
 * `description` is deliberately NOT here: it is shown wherever the entity is named, an Editor included.
 * `theme` would add no coverage (every schema carrying it also carries `goal` or `notes`) and is left
 * out rather than padding the list, which is how a designated set stops being read.
 */
const RECORD_ADMIN_FIELDS = [
  'goal',
  'notes',
  'plannedVelocity',
  'health',
  'preliminaryEstimate',
  'refinedEstimate',
  'whatSuccessLooksLike',
] as const;

/**
 * A schema is a PLANNING RECORD when it carries a PLAN: a goal, a planned velocity, or a health
 * verdict. Structural, for the same reason {@link isPersonSchema} is — and it is the test that makes
 * `notes` usable as a designated field at all.
 *
 * `notes` is overloaded exactly the way `status` is. On an iteration or a Feature it is planning
 * commentary the BA hides from an Editor; on a WORK ITEM it is the Editor's own field, on their own
 * record, on the screen they live in. `WorkItemResponseDto` carries `notes` and none of the three
 * plan markers, so it is not a planning record and is not flagged — which is correct, and is the
 * false positive that forced this distinction to be written down rather than guessed at.
 */
function isPlanningRecordSchema(fields: ReadonlySet<string>): boolean {
  return fields.has('goal') || fields.has('plannedVelocity') || fields.has('health');
}

/**
 * A schema is ABOUT A PERSON when it is keyed by one — `userId`, or the name/email pair every roster
 * and picker carries. Structural rather than by name, so a `TeamMemberDto` or a `MemberOptionDto`
 * added later is covered without being listed.
 *
 * `WatcherResponseDto` (`userId`, `watchedAt`) and `TimeLogResponseDto` are person schemas by this
 * test and rightly so — neither carries an administration field, so neither is flagged.
 */
function isPersonSchema(fields: ReadonlySet<string>): boolean {
  return fields.has('userId') || (fields.has('displayName') && fields.has('email'));
}

/**
 * Routes that return an administration field to a participant-holdable code, and are NOT defects.
 *
 * An EXACT SET, asserted in both directions: an entry that stops being needed fails this test, so it
 * cannot rot into a permanent exemption. Every one of them must say WHERE the real narrowing lives —
 * "it is fine" is not a reason, and neither is "nobody has complained".
 */
const READ_AUDIENCE_EXCEPTIONS: Record<string, string> = {
  /**
   * The project roster. Its decorator MUST be `project:view` — the param is the project id and no
   * narrower project-tier code exists — and `ProjectsService.listProjectMembers` then refuses any
   * level except `admin` (§3.1:71, allow-list not deny-list). So the payload is administrative and
   * the DECORATOR cannot say so.
   *
   * This is the one shape that genuinely needs an exception, and it is also the shape that hid the
   * owner-picker regression: because the gate reads Editor-holdable, nothing at this layer records
   * that an Editor gets a 403 — which is why `test/e2e/authz-cluster.e2e.spec.ts` asserts that 403
   * directly, and asserts `:id/member-options` beside it.
   */
  'ProjectsController.listProjectMembers':
    'narrowed in ProjectsService to admin|WA; the 403 is pinned in authz-cluster.e2e.spec.ts',
  /**
   * "My own permissions" — the subject reading their own grant, which is what `@AuthorizedInService`
   * with mode `self-scoped` means. `permissions` about oneself is not an administration fact; it is
   * how the SPA gates its own buttons (`useProjectPermissions`).
   */
  'AccessController.getMyProjectPermissions':
    'self-scoped: the subject reads their own permissions',
};

/**
 * LIVE DEFECTS in this dimension, declared so they are counted rather than rediscovered. Same
 * `@AuthzGap` shape as `KNOWN_REFERENCE_FEED_GAPS`, and asserted as an exact set for the same reason.
 *
 * NONE is live. `PortfolioItemsController.listItems` is the only entry left and it is CLOSED, as its
 * own note says: the key is still computed by this sweep, so the entry has to stay even though the
 * defect does not.
 *
 * `WorkspaceController.listMembers` left by the third route out: the ROUTE was deleted. Its payload
 * was a per-person `roleId` and account `status` behind no permission code and no scope, and it had
 * no SPA consumer at all — so a gate would have preserved a dead route, which is worse than none
 * (it keeps the payload alive for whoever finds it next and reads, in review, as a considered
 * decision about an audience). `GET :id/member-options` and `GET :id/members-with-profile` already
 * serve its two real audiences.
 *
 * `AccessController.listRoles` was here and is GONE, which is the other way an entry leaves: the
 * route took a real gate (`roles:view`), so the sweep now classifies it by AUDIENCE and this file
 * fails if a closed gap is still declared. Deleting the entry is the required half of that fix.
 *
 * `IterationsController.listIterations` left the same way, and it is worth recording what it took,
 * because the entry sat here describing a live defect for a week. It was the timebox RECORD
 * (`goal`, `theme`, `notes`, `plannedVelocity`) on a feed an Editor MUST be able to read — four §3.2
 * Editor surfaces had no other iteration feed. `IterationOptionDto` could not be pointed at, because
 * `GET /iterations/options` filtered to `planning | committed` and an ACCEPTED iteration still has
 * to resolve to a name. So the endpoint was split by the QUESTION rather than by a flag:
 * `GET /iterations/options` became the REFERENCE feed (every state, `iteration:view`,
 * `IterationReferenceDto`), the eligibility population moved to `GET /iterations/assignable`, and
 * the record list took `timebox:view`. A flag would have been the conflation that produced the
 * zero-point Velocity bars, in a new place.
 */
const READ_AUDIENCE_GAPS: Record<string, string> = {
  /**
   * NOT A LIVE DEFECT ANY MORE — the entry stays because this file's sweep is decorator- and
   * payload-only, so it still computes this key and an exact-set assertion would fire on its
   * removal. Deleting it would also delete the record of what it caught.
   *
   * What it described: `GET /portfolio-items` carries NO permission code — mode `in-service` — and
   * narrows by `listReadableProjectIds(..., 'portfolio:view')`, whose membership half unioned in
   * every project the caller had a `project_members` row on WITHOUT filtering by that permission. So
   * an Editor read every field of every Feature and Epic in their own project — `notes`, `estimate`,
   * `health`, the owner — while §5 and §3.2 mark `Portfolio Items` Hidden for one. The BA audit of
   * 2026-08-14 scored that row NOT SATISFIED and named the cause exactly: "enforced by a route that
   * never reads it".
   *
   * Closed on 2026-08-14 at the source, in `AccessService.listReadableProjectIds`: membership now
   * reaches the result only through the permission-filtered synthesis, so an Editor's `readable` is
   * `[]` here and the list answers 200 with no rows. The route stays undecorated because its
   * `projectId` is genuinely optional — a Workspace Admin lists across projects — and
   * `test/e2e/authz-cluster.e2e.spec.ts` measures the emptiness over HTTP, which is the only place
   * that can.
   *
   * The route was ALSO the parent-Feature picker's only feed, which is why gating it alone would
   * have broken a field §5.2:124 makes an Editor's own. Split into
   * `GET /portfolio-items/options` in the same change.
   */
  'PortfolioItemsController.listItems':
    'no code, by design; the record stays admin-only through the service scope, measured in authz-cluster.e2e',
};

interface RouteSchema {
  key: string;
  code: Permission | undefined;
  dtoNames: string[];
  fields: Set<string>;
}

/** The response DTOs a GET route declares, and the union of their zod field names. */
function discoverResponseSchemas(): RouteSchema[] {
  const out: RouteSchema[] = [];
  for (const ctor of CONTROLLERS) {
    const prototype = ctor.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === 'constructor') continue;
      const handler = prototype[name];
      if (typeof handler !== 'function') continue;
      if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;
      // 0 is `RequestMethod.GET`. Reads only: a write's response body is the row the caller just
      // authored, and the write's own gate is what decides whether they may.
      if (Number(Reflect.getMetadata(METHOD_METADATA, handler)) !== 0) continue;

      const responses = Reflect.getMetadata('swagger/apiResponse', handler) as
        Record<string, { type?: unknown }> | undefined;
      const extra = Reflect.getMetadata('swagger/apiExtraModels', handler) as unknown[] | undefined;
      const candidates: unknown[] = [];
      for (const status of ['200', '201']) {
        const declared = responses?.[status]?.type;
        if (declared) candidates.push(declared);
      }
      for (const model of extra ?? []) candidates.push(model);

      const dtoNames: string[] = [];
      const fields = new Set<string>();
      for (const candidate of candidates) {
        if (typeof candidate !== 'function') continue;
        dtoNames.push((candidate as { name: string }).name);
        const schema = (candidate as unknown as { schema?: { shape?: Record<string, unknown> } })
          .schema;
        for (const field of Object.keys(schema?.shape ?? {})) fields.add(field);
      }

      const policy = Reflect.getMetadata(POLICY_KEY, handler) as
        { permission?: Permission } | undefined;
      out.push({ key: `${ctor.name}.${name}`, code: policy?.permission, dtoNames, fields });
    }
  }
  return out;
}

const READS = discoverResponseSchemas();
const TYPED_READS = READS.filter((r) => r.dtoNames.length > 0);

/**
 * Sanity floor, measured by forcing it to 99999 and reading the count the failure reports: 91 GET
 * routes discovered, **72** of which declared a response DTO on 2026-08-14. Raised 72→**73**
 * (re-measured 2026-08-15) for `GET /iterations/options`' `IterationReferenceDto` — exactly the one
 * read this change adds. (A grep for
 * `@ApiResponse` would have said 66 — it misses `@ApiPagedResponse`, which records the model under
 * `swagger/apiExtraModels` instead. That is why the number is measured and not counted by hand.) MAY ONLY RISE — a route that stops declaring its response type drops out
 * of this contract silently, which is the failure mode a floor exists to catch.
 */
const MIN_TYPED_READS = 73;

/**
 * Every designated administration field this read returns. One function so the violation sweep and
 * the reference-feed guard below cannot drift apart — they are the same question asked of different
 * route sets.
 */
function adminFieldsOn(route: RouteSchema): string[] {
  return [
    ...ALWAYS_ADMIN_FIELDS.filter((f) => route.fields.has(f)),
    ...(isPlanningRecordSchema(route.fields)
      ? RECORD_ADMIN_FIELDS.filter((f) => route.fields.has(f))
      : []),
    ...(isPersonSchema(route.fields) ? PERSON_ADMIN_FIELDS.filter((f) => route.fields.has(f)) : []),
  ];
}

/** Can a per-project Editor reach this read at the GUARD? An absent code means yes — the guard allows. */
function reachableByEditor(route: RouteSchema): boolean {
  if (route.code === undefined) return true;
  return permissionGrants([...ACCESS_LEVEL_PERMISSIONS.editor], route.code);
}

describe('a read that returns an administration field is not reachable by a participant', () => {
  it('finds the typed read surface it claims to sweep', () => {
    expect(READS.length, 'GET routes discovered').toBeGreaterThan(50);
    expect(
      TYPED_READS.length,
      `only ${TYPED_READS.length} GET routes declare a response DTO (floor ${MIN_TYPED_READS}). A ` +
        `read that declares no @ApiResponse type is invisible to this contract, so this number ` +
        `falling means coverage was lost, not that the surface shrank.`,
    ).toBeGreaterThanOrEqual(MIN_TYPED_READS);
  });

  it('never returns an administration field to a code a project Editor holds', () => {
    const violations: Record<string, string> = {};

    for (const route of TYPED_READS) {
      if (!reachableByEditor(route)) continue;
      const offending = adminFieldsOn(route);
      if (offending.length === 0) continue;
      violations[route.key] =
        `${route.dtoNames.join('+')} exposes ${offending.join(', ')} under ` +
        `${route.code ?? 'NO permission code'}`;
    }

    const found = Object.keys(violations).sort();
    const allowed = new Set([
      ...Object.keys(READ_AUDIENCE_EXCEPTIONS),
      ...Object.keys(READ_AUDIENCE_GAPS),
    ]);

    const appeared = found.filter((key) => !allowed.has(key));
    expect(
      appeared.length,
      `${appeared.length} read(s) return an administration field to a participant:\n` +
        appeared.map((key) => `  ${key}\n      ${violations[key]}`).join('\n') +
        `\n\nTHE RULE: an endpoint that carries a field a participant may not see is ` +
        `ADMINISTRATIVE, and it must not be the only feed for a picker. Split it — a REFERENCE ` +
        `projection (id, key, display name, and what a picker orders by) on the parent's own view ` +
        `permission, as a SEPARATE schema and a separate query, plus the administrative one behind ` +
        `its own code. That is what GET /projects/:id/member-options, ` +
        `GET /workspaces/:id/member-options, GET /releases/options and GET /milestones/options are. ` +
        `Do NOT declare the reference schema as a .pick() of the administrative one: a shared base ` +
        `is how the next field added for User Management joins the feed everyone reads.\n\n` +
        `Do not add to READ_AUDIENCE_GAPS to silence this.`,
    ).toBe(0);

    const stale = [...allowed].filter((key) => !found.includes(key)).sort();
    expect(
      stale.length,
      `${stale.length} READ_AUDIENCE_EXCEPTIONS / _GAPS entr(ies) no longer describe the code:\n  ` +
        stale.join('\n  ') +
        `\n\nEither the payload was split (delete the entry — that is the fix landing) or the route ` +
        `was renamed. A stale exemption is how a ratchet stops measuring anything.`,
    ).toBe(0);
  });

  it('keeps every reference feed READABLE by a project Editor, in the other direction', () => {
    /**
     * The assertion that stops the cure being worse than the disease. Splitting a feed and then
     * gating the reference half too is indistinguishable, from a payload sweep, from never having
     * split it — the picker is empty either way, and the SPA renders empty as "there are none".
     *
     * Every one of these is a feed whose ONLY job is to populate a picker or resolve a display name
     * on a screen §3.2 grants an Editor.
     */
    const referenceFeeds = [
      'ProjectsController.listProjectMemberOptions',
      'ReleasesController.listReleaseOptions',
      'MilestonesController.listMilestoneOptions',
      'IterationsController.getAssignmentOptions',
      'IterationsController.listIterationReferences',
      'ProjectsController.listLabels',
      'ProjectsController.listStatuses',
    ];

    const refused = referenceFeeds
      .map((key) => {
        const route = READS.find((r) => r.key === key);
        expect(route, `${key} is not a GET route — the reference feed list is stale`).toBeTruthy();
        return route!;
      })
      .filter((route) => !reachableByEditor(route))
      .map((route) => `  ${route.key} is gated on ${route.code}, which an Editor does not hold`);

    expect(
      refused.length,
      `${refused.length} reference feed(s) are unreachable by a project Editor:\n` +
        refused.join('\n') +
        `\n\nThis is the defect from the other side, and it is the one that shipped: the gate is ` +
        `defensible in isolation and the picker is empty. A test that only proves the ` +
        `administrative feed is refused passes just as well when you over-restrict.`,
    ).toBe(0);

    // And the reference feeds must stay REFERENCE — a field added to one is how the split unwinds.
    for (const key of referenceFeeds) {
      const route = READS.find((r) => r.key === key)!;
      const leaked = adminFieldsOn(route);
      expect(leaked, `${key} (${route.dtoNames.join('+')}) grew an administration field`).toEqual(
        [],
      );
    }
  });
});
