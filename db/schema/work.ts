/**
 * work schema — projects, work_items, workflow_statuses, workflow_transitions,
 *               iterations, releases, project_counters, iteration_daily_snapshots,
 *               comments, attachments, custom_field_defs,
 *               time_logs, work_item_watchers
 * Canonical DDL: 05_Architecture/DATABASE_SCHEMA.md §9
 */
import {
  pgSchema,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  numeric,
  timestamp,
  date,
  jsonb,
  index,
  uniqueIndex,
  check,
  primaryKey,
  customType,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// tsvector is not a built-in Drizzle column type — define it so the ORM can
// reference the generated column in WHERE clauses (schema-level read-only).
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });
import {
  projectStatusEnum,
  projectMemberStatusEnum,
  projectTeamStatusEnum,
  workItemTypeEnum,
  workItemPriorityEnum,
  workItemScheduleStateEnum,
  workflowStatusCategoryEnum,
  iterationStateEnum,
  releaseStatusEnum,
  teamStatusEnum,
  teamMemberStatusEnum,
  activityEntityTypeEnum,
  milestoneStatusEnum,
  defectSeverityEnum,
  defectEnvironmentEnum,
  defectRootCauseEnum,
  defectResolutionEnum,
  defectStateEnum,
  taskStateEnum,
  workItemRelationTypeEnum,
  portfolioItemTypeEnum,
  portfolioItemStateEnum,
  preliminaryEstimateSizeEnum,
  entityRefTypeEnum,
  capacityPlanStatusEnum,
  capacityPlanUnitEnum,
  capacityAllocationSourceEnum,
  testCaseMethodEnum,
  testCasePriorityEnum,
  testVerdictEnum,
} from './enums';
import { files } from './storage';

export const workSchema = pgSchema('work');

// ── projects ──────────────────────────────────────────────────────────────

export const projects = workSchema.table(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    key: varchar('key', { length: 10 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    leadId: uuid('lead_id'),
    startDate: date('start_date'),
    endDate: date('end_date'),
    status: projectStatusEnum('status').notNull().default('active'),
    settings: jsonb('settings').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    workspaceIdx: index('ix_projects_workspace').on(t.workspaceId),
    keyIdx: uniqueIndex('uq_projects_workspace_key')
      .on(t.workspaceId, t.key)
      .where(sql`deleted_at IS NULL`),
  }),
);

// ── workspace_item_counters (item_key seq) ─────────────────────────────────
// Per-WORKSPACE, per-type sequential counter (Rally FormattedID model): a
// work-item key like US-42 is unique across the whole workspace, not per
// project. Composite PK (workspaceId, itemType) gives each type its own
// workspace-wide sequence (US-*, DE-*, TA-* …).

export const workspaceItemCounters = workSchema.table(
  'workspace_item_counters',
  {
    workspaceId: uuid('workspace_id').notNull(),
    itemType: workItemTypeEnum('item_type').notNull().default('story'),
    lastItemNumber: integer('last_item_number').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [{ pk: primaryKey({ columns: [table.workspaceId, table.itemType] }) }],
);

// ── work_items ────────────────────────────────────────────────────────────

export const workItems = workSchema.table(
  'work_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    itemKey: varchar('item_key', { length: 30 }).notNull(),
    type: workItemTypeEnum('type').notNull(),
    title: varchar('title', { length: 500 }).notNull(),
    description: text('description'),
    // Kanban board column (Future Team Board). NOT the BA "Flow State" — that is
    // the flowState column below. Retained for the project-configurable board.
    statusId: uuid('status_id').notNull(),
    // BR-WI-01 — Schedule State and Flow State share the same six values and
    // MIRROR bidirectionally. Both are business-maturity dimensions; the mirror
    // is enforced centrally in the work-item repository write path so they can
    // never drift. Flow State reuses the schedule-state enum (identical catalog).
    scheduleState: workItemScheduleStateEnum('schedule_state').notNull().default('defined'),
    flowState: workItemScheduleStateEnum('flow_state').notNull().default('defined'),
    priority: workItemPriorityEnum('priority').notNull().default('none'),
    assigneeId: uuid('assignee_id'),
    reporterId: uuid('reporter_id'),
    parentId: uuid('parent_id'),
    teamId: uuid('team_id'),
    /**
     * Scheduling links, both `ON DELETE SET NULL` (migration 0114).
     *
     * Deleting a timebox UNSCHEDULES its work rather than orphaning it — Rally: "If you delete an
     * iteration that stories and defects are scheduled in, they will all be updated to unscheduled."
     * Neither column had a key until 0114, and the three delete services are bare `repo.delete(id)`,
     * so every scheduled item was left pointing at a row that no longer existed.
     *
     * The rule lives here rather than in the services because `db/seeds/**` and raw SQL write this
     * table directly — the same reason `trg_sync_accepted_date` and `timebox_group_id` are triggers.
     */
    iterationId: uuid('iteration_id').references(() => iterations.id, { onDelete: 'set null' }),
    releaseId: uuid('release_id').references(() => releases.id, { onDelete: 'set null' }),
    // Link to a portfolio item of type 'feature' (P5.1). Nullable — most work items
    // belong to no Feature, and the Backlog must keep working unchanged.
    //
    // Stories and Defects only; a Task is linked through its parent, never directly.
    // Postgres cannot FK to a filtered subset of a table, so "must be a feature, not
    // an epic" is asserted in the portfolio service on write. Every Percent Done and
    // Capacity metric aggregates over this column, hence the index.
    featureId: uuid('feature_id'),
    // Plan Estimate. numeric(6,2) allows fractional points (e.g. 0.5) per SRS §8;
    // Drizzle returns numeric as a string to preserve precision.
    storyPoints: numeric('story_points', { precision: 6, scale: 2 }),
    // NO hours columns here. A Story/Defect's Estimate/To Do/Actual are DERIVED by
    // summing its child `tasks` rows (migration 0074), which is where the real
    // per-task inputs live. Iteration Status already read them that way, so storing
    // them here as well let two surfaces disagree about the same story — and in
    // practice every stored value was NULL.
    // The timestamp that established the item's CURRENT Accepted outcome (Phase 6
    // Velocity SRS §8). Set on entering `accepted`, retained through `release`,
    // cleared on reopen, set again on re-acceptance — enforced by the
    // `trg_sync_accepted_date` trigger (migration 0087) so seeds and raw SQL cannot
    // produce an Accepted row without one. `activity_logs` keeps every transition;
    // this column is only ever the current outcome.
    //
    // NULL while accepted is a data-quality error, not "accepted at an unknown time":
    // the reports report it rather than guessing During vs After.
    acceptedDate: timestamp('accepted_date', { withTimezone: true }),
    acceptanceCriteria: text('acceptance_criteria'),
    // Dedicated rich-text fields (sanitized server-side), distinct from comments.
    notes: text('notes'),
    releaseNotes: text('release_notes'),
    devOwnerId: uuid('dev_owner_id'),
    // P3.4 — Defect-specific fields (only meaningful when type = 'defect')
    severity: defectSeverityEnum('severity'),
    foundInEnvironment: defectEnvironmentEnum('found_in_environment'),
    foundInReleaseId: uuid('found_in_release_id').references(() => releases.id, {
      onDelete: 'set null',
    }),
    // P3.4 — Root cause and resolution (only meaningful when type = 'defect')
    rootCause: defectRootCauseEnum('root_cause'),
    resolution: defectResolutionEnum('resolution'),
    defectState: defectStateEnum('defect_state'),
    fixedInBuild: varchar('fixed_in_build', { length: 255 }),
    isBlocked: boolean('is_blocked').notNull().default(false),
    blockedReason: text('blocked_reason'),
    rank: varchar('rank', { length: 255 }).notNull().default(''),
    customFields: jsonb('custom_fields').notNull().default({}),
    createdBy: uuid('created_by').notNull(),
    updatedBy: uuid('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    // GENERATED ALWAYS AS (STORED) tsvector — maintained by migration 0012.
    // Read-only from the application layer; updated by Postgres on every write.
    searchVector: tsvector('search_vector'),
  },
  (t) => ({
    workspaceIdx: index('ix_wi_workspace').on(t.workspaceId),
    projectIdx: index('ix_wi_project').on(t.projectId),
    itemKeyIdx: uniqueIndex('uq_wi_item_key').on(t.workspaceId, t.itemKey),
    boardIdx: index('ix_wi_board').on(t.workspaceId, t.projectId, t.statusId, t.rank),
    backlogIdx: index('ix_wi_backlog').on(t.workspaceId, t.projectId, t.rank),
    // Every portfolio rollup and capacity metric aggregates by feature_id. Partial:
    // the column is null for most rows, and a null-heavy full index is mostly waste.
    featureIdx: index('ix_wi_feature')
      .on(t.featureId)
      .where(sql`feature_id IS NOT NULL AND deleted_at IS NULL`),
    // Default list/pagination path: filter (workspaceId, projectId), order by createdAt,
    // excluding soft-deleted rows. Partial index keeps it lean and sort-free.
    listIdx: index('ix_wi_list')
      .on(t.workspaceId, t.projectId, t.createdAt)
      .where(sql`deleted_at IS NULL`),
    // Task-list-under-parent hot path (Tasks tab + totals aggregation).
    tasksIdx: index('ix_wi_tasks')
      .on(t.parentId, t.rank)
      .where(sql`type = 'task' AND deleted_at IS NULL`),
    assigneeIdx: index('ix_wi_assignee').on(t.workspaceId, t.assigneeId),
    parentIdx: index('ix_wi_parent').on(t.parentId),
    teamIdx: index('ix_wi_team').on(t.teamId),
    iterationIdx: index('ix_wi_iteration').on(t.iterationId),
    releaseIdx: index('ix_wi_release').on(t.releaseId),
    // Velocity groups by iteration and classifies on the timestamp; Burndown filters
    // it by date. Partial — only Story/Defect are ever classified.
    acceptedDateIdx: index('ix_wi_accepted_date')
      .on(t.iterationId, t.acceptedDate)
      .where(sql`type IN ('story', 'defect') AND deleted_at IS NULL`),
    blockedIdx: index('ix_wi_blocked')
      .on(t.workspaceId, t.isBlocked)
      .where(sql`is_blocked = true`),
    ftsIdx: index('ix_wi_fts')
      .on(t.searchVector)
      .where(sql`deleted_at IS NULL`),
  }),
);

// ── workflow_statuses ─────────────────────────────────────────────────────

export const workflowStatuses = workSchema.table(
  'workflow_statuses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    category: workflowStatusCategoryEnum('category').notNull(),
    color: varchar('color', { length: 20 }),
    position: integer('position').notNull().default(0),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('ix_ws_workspace').on(t.workspaceId),
    projectIdx: index('ix_ws_project').on(t.projectId),
  }),
);

