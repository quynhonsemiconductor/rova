import type { CursorPayload, PagedResult } from '@platform';
import type {
  ScmProvider,
  ScmRepository,
  ScmRepositoryWithSync,
  ScmInstallation,
  CreateScmRepositoryInput,
  ScmConnection,
  ScmChangeset,
  UpsertConnectionInput,
  UpsertChangesetInput,
} from '../scm.types';

export const SCM_STORE = Symbol('SCM_STORE');

export interface PageArgs {
  limit: number;
  cursor: CursorPayload | null;
}

/**
 * Persistence port for the whole SCM module. One store keeps the aggregate
 * small and the linker/relay/service consistent; the Drizzle implementation
 * lives in infrastructure/persistence.
 */
export interface IScmStore {
  // ── Repositories + mapping ────────────────────────────────────────────────
  listRepositories(workspaceId: string): Promise<ScmRepository[]>;
  /** Repos + their latest backfill status (for the Integrations dashboard). */
  listRepositoriesWithSync(workspaceId: string): Promise<ScmRepositoryWithSync[]>;
  createRepository(input: CreateScmRepositoryInput): Promise<ScmRepository>;
  deleteRepository(workspaceId: string, id: string): Promise<void>;
  /** Resolve a repo's workspace for linking. Null if unregistered/inactive. */
  findRepository(provider: ScmProvider, fullName: string): Promise<{ workspaceId: string } | null>;

  // ── Installations (org-level auto-discovery) ──────────────────────────────
  listInstallations(workspaceId: string): Promise<ScmInstallation[]>;
  /** Bind (or re-activate) an App installation to a workspace. */
  bindInstallation(input: {
    workspaceId: string;
    provider: ScmProvider;
    installationId: string;
    accountLogin: string | null;
    accountType: string | null;
    createdBy: string | null;
  }): Promise<void>;
  /** Workspace an installation is bound to (for webhook resolution). */
  findWorkspaceByInstallation(
    provider: ScmProvider,
    installationId: string,
  ): Promise<{ workspaceId: string } | null>;
  /** Deactivate an installation + all its auto-registered repos. */
  deactivateInstallation(
    workspaceId: string,
    provider: ScmProvider,
    installationId: string,
  ): Promise<void>;
  /** Upsert an auto-discovered repo (active, tagged with its installation). Returns its id. */
  upsertDiscoveredRepo(input: {
    workspaceId: string;
    provider: ScmProvider;
    fullName: string;
    installationId: string;
  }): Promise<{ id: string }>;
  /** Soft-remove a repo by name (installation_repositories 'removed'). */
  deactivateRepository(workspaceId: string, provider: ScmProvider, fullName: string): Promise<void>;

  // ── Backfill (GitHub App REST) ────────────────────────────────────────────
  /** Load the minimal repo identity a backfill run needs. Null if not found. */
  getRepositoryForBackfill(id: string): Promise<{
    id: string;
    workspaceId: string;
    provider: ScmProvider;
    fullName: string;
    installationId: string | null;
  } | null>;
  /** Cache the resolved App installation id on the repo. */
  setInstallationId(id: string, installationId: string): Promise<void>;
  /** Enqueue a pending backfill job for a repo (drained by the worker relay). */
  enqueueBackfill(workspaceId: string, repositoryId: string): Promise<void>;

  // ── Work-item resolution (workspace-unique key → id), no actor (webhook) ─────
  /**
   * Resolve many keys in ONE query. Keys that name no live work item in the
   * workspace are omitted, so the caller can tell misses from hits.
   */
  resolveWorkItemIds(itemKeys: string[], workspaceId: string): Promise<Map<string, string>>;

  // ── Webhook inbox ───────────────────────────────────────────────────────────
  /** Insert a raw event; returns false if the delivery id already exists (dedup). */
  insertInboxEvent(row: {
    provider: ScmProvider;
    deliveryId: string;
    eventType: string;
    payload: unknown;
  }): Promise<{ inserted: boolean }>;

  // ── Links (connections + changesets) — idempotent upserts ────────────────────
  upsertConnection(input: UpsertConnectionInput): Promise<void>;
  upsertChangeset(input: UpsertChangesetInput): Promise<void>;
  listConnections(
    workItemId: string,
    workspaceId: string,
    args: PageArgs,
  ): Promise<PagedResult<ScmConnection>>;
  listChangesets(
    workItemId: string,
    workspaceId: string,
    args: PageArgs,
  ): Promise<PagedResult<ScmChangeset>>;
}
// The worker relay drains scm.webhook_inbox directly against its own tx
// (FOR UPDATE SKIP LOCKED), mirroring notification-relay — no store port needed.
