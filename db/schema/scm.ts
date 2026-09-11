/**
 * scm schema — source-control "Connections" (Pull Requests) and Changesets
 * (commits) linked to work items, plus the repo→project mapping and a durable
 * webhook inbox.
 *
 * Link model (Rally-faithful): the work-item formatted key (e.g. US-1) embedded
 * in a PR title / branch name / commit message is what associates an SCM
 * artifact to a work item. A webhook carries the repository, so `repositories`
 * maps a repo to the project(s) whose keys it may reference; resolution is then
 * (key + project) → work item (work.work_items is unique on (project_id, item_key)).
 *
 * Ingestion is async: the API persists raw webhook events to `webhook_inbox`
 * (fast 202) and a worker relay parses + links them with retry/backoff. Dedup
 * is by unique constraints (delivery id; (work_item_id, external_id) for
 * connections; (work_item_id, revision) for changesets) so at-least-once
 * delivery never produces duplicates.
 *
 * Enum-like columns use centralised Drizzle `pgEnum`s (see db/schema/enums.ts),
 * matching the outbox/status convention across the DB. Workspace isolation is
 * enforced in the app layer (RLS dropped in migration 0025).
 */
import {
  pgSchema,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  scmProviderEnum,
  scmConnectionTypeEnum,
  scmInboxStatusEnum,
  scmBackfillStatusEnum,
} from './enums';

export const scmSchema = pgSchema('scm');

/**
 * One change entry inside a changeset's `changes` array (stored in jsonb, so a
 * colocated storage type rather than a column enum). Actions: Added/Modified/Deleted.
 */
export type ScmChange = { action: 'A' | 'M' | 'D'; path: string };

// ── repositories — SCM repo identity + the mapping side of repo↔project ──────

export const scmRepositories = scmSchema.table(
  'repositories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    /** 'github' (github.com) | 'ghe' (GitHub Enterprise); provider-tagged for future SCMs. */
    provider: scmProviderEnum('provider').notNull(),
    /** owner/name, e.g. "DT-SFI/dt". */
    fullName: varchar('full_name', { length: 255 }).notNull(),
    /** Base web URL of the SCM host, e.g. "https://ghe.coxautoinc.com" (for building links). */
    baseUrl: varchar('base_url', { length: 512 }),
    /** Cached GitHub App installation id for this repo (Phase 2 backfill/REST). */
    installationId: varchar('installation_id', { length: 64 }),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('ix_scm_repositories_workspace').on(t.workspaceId),
    fullNameIdx: uniqueIndex('uq_scm_repositories_workspace_full_name').on(
      t.workspaceId,
      t.provider,
      t.fullName,
    ),
  }),
);

// A repo maps to a WORKSPACE (not to specific projects): work-item keys are
// workspace-unique (Rally FormattedID), so any key in a PR/commit resolves
// workspace-wide. This makes SCM linking org-level — no per-project mapping.

// ── webhook_inbox — durable raw events (async ingestion) ─────────────────────

export const scmWebhookInbox = scmSchema.table(
  'webhook_inbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: scmProviderEnum('provider').notNull(),
    /** Provider delivery id (GitHub X-GitHub-Delivery) — dedup key against redelivery. */
    deliveryId: varchar('delivery_id', { length: 255 }).notNull(),
    /** Provider event name (GitHub X-GitHub-Event): 'pull_request' | 'push' | … */
    eventType: varchar('event_type', { length: 60 }).notNull(),
    payload: jsonb('payload').notNull(),
    status: scmInboxStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    deliveryIdx: uniqueIndex('uq_scm_inbox_delivery').on(t.provider, t.deliveryId),
    pendingIdx: index('ix_scm_inbox_pending')
      .on(t.status, t.scheduledAt)
      .where(sql`status = 'pending'`),
  }),
);

// ── connections — Pull Requests (and future builds/branches) ─────────────────