// ── workflow_transitions ──────────────────────────────────────────────────

export const workflowTransitions = workSchema.table(
  'workflow_transitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    fromStatusId: uuid('from_status_id'), // NULL = any status
    toStatusId: uuid('to_status_id').notNull(),
    name: varchar('name', { length: 100 }),
    requiredRole: varchar('required_role', { length: 100 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('ix_wt_workspace').on(t.workspaceId),
    projectIdx: index('ix_wt_project').on(t.projectId),
  }),
);

// ── iterations (Rally timeboxes) ──────────────────────────────────────────
// A date-bounded planning timebox scoped to a project (and optionally a team).
// State follows the Rally vocabulary: planning → committed → accepted.

export const iterations = workSchema.table(
  'iterations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    teamId: uuid('team_id'),
    iterationKey: varchar('iteration_key', { length: 30 }),
    name: varchar('name', { length: 255 }).notNull(),
    // goal: short objective; theme: rich planning context/description.
    goal: text('goal'),
    theme: text('theme'),
    notes: text('notes'),
    state: iterationStateEnum('state').notNull().default('planning'),
    plannedVelocity: integer('planned_velocity'),
    startDate: date('start_date'),
    endDate: date('end_date'),
    // The stable shared timebox identity (migration 0088). Team-specific iterations
    // covering the same timebox share one group, which is how `All Teams` fuses them
    // into a single Burndown/Velocity bar. Assigned at CREATE by matching an existing
    // group for the same project and date range, and never reassigned when dates later
    // move — so replanning cannot silently split a bar in two, which is what a key
    // derived from the dates themselves would do.
    //
    // NULL for a dateless iteration: it belongs to no timebox and is excluded from
    // All Teams aggregation rather than collapsed into a shared bucket.
    timeboxGroupId: uuid('timebox_group_id'),
    // The Burndown Ideal baseline lives in `iteration_team_baselines` (0098), per team.
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('ix_iterations_workspace').on(t.workspaceId),
    projectIdx: index('ix_iterations_project').on(t.projectId),
    teamIdx: index('ix_iterations_team').on(t.teamId),
    keyIdx: uniqueIndex('uq_iterations_key').on(t.projectId, t.iterationKey),
    timeboxGroupIdx: index('ix_iterations_timebox_group').on(t.projectId, t.timeboxGroupId),
    committedIdx: index('ix_iterations_committed')
      .on(t.projectId, t.state)
      .where(sql`state = 'committed'`),
  }),
);

// ── iteration_team_baselines (burndown Ideal, per team) ───────────────────

/**
 * The Burndown Ideal baseline, one row per (iteration, team scope).
 *
 * IB §4 makes the baseline per TEAM and All Teams the SUM of the participating team baselines —
 * deliberately unlike `iteration_daily_snapshots`, where `team_id IS NULL` is a MEASURED All Teams row
 * that is never summed. Here `team_id IS NULL` means "tasks whose team resolves to nothing", so
 * summing the rows loses no hours.
 *
 * Added by migration 0098; `iterations.total_task_estimate_at_start` was one column per iteration, so a
 * team-scoped chart drew the whole project's Ideal against one team's bars.
 */
