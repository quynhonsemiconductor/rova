/**
 * Centralised Drizzle pgEnum definitions for every enum-like column in the
 * database.  Each enum is declared once here and imported by the schema table
 * files.  TypeScript union types are derived directly from the enum values so
 * domain types never drift from the database definition.
 *
 * Naming convention: <context>_<field>_enum  → pgEnum('<context>_<field>', [...])
 */
import { pgEnum } from 'drizzle-orm/pg-core';
import { sql, type SQL } from 'drizzle-orm';

// ── identity ───────────────────────────────────────────────────────────────

export const userStatusEnum = pgEnum('user_status', ['invited', 'active', 'inactive', 'suspended']);

/** External SSO/IdP providers supported for federated login. */
export const ssoProviderEnum = pgEnum('sso_provider', ['entra', 'saml', 'google', 'okta']);

/** Lifecycle state of an SSO connection. */
export const ssoConnectionStatusEnum = pgEnum('sso_connection_status', ['active', 'disabled']);

/**
 * Multi-IdP broker routing model. `directory` connections OWN their email
 * domains (domain-routed, JIT-by-domain); `shared` connections are consumer
 * IdPs we don't own (e.g. consumer Google) — never domain-routed, invite-gated.
 */
export const ssoConnectionKindEnum = pgEnum('sso_connection_kind', ['directory', 'shared']);

// ── workspace ──────────────────────────────────────────────────────────────

export const workspaceStatusEnum = pgEnum('workspace_status', ['active', 'archived']);

export const workspaceMemberStatusEnum = pgEnum('workspace_member_status', [
  'active',
  'suspended',
  'removed',
]);

export const invitationStatusEnum = pgEnum('invitation_status', [
  'pending',
  'accepted',
  'cancelled',
  'expired',
]);

export const teamStatusEnum = pgEnum('team_status', ['active', 'archived']);

export const teamMemberStatusEnum = pgEnum('team_member_status', ['active', 'removed']);

// ── access ─────────────────────────────────────────────────────────────────

export const scopeTypeEnum = pgEnum('scope_type', ['global', 'workspace', 'project']);

// ── work ───────────────────────────────────────────────────────────────────

export const projectStatusEnum = pgEnum('project_status', ['active', 'archived']);

export const projectMemberStatusEnum = pgEnum('project_member_status', ['active', 'removed']);

export const projectTeamStatusEnum = pgEnum('project_team_status', ['active', 'unlinked']);

// `initiative` and `feature` were removed in migration 0072. A Feature is a
// PORTFOLIO ITEM (work.portfolio_items), not a schedulable work item — Rally keeps
// PortfolioItem and HierarchicalRequirement as separate object families joined by a
// field, and the BA spec gives a Feature an 11-value portfolio state, its own
// estimates and rollups FROM linked stories. Keeping the value meant two tables both
// minting `FE-` keys and both meaning Feature.
//
// `task` stays: tasks live in work.tasks (P3 refactor) but the repository still
// projects a task into a WorkItem shape with type 'task' for service compatibility
// (`mapTaskRow`), so the value is load-bearing even though nothing inserts one here.
export const workItemTypeEnum = pgEnum('work_item_type', ['story', 'task', 'defect']);

// Defect priority (Rally vocabulary). Story items carry 'none' (UI shows —).
// Migration 0011 remaps legacy critical→urgent, medium→normal.
export const workItemPriorityEnum = pgEnum('work_item_priority', [
  'none',
  'low',
  'normal',
  'high',
  'urgent',
]);

// Rally-style ScheduleState: orthogonal business-maturity dimension, separate
// from the per-project workflow engine (status_id → workflow_statuses).
// Aligned to BA flow-state vocabulary (mini-rally): 6 states, no 'ready',
// terminal state spelled 'release'. Migration 0041 backfills 'ready'→'defined'
// and renames 'released'→'release'.
export const workItemScheduleStateEnum = pgEnum('work_item_schedule_state', [
  'idea',
  'defined',
  'in_progress',
  'completed',
  'accepted',
  'release',
]);