export const scmConnections = scmSchema.table(
  'connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    workItemId: uuid('work_item_id').notNull(),
    provider: scmProviderEnum('provider').notNull(),
    type: scmConnectionTypeEnum('type').notNull(),
    /** Stable external identity, e.g. "DT-SFI/dt#28743" — dedup key per work item. */
    externalId: varchar('external_id', { length: 255 }).notNull(),
    name: text('name').notNull(),
    url: text('url').notNull(),
    /** PR state: 'open' | 'closed' | 'merged' (nullable for non-PR types). */
    state: varchar('state', { length: 20 }),
    authorName: varchar('author_name', { length: 255 }),
    /** Artifact's own creation time at the source (PR createdAt). */
    sourceCreatedAt: timestamp('source_created_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workItemIdx: index('ix_scm_connections_work_item').on(t.workItemId),
    workspaceIdx: index('ix_scm_connections_workspace').on(t.workspaceId),
    dedupIdx: uniqueIndex('uq_scm_connections_item_external').on(t.workItemId, t.externalId),
  }),
);

// ── changesets — commits ─────────────────────────────────────────────────────

export const scmChangesets = scmSchema.table(
  'changesets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    workItemId: uuid('work_item_id').notNull(),
    provider: scmProviderEnum('provider').notNull(),
    /** Full commit SHA. */
    revision: varchar('revision', { length: 64 }).notNull(),
    /** Display name, e.g. "dt:5fda056a" (repoShort:shortSha). */
    name: varchar('name', { length: 128 }).notNull(),
    message: text('message'),
    uri: text('uri'),
    authorName: varchar('author_name', { length: 255 }),
    authorEmail: varchar('author_email', { length: 320 }),
    committedAt: timestamp('committed_at', { withTimezone: true }),
    /** Per-file changes: [{ action:'A'|'M'|'D', path }]. */
    changes: jsonb('changes').$type<ScmChange[]>().notNull().default([]),
    repositoryFullName: varchar('repository_full_name', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workItemIdx: index('ix_scm_changesets_work_item').on(t.workItemId),
    workspaceIdx: index('ix_scm_changesets_workspace').on(t.workspaceId),
    dedupIdx: uniqueIndex('uq_scm_changesets_item_revision').on(t.workItemId, t.revision),
  }),
);

// ── backfill_jobs — one-shot "pull existing PRs/commits for a repo" jobs ──────
// Enqueued when a repo is mapped or "Sync now" is clicked; drained by the worker
// (ScmBackfillRelayService) which authenticates as the GitHub App and links
// historical artifacts via the same idempotent linker as the webhook path.

export const scmBackfillJobs = scmSchema.table(
  'backfill_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    repositoryId: uuid('repository_id').notNull(),
    status: scmBackfillStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    /** { connections, changesets, prs, commits } once finished. */
    counts: jsonb('counts'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull().defaultNow(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => ({
    repoIdx: index('ix_scm_backfill_repository').on(t.repositoryId),
    pendingIdx: index('ix_scm_backfill_pending')
      .on(t.status, t.scheduledAt)
      .where(sql`status = 'pending'`),
  }),
);

// ── installations — a GitHub App installation bound to a workspace ───────────
// Org-level auto-discovery: binding an installation to a workspace lets Rally
// auto-register that installation's repos (via installation_repositories
// webhooks + the REST discovery) and resolve inbound events to the workspace —
// no per-repo typing. installation_id is GitHub's numeric id (as text).

export const scmInstallations = scmSchema.table(
  'installations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    provider: scmProviderEnum('provider').notNull().default('github'),
    /** GitHub App installation id (numeric, stored as text). */
    installationId: varchar('installation_id', { length: 64 }).notNull(),
    /** Owning org/user login, e.g. "quynhonsemiconductor". */
    accountLogin: varchar('account_login', { length: 255 }),
    /** 'Organization' | 'User'. */
    accountType: varchar('account_type', { length: 32 }),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    installIdx: uniqueIndex('uq_scm_installations_installation').on(t.provider, t.installationId),
    workspaceIdx: index('ix_scm_installations_workspace').on(t.workspaceId),
  }),
);