export const iterationTeamBaselines = workSchema.table(
  'iteration_team_baselines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    iterationId: uuid('iteration_id')
      .notNull()
      .references(() => iterations.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
    totalTaskEstimateAtStart: numeric('total_task_estimate_at_start', {
      precision: 10,
      scale: 2,
    }).notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // COALESCE, because a plain unique index does not constrain NULLs — the no-team row would
    // duplicate on every capture. Same shape as `uq_ids_iteration_team_date` (0093).
    uniqueScope: uniqueIndex('uq_itb_iteration_team').on(
      t.iterationId,
      sql`coalesce(${t.teamId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
    workspaceIterationIdx: index('ix_itb_workspace_iteration').on(t.workspaceId, t.iterationId),
  }),
);

// ── release_team_targets (burnup Ideal target, per team) ──────────────────

/**
 * The release Burnup Ideal target, one row per (release, team scope).
 *
 * Added by migration 0099. It was two columns on `releases`, captured only under the All Teams scope,
 * so every team's burnup was measured against the whole release's target while its Accepted line was
 * correctly narrowed — each team looked permanently behind.
 *
 * `team_id IS NULL` is the MEASURED All Teams row, exactly as in `release_daily_snapshots`, and is never
 * summed. RT §4.1 makes All Teams measured rather than summed because a Feature whose children span two
 * teams lands in BOTH teams' derived buckets, so a SUM would count it twice — and the Ideal has to be
 * measured over the same population as the Accepted series it is compared against. This is the opposite
 * of `iteration_team_baselines`, where §4 defines All Teams as the sum of the team baselines.
 *
 * Points and count share a row because `Chart Unit` is a display switch over one population.
 */
export const releaseTeamTargets = workSchema.table(
  'release_team_targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    releaseId: uuid('release_id')
      .notNull()
      .references(() => releases.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
    idealTargetPoints: numeric('ideal_target_points', { precision: 8, scale: 2 }).notNull(),
    idealTargetCount: integer('ideal_target_count').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueScope: uniqueIndex('uq_rtt_release_team').on(
      t.releaseId,
      sql`coalesce(${t.teamId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
    workspaceReleaseIdx: index('ix_rtt_workspace_release').on(t.workspaceId, t.releaseId),
  }),
);

// ── iteration_daily_snapshots (burndown / velocity read model) ────────────

export const iterationDailySnapshots = workSchema.table(
  'iteration_daily_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    iterationId: uuid('iteration_id').notNull(),
    /**
     * NULL is the ALL TEAMS row, and it is MEASURED rather than summed from the team
     * rows — a task two teams both touch must be counted once (migration 0093). Same
     * shape as `release_daily_snapshots`, for the same reason.
     */
    teamId: uuid('team_id'),
    snapshotDate: date('snapshot_date').notNull(),
    // ── Phase 6 Burndown (migration 0088) ─────────────────────────────────
    // The two series the approved chart actually plots. They are NOT the legacy
    // point columns above renamed: Remaining To Do is SUM(task.todo) in HOURS on
    // the left axis, Accepted Points is cumulative SUM(planEstimate) of items whose
    // `accepted_date` fell on or before this date, on the right axis.
    remainingTodo: numeric('remaining_todo', { precision: 10, scale: 2 }).notNull().default('0'),
    acceptedPoints: numeric('accepted_points', { precision: 8, scale: 2 }).notNull().default('0'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
    // What makes history frozen: once the workspace-local day has closed the daily job
    // stops rewriting that date, so a later task edit cannot rewrite the past. A
    // correction is an audited operational action, not an application write.
    finalized: boolean('finalized').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('ix_ids_workspace').on(t.workspaceId),
    iterationIdx: index('ix_ids_iteration').on(t.iterationId),
    // COALESCE'd into the nil UUID in SQL (migration 0093) so ON CONFLICT targets one
    // predicate and the daily job stays a single idempotent upsert for the team rows and
    // the All Teams row alike. A plain unique index over a nullable column would not
    // dedupe NULLs, and the All Teams row would double on the second tick.
    // Same COALESCE as migration 0093 creates, and for the same reason as the release table's: the
    // All Teams row carries `team_id IS NULL`, which a plain unique index would not dedupe.
    uniqueDay: uniqueIndex('uq_ids_iteration_team_date').on(
      t.iterationId,
      sql`coalesce(${t.teamId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.snapshotDate,
    ),
    // The daily job's own read: which dates do I have for this scope, and are they closed?
    dateFinalIdx: index('ix_ids_iteration_team_date_final').on(
      t.iterationId,
      t.teamId,
      t.snapshotDate,
      t.finalized,
    ),
  }),
);

// ── releases ──────────────────────────────────────────────────────────────

export const releases = workSchema.table(
  'releases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    releaseKey: varchar('release_key', { length: 30 }),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    status: releaseStatusEnum('status').notNull().default('planning'),
    startDate: date('start_date'),
    releaseDate: date('release_date'),
    plannedVelocity: integer('planned_velocity'),
    planEstimate: numeric('plan_estimate', { precision: 8, scale: 2 }),
    // Release Tracking's Ideal line baseline (RT-BR-09). The Ideal trajectory runs from
    // 0 at Release start to THIS approved target at Release end. Deliberately persisted:
    // The Burnup Ideal target lives in `release_team_targets` (0099), per team.
    version: varchar('version', { length: 100 }),
    theme: text('theme'),
    notes: text('notes'),
    releaseNotes: text('release_notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('ix_releases_workspace').on(t.workspaceId),
    projectIdx: index('ix_releases_project').on(t.projectId),
    keyIdx: uniqueIndex('uq_releases_key').on(t.projectId, t.releaseKey),
  }),
);

// ── portfolio_items (P5.1) ────────────────────────────────────────────────
//
// Epic and Feature in ONE table, discriminated by `type`. See the note on
// `portfolioItemTypeEnum` for why; the CHECK constraints in migration 0071 are
// what actually hold the two shapes apart:
//
//   epic    → parent_id, team_id, release_id are ALL null (project-level grouping)
//   feature → may carry parent_id (its Epic), team_id and release_id
//
// The checks live in the DATABASE deliberately. `db/seeds/**` writes rows without
// going through the service layer, so an invariant enforced only in a service is
// not an invariant — the same lesson as flow=schedule.
//
// No stored progress. Percent Done and the Estimated Progress indicators are
// aggregated from linked work items on read (see the portfolio module's
// repository). Rally stores its rollups and consequently ships a "Correct rollup
// discrepancy" action to repair drift; computing on read means that cannot happen.
export const portfolioItems = workSchema.table(
  'portfolio_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    // 'EP-101' / 'FE-318'. Per-project sequence, same convention as release_key.
    itemKey: varchar('item_key', { length: 30 }).notNull(),
    type: portfolioItemTypeEnum('type').notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    // The same pair `work_items` carries, so the Detail page can offer the identical
    // Notes / Release Notes editors (0080). Nullable: an empty rich-text field is absent.
    notes: text('notes'),
    releaseNotes: text('release_notes'),
    // The BA's fourth rich-text block on Feature and Epic detail (SRS §5.1, §11.4). Same
    // shape as the pair above for the same reason: an empty editor is ABSENT, not ''.
    whatSuccessLooksLike: text('what_success_looks_like'),
    state: portfolioItemStateEnum('state').notNull().default('no_entry'),
    preliminaryEstimate: preliminaryEstimateSizeEnum('preliminary_estimate')
      .notNull()
      .default('no_entry'),
    // TOP-DOWN forecasts. Feed only the two "Estimated Progress by…" indicators.
    // Deliberately not a "Plan Estimate": a portfolio item never stores the sum of
    // its children, which is what makes the rollups authoritative.
    //
    // NOT NULL DEFAULT 0, unlike every other typed estimate in this schema, and unlike
    // what the general rule below would suggest. Real Rally shows these as 0 rather than
    // blank and lets a planner type 0, so 0 — not NULL — is the absent state here (0081).
    // Nothing downstream needed changing: the tier chain already selects the refined
    // forecast only `if > 0`, so 0 falls through to the Preliminary Estimate mapping,
    // which is the same fallback NULL used to trigger. One representation of "no
    // forecast" instead of two.
    refinedEstimate: numeric('refined_estimate', { precision: 8, scale: 2 }).notNull().default('0'),
    refinedItemCountEstimate: integer('refined_item_count_estimate').notNull().default(0),
    // Feature → Epic. Null for an Epic (no deeper hierarchy: Theme is out of scope).
    parentId: uuid('parent_id'),
    // Feature only. Epic is project-level and has no Team (BA spec §11.1).
    teamId: uuid('team_id'),
    // Feature only — Rally likewise allows Release on the lowest portfolio level
    // only, to schedule a feature into a roadmap timeframe.
    // Feature only, and `ON DELETE SET NULL` (migration 0114): deleting a Release unschedules the
    // Features planned into it rather than leaving them pointing at a missing row.
    releaseId: uuid('release_id').references(() => releases.id, { onDelete: 'set null' }),
    ownerId: uuid('owner_id'),
    // Both nullable dates. Rally allows a portfolio item with no planned dates (it
    // simply drops off the timeline), and health is only computable once they exist.
    plannedStartDate: date('planned_start_date'),
    plannedEndDate: date('planned_end_date'),
    marketReleaseDate: date('market_release_date'),
    // LexoRank string, same scheme as work_items.rank — reorder via
    // `between()` from @platform's lexorank util under an advisory lock on the
    // rank scope. Never an integer position: renumbering rows on every move is
    // what the lexorank approach exists to avoid.
    rank: varchar('rank', { length: 255 }).notNull().default(''),
    // Archive, never hard delete (BA spec §5.5). `Delete` in the UI sets this.
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('ix_portfolio_workspace').on(t.workspaceId),
    projectIdx: index('ix_portfolio_project').on(t.projectId),
    keyIdx: uniqueIndex('uq_portfolio_item_key').on(t.workspaceId, t.itemKey),
    // The list query: filter (workspace, type), hide archived, order by rank.
    listIdx: index('ix_portfolio_list').on(t.workspaceId, t.type, t.archivedAt, t.rank),
    // Children-of-Epic preview and the Epic rollup.
    parentIdx: index('ix_portfolio_parent').on(t.parentId, t.rank),
    teamIdx: index('ix_portfolio_team').on(t.teamId),
    releaseIdx: index('ix_portfolio_release').on(t.releaseId),
  }),
);

// ── capacity_plans (P5.2) ─────────────────────────────────────────────────
//
// One plan per (project, release) — enforced by the unique index below, not by a
// service check, because that is the rule the whole feature rests on.
export const capacityPlans = workSchema.table(
  'capacity_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    // RESTRICT on both: a plan is a commitment, so a release or project that is going away is exactly
    // what an operator needs to be told about. Cascading would delete planning history silently, and
    // before 0085 there was no constraint at all — deleting a release left the plan pointing at a
    // missing row, unable to publish its Release field and unable to be repaired.
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    releaseId: uuid('release_id')
      .notNull()
      .references(() => releases.id, { onDelete: 'restrict' }),
    // `CP-<n>`, minted per project like `iterations.iteration_key`. NOT NULL since 0085: the unique
    // index is (project_id, plan_key) and NULLs are distinct in a btree, so it never constrained a
    // missing key — three live plans had none, and the ID is the list's only way in.
    planKey: varchar('plan_key', { length: 30 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    status: capacityPlanStatusEnum('status').notNull().default('draft'),
    // Chosen at creation, FIXED afterwards. Every number on the plan is in this
    // unit, including each allocation value — which is why it cannot change once
    // demand exists.
    unit: capacityPlanUnitEnum('unit').notNull(),
    // Compared against the Release's own dates at publish time: Feature Release and
    // planned dates are written only when they match, otherwise publish returns an
    // advisory and writes nothing.
    plannedStartDate: date('planned_start_date'),
    plannedEndDate: date('planned_end_date'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishedBy: uuid('published_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('ix_capacity_plans_workspace').on(t.workspaceId),
    projectIdx: index('ix_capacity_plans_project').on(t.projectId),
    uniquePlanIdx: uniqueIndex('uq_capacity_plan_project_release').on(t.projectId, t.releaseId),
    keyIdx: uniqueIndex('uq_capacity_plans_key').on(t.projectId, t.planKey),
  }),
);

// ── capacity_plan_teams ───────────────────────────────────────────────────
//
// A Team participating in a plan, plus the capacity a planner typed for it.
// Capacity is MANUAL: `Calculate Capacity Forecast` only proposes values from a
// supplied historic velocity, and the planner may edit every one before publish.
// Nothing derives capacity automatically (explicitly out of scope).
export const capacityPlanTeams = workSchema.table(
  'capacity_plan_teams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planId: uuid('plan_id').notNull(),
    // RESTRICT, as on the plan's project and release: a team that still carries committed demand must
    // not vanish from under it. Before 0085 this column referenced nothing.
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'restrict' }),
    // In the plan's unit. Null = capacity not yet entered, which is different from
    // zero capacity and must render as blank rather than 0.
    capacity: numeric('capacity', { precision: 10, scale: 2 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    planIdx: index('ix_capacity_plan_teams_plan').on(t.planId),
    uniqueTeamIdx: uniqueIndex('uq_capacity_plan_team').on(t.planId, t.teamId),
  }),
);

// ── capacity_plan_allocations ─────────────────────────────────────────────
//
// Committed demand: this much of this Feature, to this Team, in this plan.
//
// `value` is THE ONLY stored number in Phase 5 — everything else is aggregated on
// read. That is deliberate and load-bearing: planning demand must stay fixed even
// when the Feature's child estimates change afterwards, so a plan records what was
// committed rather than what the children currently add up to. Do not "improve"
// this into a rollup.
//
// `team_id` is nullable and models the Unallocated bucket without a second table.
// It is also why "Total Allocated" counts only rows WHERE team_id IS NOT NULL — an
// unallocated placeholder must not outrank a Refined or Preliminary estimate.
//
// One Feature may hold several rows (Rally calls this sharing a feature between
// teams; each allocated team appears as its own row under the feature).
export const capacityPlanAllocations = workSchema.table(
  'capacity_plan_allocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planId: uuid('plan_id').notNull(),
    portfolioItemId: uuid('portfolio_item_id').notNull(),
    // Nullable: NULL is the Unallocated bucket. A real team still cannot be deleted while it holds a
    // slice of a Feature, which is what RESTRICT says.
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'restrict' }),
    /**
     * Rally's PRIMARY team assignment for this Feature in this plan.
     *
     * Rally: "you can assign the portfolio item to one primary team and then allocate points or
     * story counts to the additional teams that will contribute to the work." One team owns the
     * Feature; the rest are contributors. The Items tab's "Planned Project Assignment" shows
     * this team, which is why it cannot just be inferred from the allocation list.
     *
     * A flag on the allocation rather than a column on a plan-item table, because the primary is
     * BY DEFINITION one of the teams that has an allocation — and "in the plan with no team at
     * all" is already expressed by `team_id IS NULL`, Rally's unassigned state.
     */
    isPrimary: boolean('is_primary').notNull().default(false),
    /**
     * The committed demand this row carries — a FIXED snapshot, per Capacity SRS §11
     * (`fixed allocation.value set during planning/replanning`).
     *
     * NOT NULL again as of 0101. Migration 0077 had made it nullable so a blank Estimate could
     * resolve to the Feature's own estimate on read, and stated the objection it was solving:
     * "a defaulted 8 and a deliberate 8 were indistinguishable". `source` answers that objection
     * without a resolving read — which matters because a resolved value moved a Draft plan's
     * totals whenever someone edited the Feature's Refined Estimate, so `Team Estimated =
     * SUM(allocation.value)` (§337) was not summable from stored rows.
     */
    value: numeric('value', { precision: 10, scale: 2 }).notNull(),
    /** Whether {@link value} was copied from the Feature's estimate or typed (§185-186). */
    source: capacityAllocationSourceEnum('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    planIdx: index('ix_capacity_allocations_plan').on(t.planId),
    itemIdx: index('ix_capacity_allocations_item').on(t.portfolioItemId),
    // Team grid: rows for one team within one plan.
    planTeamIdx: index('ix_capacity_allocations_plan_team').on(t.planId, t.teamId),
    /**
     * ONE row per (plan, Feature, team) — and one unallocated row per (plan, Feature).
     *
     * Two indexes because NULL is not a value: Postgres treats null team ids as distinct, so the
     * first index cannot hold the Unallocated bucket to a single row per Feature. Without either,
     * the service's read-then-merge was the only guard: a race, a retried request or a re-run seed
     * duplicated the row and multiplied a team's Estimated.
     */
    oneRowPerTeam: uniqueIndex('uq_capacity_allocation_team')
      .on(t.planId, t.portfolioItemId, t.teamId)
      .where(sql`${t.teamId} is not null`),
    oneUnassignedRow: uniqueIndex('uq_capacity_allocation_unassigned')
      .on(t.planId, t.portfolioItemId)
      .where(sql`${t.teamId} is null`),
    // ONE primary per Feature per plan, enforced by the database rather than by the service:
    // a race between two "make this the primary" calls would otherwise leave two.
    onePrimaryPerItem: uniqueIndex('uq_capacity_allocation_primary')
      .on(t.planId, t.portfolioItemId)
      .where(sql`${t.isPrimary}`),
    // An unallocated placeholder has no team, so it can never be the team that owns the work.
    primaryNeedsTeam: check(
      'ck_capacity_primary_has_team',
      sql`not ${t.isPrimary} or ${t.teamId} is not null`,
    ),
  }),
);

// ── comments ──────────────────────────────────────────────────────────────

export const comments = workSchema.table(
  'comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    // Polymorphic subject (0082), the same shape `activity_logs` uses. Replaced a plain
    // `work_item_id`, which was the only reason a portfolio item could not be discussed.
    entityType: entityRefTypeEnum('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    authorId: uuid('author_id').notNull(),
    body: text('body').notNull(),
    parentId: uuid('parent_id'), // NULL = top-level, non-null = threaded reply
    isEdited: boolean('is_edited').notNull().default(false),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('ix_comments_workspace').on(t.workspaceId),
    // Every read is "the comments on THIS subject", so the pair is the access path.
    entityIdx: index('ix_comments_entity').on(t.entityType, t.entityId),
    authorIdx: index('ix_comments_author').on(t.authorId),
    parentIdx: index('ix_comments_parent').on(t.parentId),
  }),
);

// ── attachments (link: any owning entity ←→ storage.files) ─────────────────
//
// Replaces the old work.attachments table, which carried the blob metadata AND
// hard-coded work_item_id NOT NULL — meaning every new upload surface needed its
// own copy of the whole thing. Blob metadata now lives once in storage.files;
// this table only records "this file is attached to this work item".
//
// Both sides are real FKs with ON DELETE CASCADE: deleting a work item drops its
// link rows, and the now-unreferenced storage.files rows are swept by the worker
// reaper (which is also what deletes the underlying objects).

/**
 * File attachments on any entity that can own them (migration 0083).
 *
 * Polymorphic on `(entity_type, entity_id)` like `comments` and `activity_logs`, and sharing
 * `comments`' `entity_ref_type` enum — that enum is the list of things that own child
 * records. There is deliberately no FK on `entity_id`: it cannot point at two tables, which
 * is the standing cost of this shape here and in `activity_logs`. Deletion is handled by the
 * owning service, and the reaper collects blobs no row references.
 */
export const attachments = workSchema.table(
  'attachments',
  {
    entityType: entityRefTypeEnum('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').notNull(),
    attachedBy: uuid('attached_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Natural key: the same file attached twice to one entity is still one attachment.
    pk: primaryKey({ columns: [t.entityType, t.entityId, t.fileId] }),
    entityIdx: index('ix_attachments_entity').on(t.entityType, t.entityId),
    // Drives the "is this file still referenced?" check in the reaper.
    fileIdx: index('ix_attachments_file').on(t.fileId),
    workspaceIdx: index('ix_attachments_workspace').on(t.workspaceId),
  }),
);

// ── labels ────────────────────────────────────────────────────────────────

export const labels = workSchema.table(
  'labels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    color: varchar('color', { length: 20 }).notNull().default('#6b7280'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('ix_labels_workspace').on(t.workspaceId),
    projectIdx: index('ix_labels_project').on(t.projectId),
    uniqueName: uniqueIndex('uq_labels_name').on(t.projectId, t.name),
  }),
);