export const workflowStatusCategoryEnum = pgEnum('workflow_status_category', [
  'to_do',
  'in_progress',
  'done',
]);

// Rally Iteration State — a planning-maturity dimension on the timebox itself:
// Planning (being shaped) → Committed (team committed) → Accepted (completed).
export const iterationStateEnum = pgEnum('iteration_state', ['planning', 'committed', 'accepted']);

export const releaseStatusEnum = pgEnum('release_status', ['planning', 'active', 'accepted']);

export const attachmentStatusEnum = pgEnum('attachment_status', ['pending', 'completed']);

// ── storage ────────────────────────────────────────────────────────────────

/**
 * Lifecycle of a storage.files row. `pending` means presigned but not yet
 * confirmed — the object may or may not exist in the bucket. `completed` means
 * the upload was verified (size + checksum) against the bucket.
 */
export const fileStatusEnum = pgEnum('file_status', ['pending', 'completed']);

/**
 * Which bucket a file lives in. `private` objects are only ever reachable via a
 * short-lived presigned GET minted after an authorization check. `public`
 * objects live in the CDN-fronted bucket and are readable by anyone holding the
 * key — only ever for non-sensitive assets (avatars, workspace logos).
 */
export const fileVisibilityEnum = pgEnum('file_visibility', ['private', 'public']);

export const activityEntityTypeEnum = pgEnum('activity_entity_type', [
  'work_item',
  'task',
  'attachment',
  'iteration',
  'project',
  'milestone',
  'release',
  // Epics and Features. Added by 0079 — `activity_logs` was already polymorphic, so a new
  // Revision History subject costs one enum member and nothing else.
  'portfolio_item',
  // Phase 7 (migration 0129). Activity-only widening — this enum has no spillover into
  // comments/attachments/milestone_artifacts, unlike `entityRefTypeEnum` below.
  'test_case',
  'test_result',
]);

/**
 * What a child record hangs off — comments today, attachments / labels / watchers as they
 * follow (0082).
 *
 * Deliberately NOT `activityEntityTypeEnum`, which answers a different question: activity
 * is logged against tasks and attachments too, and neither of those can own a comment.
 * This enum lists exactly the things that CAN own child records.
 */
/**
 * Widened by migration 0129 (Phase 7) to `test_case` / `test_result`, so this enum now also
 * decides comments' and milestone_artifacts' vocabulary — WIDENING IT IS NOT NEUTRAL.
 * `CollaborationService` must refuse comments on both new members until the BA asks for
 * them (SRS is silent — plan §2.6/C7); attachments get one new `UploadPolicy` descriptor
 * per owner instead of an implicit yes.
 */
export const entityRefTypeEnum = pgEnum('entity_ref_type', [
  'work_item',
  'portfolio_item',
  'test_case',
  'test_result',
]);

// ── messaging ──────────────────────────────────────────────────────────────

export const outboxStatusEnum = pgEnum('outbox_status', ['pending', 'published', 'failed']);

/**
 * Status for rows in messaging.email_outbox.
 *
 * `sent` means ACCEPTED BY THE PROVIDER, not delivered — SES takes the message and
 * answers 200 before the receiving mail server has said anything. `bounced` and
 * `complained` are the provider's asynchronous verdicts arriving later over the
 * feedback loop (SES configuration-set events drained by BounceFeedbackService):
 * `bounced` = the receiving server rejected it (bad mailbox, spam-policy refusal,
 * quarantine-as-bounce), `complained` = the recipient marked it spam. They are
 * terminal overlays on a row already `sent` — the send happened, this is what came
 * back — which is why the relay never sets them and the feedback consumer always does.
 */
export const emailJobStatusEnum = pgEnum('email_job_status', [
  'pending',
  'sent',
  'failed',
  'bounced',
  'complained',
]);

/** Status for rows in messaging.notification_outbox. */
export const notificationJobStatusEnum = pgEnum('notification_job_status', [
  'pending',
  'sent',
  'failed',
]);

/**
 * Status for rows in messaging.guest_invite_outbox (migration 0123).
 *
 * Its own type rather than borrowing `email_job_status`: the values coincide today, and a queue
 * that has to add a state must be able to without moving another queue's type with it.
 */