// ── work_item_labels (join table) ─────────────────────────────────────────

export const workItemLabels = workSchema.table(
  'work_item_labels',
  {
    workItemId: uuid('work_item_id').notNull(),
    labelId: uuid('label_id').notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workItemId, t.labelId] }),
    workItemIdx: index('ix_wil_work_item').on(t.workItemId),
    labelIdx: index('ix_wil_label').on(t.labelId),
  }),
);

// ── teams (workspace-scoped) ──────────────────────────────────────────────

export const teams = workSchema.table(
  'teams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    key: varchar('key', { length: 10 }).notNull(),
    description: text('description'),
    leadId: uuid('lead_id'),
    status: teamStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('ix_teams_workspace').on(t.workspaceId),
    uniqueKey: uniqueIndex('uq_teams_key').on(t.workspaceId, t.key),
  }),
);

// ── team_members ──────────────────────────────────────────────────────────

export const teamMembers = workSchema.table(
  'team_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    teamId: uuid('team_id').notNull(),
    userId: uuid('user_id').notNull(),
    status: teamMemberStatusEnum('status').notNull().default('active'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('ix_tm_workspace').on(t.workspaceId),
    teamIdx: index('ix_tm_team').on(t.teamId),
    uniqueMember: uniqueIndex('uq_team_member').on(t.teamId, t.userId),
  }),
);