export const guestInviteJobStatusEnum = pgEnum('guest_invite_job_status', [
  'pending',
  'sent',
  'failed',
]);

// ── scm (source-control connections) ─────────────────────────────────────────

/** SCM host. Provider-tagged for future SCMs (GitLab/Bitbucket). */
export const scmProviderEnum = pgEnum('scm_provider', ['github', 'ghe']);

/** Kind of linked connection artifact. */
export const scmConnectionTypeEnum = pgEnum('scm_connection_type', [
  'pull_request',
  'build',
  'branch',
]);

/** Status for rows in scm.webhook_inbox (mirrors the outbox relay lifecycle). */
export const scmInboxStatusEnum = pgEnum('scm_inbox_status', [
  'pending',
  'processed',
  'ignored',
  'failed',
]);

/** Status for rows in scm.backfill_jobs. */
export const scmBackfillStatusEnum = pgEnum('scm_backfill_status', ['pending', 'done', 'failed']);

// P3.4 — Defect severity (separate from priority). Aligned to BA taxonomy
// (mini-rally): tokens now equal labels (Critical / Major / Minor / Trivial /
// None). Migration 0040 renames high→major, medium→minor, low→trivial.
export const defectSeverityEnum = pgEnum('defect_severity', [
  'critical',
  'major',
  'minor',
  'trivial',
  'none',
]);

// P3.4 — Defect environment where the defect was found.
export const defectEnvironmentEnum = pgEnum('defect_environment', [
  'development',
  'staging',
  'production',
  'testing',
]);

// P3.4 — Defect root cause categories (Rally-aligned).
export const defectRootCauseEnum = pgEnum('defect_root_cause', [
  'requirements',
  'design',
  'code',
  'test',
  'integration',
  'other',
]);

// P3.4 — Defect resolution status (Rally-aligned).
export const defectResolutionEnum = pgEnum('defect_resolution', [
  'fixed',
  'wont_fix',
  'duplicate',
  'cannot_reproduce',
  'deferred',
  'by_design',
]);

// P3.4 — Defect State (separate from Flow State / Schedule State)
export const defectStateEnum = pgEnum('defect_state', [
  'submitted',
  'open',
  'fixed',
  'closed',
  'closed_declined',
]);

// Task schedule state (subset for task table)
export const taskStateEnum = pgEnum('task_state', ['defined', 'in_progress', 'completed']);

// F6 — Work-item relation types (BA linking set). Stored on the canonical
// (source → target) direction; the inverse label is derived in the app layer.
export const workItemRelationTypeEnum = pgEnum('work_item_relation_type', [
  'blocks',
  'duplicates',
  'relates_to',
  'depends_on',
]);

// P3.3 — Milestone states aligned with BA spec.
export const milestoneStatusEnum = pgEnum('milestone_status', [
  'planned',
  'at_risk',
  'met',
  'missed',
  'cancelled',
  'completed',
]);

// ── P5 Portfolio ──────────────────────────────────────────────────────────
//
// Epic and Feature share ONE table (`work.portfolio_items`) discriminated by
// this type, because the BA spec gives them one list, one state enum, one create
// template, one rank column and one archive rule. Their only differences are
// three nullable columns (parent/team/release) and which rollup applies — see the
// CHECK constraints on the table. Rally models every portfolio item type in one
// collection too, so this also matches the reference product.
//
// Mini Rally's `epic` is Rally's `Initiative` level, renamed by BA decision
// 2026-07-28. Rally's own hierarchy is Feature → Initiative → Theme and has no
// "Epic"; keep that mapping in mind before aligning anything with Rally docs.
export const portfolioItemTypeEnum = pgEnum('portfolio_item_type', ['epic', 'feature']);

// Portfolio Item State — 11 values, BA-confirmed (Portfolio Items SRS §7).
//
// Deliberately NOT `workItemScheduleStateEnum`. A portfolio item's lifecycle is a
// funnel (intake → discovery → prioritisation → developing → measuring), while a
// story's is a delivery flow. Rally likewise defines portfolio state per item type
// at workspace level, separately from schedule state. Conflating the two is the
// same class of mistake the D1/D2 note above warns about.
export const portfolioItemStateEnum = pgEnum('portfolio_item_state', [
  'no_entry',
  'intake',
  'idea_prioritization',
  'problem_discovery',
  'solution_discovery',
  'feature_prioritization',
  'developing',
  'accepted',
  'measuring',
  'done',
  'cancelled',
]);

// Top-down t-shirt sizing on a portfolio item (Rally's `PreliminaryEstimate`).
//
// The size→points/count MAPPING is NOT here: it is per-project configuration
// (`work.project_settings`, SRS §6.2), because the BA spec
// calls the mockup's XS=1/S=3/M=5/L=8/XL=13 table "temporary mockup data" and
// defers the real values to Settings > Workspace > Project Management. Rally also
// makes it a workspace-admin setting. Hard-coding it here would turn that later
// slice into a data migration plus a silent behaviour change.
export const preliminaryEstimateSizeEnum = pgEnum('preliminary_estimate_size', [
  'no_entry',
  'xs',
  's',
  'm',
  'l',
  'xl',
]);

// Capacity plan lifecycle. `published` is read-only; Revert to Draft returns to
// `draft` but does NOT roll back fields a publish already wrote to Features.
export const capacityPlanStatusEnum = pgEnum('capacity_plan_status', ['draft', 'published']);

// Unit a capacity plan is planned in, chosen at creation and FIXED afterwards
// ("View Work Items By" — Capacity Planning SRS §5). Every metric on the plan —
// Complete, Rollup, Estimated, Capacity and each allocation value — is expressed
// in this unit, which is why it cannot change once demand has been committed.
// Matches Rally, where the same choice is made when the plan is created.
export const capacityPlanUnitEnum = pgEnum('capacity_plan_unit', ['points', 'count']);

/**
 * Where an allocation row's committed value CAME FROM (Capacity SRS §185-186).
 *
 * `feature_estimate` — the planner left Estimate blank, so the Feature's top-down estimate
 * (Refined, else the Preliminary size mapping) was copied into the row at that moment.
 * `manual` — the planner typed the number.
 *
 * The label is why the value can be a fixed snapshot at all. Migration 0077 had made `value`
 * nullable so a blank row could resolve on read, precisely because "a defaulted 8 and a
 * deliberate 8 were indistinguishable" — this column is the distinction, which lets the value
 * be stored (§11: `fixed allocation.value set during planning/replanning`) without losing it.
 */
export const capacityAllocationSourceEnum = pgEnum('capacity_allocation_source', [
  'feature_estimate',
  'manual',
]);

// ── P7 Test Case & Test Result ────────────────────────────────────────────

export const testCaseMethodEnum = pgEnum('test_case_method', ['manual', 'automated']);

export const testCasePriorityEnum = pgEnum('test_case_priority', [
  'low',
  'normal',
  'high',
  'urgent',
]);

/**
 * Shared by `test_cases.last_verdict` AND `test_results.verdict`, but `not_run` is valid
 * on the FORMER only — a Result records an outcome, never its absence (Phase 7 plan D6).
 * `test_results.verdict` excludes it via a CHECK constraint (migration 0129), not by a
 * second enum, so the two audiences of one vocabulary cannot silently drift apart.
 */
export const testVerdictEnum = pgEnum('test_verdict', [
  'pass',
  'fail',
  'blocked',
  'error',
  'inconclusive',
  'not_run',
]);

// ── TypeScript types (derived — never drift from DB) ──────────────────────