// ── project_teams (project–team link) ────────────────────────────────────

export const projectTeams = workSchema.table(
  'project_teams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    teamId: uuid('team_id').notNull(),
    status: projectTeamStatusEnum('status').notNull().default('active'),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
    unlinkedAt: timestamp('unlinked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('ix_pt_workspace').on(t.workspaceId),
    projectIdx: index('ix_pt_project').on(t.projectId),
    uniqueLink: uniqueIndex('uq_project_team').on(t.projectId, t.teamId),
  }),
);

// ── project_members ───────────────────────────────────────────────────────

export const projectMembers = workSchema.table(
  'project_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    userId: uuid('user_id').notNull(),
    // Per-Project access level (RBAC migration Phase 1, migration 0104).
    // 'admin' | 'editor'; NULL (or no active row) = No Access (not a member).
    // role_id is retained only as a rollback safety net until the Phase 10 contract drop.
    accessLevel: varchar('access_level', { length: 10 }),
    status: projectMemberStatusEnum('status').notNull().default('active'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('ix_pm_workspace').on(t.workspaceId),
    projectIdx: index('ix_pm_project').on(t.projectId),
    userIdx: index('ix_pm_user').on(t.userId),
    uniqueMember: uniqueIndex('uq_project_member').on(t.projectId, t.userId),
  }),
);