export type UserStatus = (typeof userStatusEnum.enumValues)[number];
export type WorkspaceStatus = (typeof workspaceStatusEnum.enumValues)[number];
export type WorkspaceMemberStatus = (typeof workspaceMemberStatusEnum.enumValues)[number];
export type InvitationStatus = (typeof invitationStatusEnum.enumValues)[number];
export type TeamStatus = (typeof teamStatusEnum.enumValues)[number];
export type TeamMemberStatus = (typeof teamMemberStatusEnum.enumValues)[number];
export type ScopeType = (typeof scopeTypeEnum.enumValues)[number];
export type ProjectStatus = (typeof projectStatusEnum.enumValues)[number];
export type ProjectMemberStatus = (typeof projectMemberStatusEnum.enumValues)[number];
export type ProjectTeamStatus = (typeof projectTeamStatusEnum.enumValues)[number];
export type WorkItemType = (typeof workItemTypeEnum.enumValues)[number];
export type WorkItemPriority = (typeof workItemPriorityEnum.enumValues)[number];
export type WorkItemScheduleState = (typeof workItemScheduleStateEnum.enumValues)[number];
export type WorkflowStatusCategory = (typeof workflowStatusCategoryEnum.enumValues)[number];
export type IterationState = (typeof iterationStateEnum.enumValues)[number];
export type ReleaseStatus = (typeof releaseStatusEnum.enumValues)[number];
export type OutboxStatus = (typeof outboxStatusEnum.enumValues)[number];
export type EmailJobStatus = (typeof emailJobStatusEnum.enumValues)[number];
export type NotificationJobStatus = (typeof notificationJobStatusEnum.enumValues)[number];
export type GuestInviteJobStatus = (typeof guestInviteJobStatusEnum.enumValues)[number];
export type ScmProvider = (typeof scmProviderEnum.enumValues)[number];
export type ScmConnectionType = (typeof scmConnectionTypeEnum.enumValues)[number];
export type ScmInboxStatus = (typeof scmInboxStatusEnum.enumValues)[number];
export type ScmBackfillStatus = (typeof scmBackfillStatusEnum.enumValues)[number];
export type MilestoneStatus = (typeof milestoneStatusEnum.enumValues)[number];
export type CapacityAllocationSource = (typeof capacityAllocationSourceEnum.enumValues)[number];
export type PortfolioItemType = (typeof portfolioItemTypeEnum.enumValues)[number];
export type PortfolioItemState = (typeof portfolioItemStateEnum.enumValues)[number];
export type PreliminaryEstimateSize = (typeof preliminaryEstimateSizeEnum.enumValues)[number];
export type CapacityPlanStatus = (typeof capacityPlanStatusEnum.enumValues)[number];
export type CapacityPlanUnit = (typeof capacityPlanUnitEnum.enumValues)[number];
export type DefectSeverity = (typeof defectSeverityEnum.enumValues)[number];
export type DefectEnvironment = (typeof defectEnvironmentEnum.enumValues)[number];
export type DefectRootCause = (typeof defectRootCauseEnum.enumValues)[number];
export type DefectResolution = (typeof defectResolutionEnum.enumValues)[number];
export type DefectState = (typeof defectStateEnum.enumValues)[number];
export type TaskState = (typeof taskStateEnum.enumValues)[number];
export type WorkItemRelationType = (typeof workItemRelationTypeEnum.enumValues)[number];
export type TestCaseMethod = (typeof testCaseMethodEnum.enumValues)[number];
export type TestCasePriority = (typeof testCasePriorityEnum.enumValues)[number];
export type TestVerdict = (typeof testVerdictEnum.enumValues)[number];