// ── activity_logs (Revision History — sync, same-tx, read-your-writes) ──────
//
// Product-facing revision feed shown in the Work Item / Task "Revision History"
// tab. Written in the SAME transaction as the mutation so the actor sees their
// change immediately. Deliberately SEPARATE from audit.audit_logs (async,
// outbox-fed, SOC2 compliance) — different consistency, retention and access.
// Append-only; never stores rich-text bodies, secrets or tokens.

// The SINGLE shared activity store for every entity's Revision History
// (work items, tasks, attachments, iterations, projects, milestones, releases).
// Polymorphic: entity_type + entity_id = the subject; context_id = an optional
// parent anchor so a parent's history can include its children (e.g. task and
// attachment logs surface on the parent work item). Written in the SAME
// transaction as the mutation (see ActivityLogger) so the actor sees the change
// immediately. Append-only; never stores rich-text bodies.
export const activityLogs = workSchema.table(
  'activity_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    entityType: activityEntityTypeEnum('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    // Optional parent anchor: when set, a parent entity's history query also
    // returns this row (e.g. task/attachment logs anchored to the work item).
    contextId: uuid('context_id'),
    actorId: uuid('actor_id'), // null = system action
    action: varchar('action', { length: 60 }).notNull(), // e.g. 'work_item.assigned'
    // { field, old, new } — short scalar values only, never rich-text body.
    changes: jsonb('changes'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('ix_activity_workspace').on(t.workspaceId),
    // Primary read path: history for one entity, newest first.
    entityIdx: index('ix_activity_entity').on(t.entityType, t.entityId, t.createdAt),
    contextIdx: index('ix_activity_context').on(t.contextId),
    projectIdx: index('ix_activity_project').on(t.projectId),
  }),
);

// ── time_logs ─────────────────────────────────────────────────────────────────
// Per-user time entries against a work item (added in migration 0012). Retained
// as an optional worklog/audit trail. As of migration 0052 these entries no
// longer drive actual_hours — Actual is a manual input (SRS P1-TASK-01).

export const timeLogs = workSchema.table(
  'time_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    workItemId: uuid('work_item_id').notNull(),
    userId: uuid('user_id').notNull(),
    loggedDate: date('logged_date').notNull(),
    hours: numeric('hours', { precision: 6, scale: 2 }).notNull(),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    workspaceIdx: index('ix_tl_workspace').on(t.workspaceId),
    workItemIdx: index('ix_tl_work_item')
      .on(t.workItemId)
      .where(sql`deleted_at IS NULL`),
    userIdx: index('ix_tl_user').on(t.userId, t.loggedDate),
  }),
);

// ── work_item_watchers ────────────────────────────────────────────────────────
// Follower/subscriber list for notification fan-out (added in migration 0012).
// Composite primary key: one row per (workItem, user) pair.

// F6 — directed links between work items (blocks / duplicates / relates_to /
// depends_on). Stored once on the canonical source→target direction;
// the app derives the inverse label for the target side.
export const workItemRelations = workSchema.table(
  'work_item_relations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    sourceItemId: uuid('source_item_id').notNull(),
    targetItemId: uuid('target_item_id').notNull(),
    relationType: workItemRelationTypeEnum('relation_type').notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: uniqueIndex('uq_wir_source_target_type').on(t.sourceItemId, t.targetItemId, t.relationType),
    sourceIdx: index('ix_wir_source').on(t.sourceItemId),
    targetIdx: index('ix_wir_target').on(t.targetItemId),
    workspaceIdx: index('ix_wir_workspace').on(t.workspaceId),
  }),
);

export const workItemWatchers = workSchema.table(
  'work_item_watchers',
  {
    workItemId: uuid('work_item_id').notNull(),
    userId: uuid('user_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    watchedAt: timestamp('watched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workItemId, t.userId] }),
    userIdx: index('ix_wiw_user').on(t.userId),
    workspaceIdx: index('ix_wiw_workspace').on(t.workspaceId),
  }),
);

// ── release_daily_snapshots (burndown / scope tracking read model) ───────