// ── Semantic groupings (single source of truth for roll-up / progress logic) ──
// Used by reporting, releases, milestones, quality and iteration-status so the
// definition of "done" / "accepted" / "open" lives in exactly one place.
//
// THREE ORTHOGONAL "DONE" DIMENSIONS — do NOT conflate them (BA source of truth:
// product-docs/projects/mini-rally). Each metric MUST use the dimension its
// spec names, and callers MUST reuse the helpers below rather than inline a
// string literal:
//
//   D1 — work_items.schedule_state  (business readiness / acceptance)
//        idea → defined → in_progress → completed → accepted → release
//        • "Accepted" metric  = ACCEPTED_SCHEDULE_STATES  (accepted OR release)
//        • "Completed" roll-up = COMPLETED_SCHEDULE_STATES (completed/accepted/release)
//        Drives: iteration-status Accepted %/points, release & milestone
//        progress, portfolio acceptance, iteration accept-gate & auto-accept.
//        Ref: Phase 2/03 Iteration Status SRS — "Accepted means Schedule State
//        equals Accepted, unless backend has a final accepted status mapping"
//        (that mapping is ACCEPTED_SCHEDULE_STATES — release is post-acceptance).
//
//   D2 — workflow_statuses.category  (kanban board column: to_do/in_progress/done)
//        • "board + burndown 'done'" — Ref: 05_Architecture/DATABASE_SCHEMA.md
//          (workflow_statuses.category "drives board grouping + burndown done").
//        Drives: sprint burndown/velocity snapshots, board columns, Home
//        project-progress. Use WORKFLOW_DONE_CATEGORY / isWorkflowDoneCategory.
//        NOTE: D2 is intentionally NOT the same as D1 acceptance — a board-done
//        item may not yet be business-accepted, and vice-versa.
//
//   D3 — tasks.state  (execution sub-state: defined/in_progress/completed)
//        Task terminal is `completed`; a parent US/DE auto-completes only when
//        every child task is `completed`, and is NEVER auto-reverted from a more
//        mature D1 terminal (Ref: BA-alignment F3 + Phase 3 P3-TS-009).

/** Schedule states that count as completed for progress & velocity roll-ups. */
export const COMPLETED_SCHEDULE_STATES = [
  'completed',
  'accepted',
  'release',
] as const satisfies readonly WorkItemScheduleState[];

/** Schedule states that count as accepted (a work item the team has signed off). */
export const ACCEPTED_SCHEDULE_STATES = [
  'accepted',
  'release',
] as const satisfies readonly WorkItemScheduleState[];

/** Schedule states that are still open / in-flight (not yet completed). */
export const OPEN_SCHEDULE_STATES = [
  'idea',
  'defined',
  'in_progress',
] as const satisfies readonly WorkItemScheduleState[];

/**
 * Points/count a Preliminary Estimate size stands for, per workspace.
 *
 * WHICH DIMENSION APPLIES WHERE — both are used, and by different surfaces:
 *   • `points` — Estimated Progress by Story Points, and a `points` capacity plan
 *   • `count`  — Estimated Progress by Story Count, and a `count` capacity plan
 * A capacity plan reads exactly one of them, fixed by `capacity_plans.unit`.
 */
export interface PreliminaryEstimateEntry {
  points: number;
  count: number;
}

export type PreliminaryEstimateMap = Record<PreliminaryEstimateSize, PreliminaryEstimateEntry>;

/**
 * SEED DEFAULT ONLY — not a product rule.
 *
 * The BA spec calls these values "temporary mockup data" and defers the real scale
 * to `Settings > Workspace > Project Management`; Rally makes the equivalent mapping
 * a workspace-admin setting. They are the DEFAULT for a new project row, and every
 * read must go through `work.project_settings` (per-project, SRS §6.2) so an operator's
 * change is honoured. Do not import this constant to compute an estimate.
 */