// Grain: one row per (release, TEAM SCOPE, workspace-local date). `teamId IS NULL` is
// the All Teams aggregate, STORED rather than summed from the team rows on read — a sum
// cannot de-duplicate a work item that two teams both touch, and RT §4.1 requires
// DISTINCT work item IDs.
//
// Points and count live on ONE row: `Chart Unit` is a display switch over the same
// measured population, not a second measurement, so two rows per day would let the two
// units disagree about the same day.
export const releaseDailySnapshots = workSchema.table(
  'release_daily_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    releaseId: uuid('release_id').notNull(),
    // NULL = the All Teams aggregate row for this release and date.
    teamId: uuid('team_id'),
    snapshotDate: date('snapshot_date').notNull(),
    // ── Phase 6 Release Tracking burnup (migration 0089) ──────────────────
    // Accepted is {Accepted, Release} ONLY (RT-AC-08). The legacy columns above were
    // written from COMPLETED_SCHEDULE_STATES, which includes `Completed` and is
    // therefore the wrong population for this chart.
    acceptedPoints: numeric('accepted_points', { precision: 8, scale: 2 }).notNull().default('0'),
    acceptedCount: integer('accepted_count').notNull().default(0),
    plannedPoints: numeric('planned_points', { precision: 8, scale: 2 }).notNull().default('0'),
    plannedCount: integer('planned_count').notNull().default(0),
    // Top-down Feature estimate for the Features in/derived into this release
    // (RT-BR-08), captured per day so the planning reference line is historical too.
    preliminaryPoints: numeric('preliminary_points', { precision: 8, scale: 2 })
      .notNull()
      .default('0'),
    preliminaryCount: integer('preliminary_count').notNull().default(0),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
    finalized: boolean('finalized').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // COALESCE'd into the nil UUID in SQL (migration 0089) so ON CONFLICT targets one
    // predicate and the daily job stays a single upsert for team and All Teams rows.
    /**
     * COALESCE'd, exactly as migration 0089 creates it.
     *
     * Declared with `sql` rather than as three plain columns because a unique index over a NULLABLE
     * column does not dedupe NULLs — and `team_id IS NULL` is the All Teams row, so the plain form
     * would let two ticks insert it twice. The declaration drifted from the migration here: the DB had
     * the COALESCE and this said `(release_id, team_id, snapshot_date)`, which a regenerated migration
     * would have "fixed" into the broken shape and quietly killed the idempotent upsert.
     */
    uniqueRelease: uniqueIndex('uq_rds_release_team_date').on(
      t.releaseId,
      sql`coalesce(${t.teamId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.snapshotDate,
    ),
    releaseIdx: index('ix_rds_release').on(t.releaseId),
    workspaceIdx: index('ix_rds_workspace').on(t.workspaceId),
  }),
);

// ── tasks (P3 refactor — separate from work_items) ──────────────────────
// Child execution items belonging to a parent work item (Story / Defect).
// US and DE stay in work_items; Tasks get their own table.

export const tasks = workSchema.table(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    parentId: uuid('parent_id')
      .notNull()
      .references(() => workItems.id, { onDelete: 'cascade' }),
    itemKey: varchar('item_key', { length: 30 }).notNull(),
    title: varchar('title', { length: 500 }).notNull(),
    description: text('description'),
    // Phase 1.6 maps Notes for Story/Defect/**Task**. Added by migration 0096; before it the
    // column did not exist while the DTO, the editor and the activity diff all assumed it did.
    notes: text('notes'),
    state: taskStateEnum('state').notNull().default('defined'),
    assigneeId: uuid('assignee_id'),
    /**
     * The SECOND responsibility, independent of `assignee_id` (migration 0127).
     *
     * BA `c42df59` (2026-08-22) makes `Dev Owner` first-class on a Task as well as a Story/Defect —
     * `P4-NOTIF-DC-012` notifies on "Owner **or** Dev Owner of a US/DE/**Task**". Nullable, no FK and
     * no default, exactly like `assignee_id` beside it: eligibility depends on the project AND the
     * team, which the service decides (`ProjectsService.assertAssignable`), and an unset value is
     * `No Entry` rather than a placeholder. Never derived from `assignee_id` — the BA forbids reusing
     * it and a copy would give every task an owner nobody chose.
     */
    devOwnerId: uuid('dev_owner_id'),
    teamId: uuid('team_id'),
    /**
     * A maintained MIRROR of the parent's iteration (`trg_task_iteration_from_parent`), with its own
     * `ON DELETE SET NULL` key as of migration 0114.
     *
     * Both, deliberately. `trg_cascade_iteration_to_tasks` follows a parent whose iteration changes,
     * and the FK on `work_items.iteration_id` produces exactly that change — but a task written
     * directly by a seed, or one whose parent link is broken, is only covered by having the key here.
     * The two converge: the trigger re-derives from the parent, which is NULL by then.
     */
    iterationId: uuid('iteration_id').references(() => iterations.id, { onDelete: 'set null' }),
    estimateHours: numeric('estimate_hours', { precision: 8, scale: 2 }),
    todoHours: numeric('todo_hours', { precision: 8, scale: 2 }),
    actualHours: numeric('actual_hours', { precision: 8, scale: 2 }),
    rank: varchar('rank', { length: 255 }).notNull().default(''),
    createdBy: uuid('created_by').notNull(),
    updatedBy: uuid('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    workspaceIdx: index('ix_tasks_workspace').on(t.workspaceId),
    projectIdx: index('ix_tasks_project').on(t.projectId),
    parentIdx: index('ix_tasks_parent').on(t.parentId),
    iterationIdx: index('ix_tasks_iteration').on(t.iterationId),
    assigneeIdx: index('ix_tasks_assignee').on(t.assigneeId),
    teamIdx: index('ix_tasks_team').on(t.teamId),
    rankIdx: index('ix_tasks_rank').on(t.parentId, t.rank),
    itemKeyIdx: uniqueIndex('uq_task_item_key').on(t.workspaceId, t.itemKey),
  }),
);

// ── milestones (P3.3) ────────────────────────────────────────────────────
// Project-level milestone that can link to multiple releases.
// Target dates are derived from linked releases (read-only, computed).

export const milestones = workSchema.table(
  'milestones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    milestoneKey: varchar('milestone_key', { length: 30 }),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    notes: text('notes'),
    status: milestoneStatusEnum('status').notNull().default('planned'),
    ownerId: uuid('owner_id'),
    targetStartDate: date('target_start_date'),
    targetEndDate: date('target_end_date'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('ix_milestones_workspace').on(t.workspaceId),
    projectIdx: index('ix_milestones_project').on(t.projectId),
    keyIdx: uniqueIndex('uq_milestones_key').on(t.projectId, t.milestoneKey),
  }),
);

// ── milestone_releases (link table) ──────────────────────────────────────

export const milestoneReleases = workSchema.table(
  'milestone_releases',
  {
    // `ON DELETE CASCADE` (migration 0114). CASCADE and not SET NULL because this column is part of
    // the primary key: the row IS the association, so an association to no milestone cannot exist.
    // Deleting a milestone "removes the association from each work item… The work item itself is not
    // deleted" — the link goes, the artifact stays.
    milestoneId: uuid('milestone_id')
      .notNull()
      .references(() => milestones.id, { onDelete: 'cascade' }),
    releaseId: uuid('release_id').notNull(),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.milestoneId, t.releaseId] }),
    milestoneIdx: index('ix_mr_milestone').on(t.milestoneId),
    releaseIdx: index('ix_mr_release').on(t.releaseId),
  }),
);

// ── milestone_projects (P3.3 multi-project support) ────────────────────
export const milestoneProjects = workSchema.table(
  'milestone_projects',
  {
    // `ON DELETE CASCADE` (migration 0114). CASCADE and not SET NULL because this column is part of
    // the primary key: the row IS the association, so an association to no milestone cannot exist.
    // Deleting a milestone "removes the association from each work item… The work item itself is not
    // deleted" — the link goes, the artifact stays.
    milestoneId: uuid('milestone_id')
      .notNull()
      .references(() => milestones.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull(),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.milestoneId, t.projectId] }),
    milestoneIdx: index('ix_mp_milestone').on(t.milestoneId),
    projectIdx: index('ix_mp_project').on(t.projectId),
  }),
);

// ── milestone_teams (P3.3 multi-team support) ─────────────────────────
export const milestoneTeams = workSchema.table(
  'milestone_teams',
  {
    // `ON DELETE CASCADE` (migration 0114). CASCADE and not SET NULL because this column is part of
    // the primary key: the row IS the association, so an association to no milestone cannot exist.
    // Deleting a milestone "removes the association from each work item… The work item itself is not
    // deleted" — the link goes, the artifact stays.
    milestoneId: uuid('milestone_id')
      .notNull()
      .references(() => milestones.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id').notNull(),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.milestoneId, t.teamId] }),
    milestoneIdx: index('ix_mt_milestone').on(t.milestoneId),
    teamIdx: index('ix_mt_team').on(t.teamId),
  }),
);

// ── milestone_artifacts (P3.3 — US/DE assigned to milestone) ──────────
/**
 * What a milestone tracks (migration 0084).
 *
 * Polymorphic on `(entity_type, entity_id)` like `comments`, `attachments` and
 * `activity_logs`, sharing the same `entity_ref_type` enum: a milestone can be assigned to a
 * work item OR to a portfolio item (SRS §5.1 and §11.4 both require the selector).
 *
 * The table name did NOT change when the column did — "artifact" is already the
 * entity-agnostic word, and Rally itself calls the things a milestone tracks its artifacts.
 *
 * No FK on `entity_id`: it cannot point at two tables, which is the standing cost of this
 * shape here and in `activity_logs`. The owning service handles cleanup.
 */
export const milestoneArtifacts = workSchema.table(
  'milestone_artifacts',
  {
    // `ON DELETE CASCADE` (migration 0114). CASCADE and not SET NULL because this column is part of
    // the primary key: the row IS the association, so an association to no milestone cannot exist.
    // Deleting a milestone "removes the association from each work item… The work item itself is not
    // deleted" — the link goes, the artifact stays.
    milestoneId: uuid('milestone_id')
      .notNull()
      .references(() => milestones.id, { onDelete: 'cascade' }),
    entityType: entityRefTypeEnum('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Natural key: assigning one milestone to one item twice is still one assignment.
    pk: primaryKey({ columns: [t.milestoneId, t.entityType, t.entityId] }),
    milestoneIdx: index('ix_ma_milestone').on(t.milestoneId),
    entityIdx: index('ix_ma_entity').on(t.entityType, t.entityId),
  }),
);

// ── member_capacity (P3.1 Team Status) ─────────────────────────────────

export const memberCapacity = workSchema.table(
  'member_capacity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    teamId: uuid('team_id').notNull(),
    iterationId: uuid('iteration_id').notNull(),
    userId: uuid('user_id').notNull(),
    capacityHours: numeric('capacity_hours', { precision: 8, scale: 2 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueMember: uniqueIndex('uq_member_capacity').on(
      t.projectId,
      t.teamId,
      t.iterationId,
      t.userId,
    ),
    workspaceIdx: index('ix_mc_workspace').on(t.workspaceId),
    iterationIdx: index('ix_mc_iteration').on(t.iterationId),
    userIdx: index('ix_mc_user').on(t.userId),
  }),
);

// ── project_settings (Phase 1.8 §6.2 Estimation Settings) ───────────────────

export const projectSettings = workSchema.table(
  'project_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    xsPoints: integer('xs_points').notNull().default(1),
    sPoints: integer('s_points').notNull().default(3),
    mPoints: integer('m_points').notNull().default(5),
    lPoints: integer('l_points').notNull().default(8),
    xlPoints: integer('xl_points').notNull().default(13),
    hoursPerPoint: numeric('hours_per_point', { precision: 8, scale: 2 }).notNull().default('8.0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectUq: uniqueIndex('uq_project_settings_project').on(t.projectId),
    workspaceIdx: index('ix_project_settings_workspace').on(t.workspaceId),
  }),
);

// ── P7 test_case_types (per-project Type catalog, modelled on `labels`) ─────
// SRS §3: Test Case Type is a per-PROJECT, admin-editable catalog (a declared divergence
// from Rally's workspace-level dropdown). `archived_at` soft-hides a removed Type rather
// than deleting it — a historical Test Case keeps its snapshot `type` value regardless
// (BR2, BR17), so nothing here needs to cascade on archive.

export const testCaseTypes = workSchema.table(
  'test_case_types',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    name: varchar('name', { length: 60 }).notNull(),
    position: integer('position').notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdx: index('ix_test_case_types_project').on(t.projectId),
    // Case-insensitive (SRS §3.3, BR16) — must match the service's own duplicate check.
    uniqueName: uniqueIndex('uq_test_case_types_name').on(t.projectId, sql`lower(${t.name})`),
  }),
);

// ── P7 test_cases ────────────────────────────────────────────────────────────
// A Test Case is a project artifact, OPTIONALLY attached to one Work Item (D2:
// `work_item_id` nullable — only work-item-scoped routes are exposed in Phase 7).
// `last_verdict` / `last_run` / `last_result_id` are a denormalised mirror of the latest
// live Result, maintained by `trg_test_case_last_result` (D6) — never written by the
// service, same reason `trg_sync_accepted_date` is a trigger and not a service concern.

export const testCases = workSchema.table(
  'test_cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    // Inherited, read-only (SRS §6.3); NULL = "Project backlog", same reading as
    // `work_items.team_id` / `iterations.team_id`.
    teamId: uuid('team_id'),
    // NULLABLE (D2). No `ON DELETE cascade`: a Work Item delete is SOFT, so a cascade would
    // never fire anyway (the same reason CLAUDE.md records for `work.tasks`) — Phase F
    // decides whether a deleted Work Item's Test Cases follow it.
    workItemId: uuid('work_item_id').references(() => workItems.id),
    testCaseKey: varchar('test_case_key', { length: 30 }).notNull(),
    name: varchar('name', { length: 500 }).notNull(),
    description: text('description'),
    objective: text('objective'),
    preconditions: text('preconditions'),
    validationInput: text('validation_input'),
    validationExpectedResult: text('validation_expected_result'),
    postconditions: text('postconditions'),
    notes: text('notes'),
    // Text SNAPSHOT of the Type name (D8, BR2) — a removed Type must still render on a
    // historical Test Case, which a snapshot gives for free.
    type: varchar('type', { length: 60 }).notNull(),
    method: testCaseMethodEnum('method').notNull().default('manual'),
    priority: testCasePriorityEnum('priority').notNull().default('normal'),
    // No FK on owner_id / assignee_id, matching `work.tasks.assignee_id`: eligibility
    // depends on project AND team (no constraint expresses that), and a user delete must
    // not cascade into test history.
    ownerId: uuid('owner_id'),
    assigneeId: uuid('assignee_id'),
    rank: varchar('rank', { length: 255 }).notNull().default(''),
    // Maintained by trg_test_case_last_result (D6) — never written by the service.
    lastVerdict: testVerdictEnum('last_verdict'),
    lastRun: date('last_run'),
    lastResultId: uuid('last_result_id'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    keyIdx: uniqueIndex('uq_test_case_key').on(t.workspaceId, t.testCaseKey),
    workItemIdx: index('ix_test_cases_work_item')
      .on(t.workItemId)
      .where(sql`deleted_at IS NULL`),
    projectIdx: index('ix_test_cases_project').on(t.projectId),
    workspaceIdx: index('ix_test_cases_workspace').on(t.workspaceId),
    workItemRankIdx: index('ix_test_cases_work_item_rank').on(t.workItemId, t.rank),
  }),
);

// ── P7 test_results ──────────────────────────────────────────────────────────
// Append-only (BR12): adding a Result never replaces an earlier one. `work_item_id` is a
// SNAPSHOT of the Test Case's Work Product at result-entry time (Rally: "the work product
// to which the test case result was associated when you entered the result") — not
// editable, and not re-derived from the Test Case's current link.

export const testResults = workSchema.table(
  'test_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    testCaseId: uuid('test_case_id')
      .notNull()
      .references(() => testCases.id, { onDelete: 'cascade' }),
    workItemId: uuid('work_item_id'),
    testResultKey: varchar('test_result_key', { length: 30 }).notNull(),
    build: varchar('build', { length: 255 }).notNull(),
    // Named `run_date`, not `date` — reserved-word hygiene (plan §2.3).
    runDate: date('run_date').notNull(),
    verdict: testVerdictEnum('verdict').notNull(),
    durationMinutes: integer('duration_minutes').notNull().default(0),
    testerId: uuid('tester_id').notNull(),
    notes: text('notes'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    keyIdx: uniqueIndex('uq_test_result_key').on(t.workspaceId, t.testResultKey),
    // This IS the SRS §7 ordering (BR14) and the trigger's own "latest result" lookup —
    // one index serves both.
    caseRunDateIdx: index('ix_test_results_case_run_date').on(
      t.testCaseId,
      sql`${t.runDate} desc`,
      sql`${t.createdAt} desc`,
    ),
    durationNonNegative: check(
      'ck_test_results_duration_non_negative',
      sql`${t.durationMinutes} >= 0`,
    ),
    // `not_run` is a Test Case-only concept (D6) — a Result records an outcome, never its
    // absence. One enum, two audiences, one excluded member: see `testVerdictEnum`'s comment.
    verdictNotNotRun: check('ck_test_results_verdict_not_not_run', sql`${t.verdict} <> 'not_run'`),
  }),
);