export const DEFAULT_PRELIMINARY_ESTIMATE_MAP: PreliminaryEstimateMap = {
  /**
   * The unsized state, and the one entry with NO Rally counterpart.
   *
   * Rally's Preliminary Estimate has no "None" option and no zero-valued size — each size
   * must carry a name and a whole-number value, and Rally expresses "not sized" by leaving
   * the FIELD unset. Our column is a NOT NULL enum, so the absent state has to be a member,
   * and it maps to 0.
   *
   * That 0 is safe precisely because 0 is not a forecast anywhere in the domain: it falls
   * through the tier chain to nothing (`forecastTarget` / `resolveEstimate` both require
   * `> 0`), so an unsized item shows a BLANK Estimated Progress meter rather than 0%. It is
   * also why this is the only 0 in the table — a real size with value 0 would be silently
   * ignored.
   */
  no_entry: { points: 0, count: 0 },
  // XS=1 / S=3 / M=5 / L=8 / XL=13 is the BA's table
  // (`04_Developement_tracking/Phase 5/01_Portfolio_Items/SRS.md:170-177`), which that doc
  // itself calls temporary mockup data pending Settings > Workspace > Project Management.
  //
  // DELIBERATE DIVERGENCE FROM RALLY — do not "correct" these back.
  // Rally ships XS=13 / S=20 / M=40 / L=100 / XL=250, unitless, one number per size:
  // https://techdocs.broadcom.com/us/en/ca-enterprise-software/valueops/rally/rally-help/administration/managing-your-workspace/customizing-portfolio-item-types/customizing-fields-for-portfolio-item-types/customizing-the-portfolio-item-preliminary-estimate-field.html
  // An earlier version of this comment cited Broadcom KB 94797 as proof that 1/3/5/8/13
  // "matches Rally's documented defaults exactly". The KB does say that, but it is undated,
  // describes the retired Plan Progression page, and uses the values in a worked example —
  // the version-selectable product doc above supersedes it.
  //
  // We keep the BA scale anyway, on two grounds: Rally makes this a per-workspace admin
  // setting with no cross-workspace guarantee, so any seed value is legal; and the approved
  // mockups were designed against these numbers. Rally has no `count` dimension at all —
  // that half is ours.
  //
  // Re-scaling is NOT a constant edit. `db/migrations/0101_capacity_allocation_fixed_value.sql:66`
  // hard-codes this map as the freeze basis for existing allocation values, so changing the
  // constant alone would leave pre-0101 allocations on the old scale and new ones on the new —
  // two scales inside one plan total. Adopting Rally's scale needs its own re-basing migration.
  // Decided 2026-08-04. See 09_Gap_Audit/PHASE_5_6_DECISION_MATRIX.md#0-B
  xs: { points: 1, count: 1 },
  s: { points: 3, count: 2 },
  m: { points: 5, count: 3 },
  l: { points: 8, count: 5 },
  xl: { points: 13, count: 8 },
};

/**
 * Defect "open" states for the Quality dashboard — intentionally NARROWER than
 * OPEN_SCHEDULE_STATES: a defect in `idea` is not yet an actionable open defect,
 * so backlog `idea` is excluded (BA Quality rule). Kept here next to the other
 * groupings so the two "open" definitions can never silently drift apart.
 */
export const OPEN_DEFECT_SCHEDULE_STATES = [
  'defined',
  'in_progress',
] as const satisfies readonly WorkItemScheduleState[];

/** D2 workflow-board category that counts as "done" for board + burndown/velocity. */
export const WORKFLOW_DONE_CATEGORY = 'done' as const satisfies WorkflowStatusCategory;

/** Type guard: is this schedule state counted as completed for roll-ups? */
export const isCompletedScheduleState = (s: WorkItemScheduleState): boolean =>
  (COMPLETED_SCHEDULE_STATES as readonly WorkItemScheduleState[]).includes(s);

/** Type guard: is this schedule state counted as accepted? */
export const isAcceptedScheduleState = (s: WorkItemScheduleState): boolean =>
  (ACCEPTED_SCHEDULE_STATES as readonly WorkItemScheduleState[]).includes(s);

/** Type guard: is this schedule state an actionable open defect (excludes `idea`)? */
export const isOpenDefectScheduleState = (s: WorkItemScheduleState): boolean =>
  (OPEN_DEFECT_SCHEDULE_STATES as readonly WorkItemScheduleState[]).includes(s);

/** Type guard: does this workflow-status category count as board/burndown "done"? */
export const isWorkflowDoneCategory = (c: WorkflowStatusCategory): boolean =>
  c === WORKFLOW_DONE_CATEGORY;

// SQL fragment factories — inline the grouping into a raw `sql` IN (...) list so
// aggregate/FILTER queries share the exact same definition of "done"/"accepted".
// Factories (not shared instances) so each call yields a fresh, safely-bound chunk.
const toSqlList = (values: readonly string[]): SQL =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );

/** `'completed', 'accepted', 'release'` bound for use inside `schedule_state IN (...)`. */
export const completedScheduleStatesSql = (): SQL => toSqlList(COMPLETED_SCHEDULE_STATES);

/** `'accepted', 'release'` bound for use inside `schedule_state IN (...)`. */
export const acceptedScheduleStatesSql = (): SQL => toSqlList(ACCEPTED_SCHEDULE_STATES);
