import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, desc } from 'drizzle-orm';
import { InjectDrizzle, buildPageResult, keysetCondition } from '@platform';
import type { DrizzleDB, PagedResult } from '@platform';
import {
  scmRepositories,
  scmInstallations,
  scmWebhookInbox,
  scmConnections,
  scmChangesets,
  scmBackfillJobs,
} from '../../../../../../db/schema/scm';
import { workItems } from '../../../../../../db/schema/work';
import type {
  ScmProvider,
  ScmRepository,
  ScmRepositoryWithSync,
  ScmInstallation,
  RepoSyncStatus,
  CreateScmRepositoryInput,
  ScmConnection,
  ScmChangeset,
  UpsertConnectionInput,
  UpsertChangesetInput,
} from '../../domain/scm.types';
import type { IScmStore, PageArgs } from '../../domain/ports/scm.store';

@Injectable()
export class ScmDrizzleRepository implements IScmStore {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  // ── Repositories + mapping ────────────────────────────────────────────────

  async listRepositories(workspaceId: string): Promise<ScmRepository[]> {
    const repos = await this.db
      .select()
      .from(scmRepositories)
      .where(eq(scmRepositories.workspaceId, workspaceId))
      .orderBy(scmRepositories.fullName, asc(scmRepositories.id));
    return repos.map((r) => this.toRepository(r));
  }

  async listRepositoriesWithSync(workspaceId: string): Promise<ScmRepositoryWithSync[]> {
    // Only active repos surface on the dashboard — a disconnected installation or
    // a removed/archived repo is deactivated, not deleted, so it must drop out.
    const repos = await this.db
      .select()
      .from(scmRepositories)
      .where(and(eq(scmRepositories.workspaceId, workspaceId), eq(scmRepositories.active, true)))
      .orderBy(scmRepositories.fullName, asc(scmRepositories.id));
    if (repos.length === 0) return [];
    // Latest backfill job per repo — fetch workspace jobs newest-first, keep the
    // first seen per repository (small per workspace; no window function needed).
    const jobs = await this.db
      .select({
        repositoryId: scmBackfillJobs.repositoryId,
        status: scmBackfillJobs.status,
        counts: scmBackfillJobs.counts,
        finishedAt: scmBackfillJobs.finishedAt,
        requestedAt: scmBackfillJobs.requestedAt,
      })
      .from(scmBackfillJobs)
      .where(eq(scmBackfillJobs.workspaceId, workspaceId))
      .orderBy(desc(scmBackfillJobs.requestedAt), asc(scmBackfillJobs.id));
    const latest = new Map<string, (typeof jobs)[number]>();
    for (const j of jobs) if (!latest.has(j.repositoryId)) latest.set(j.repositoryId, j);
    return repos.map((r) => {
      const j = latest.get(r.id);
      const counts = (j?.counts ?? {}) as { prs?: number; commits?: number };
      const lastSync: RepoSyncStatus | null = j
        ? {
            status: j.status,
            at: j.finishedAt ?? j.requestedAt ?? null,
            prs: counts.prs ?? 0,
            commits: counts.commits ?? 0,
          }
        : null;
      return { ...this.toRepository(r), installationId: r.installationId, lastSync };
    });
  }

  // ── Installations (org-level auto-discovery) ──────────────────────────────

  async listInstallations(workspaceId: string): Promise<ScmInstallation[]> {
    const rows = await this.db
      .select()
      .from(scmInstallations)
      .where(and(eq(scmInstallations.workspaceId, workspaceId), eq(scmInstallations.active, true)))
      .orderBy(scmInstallations.accountLogin, asc(scmInstallations.id));
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      provider: r.provider,
      installationId: r.installationId,
      accountLogin: r.accountLogin,
      accountType: r.accountType,
      active: r.active,
    }));
  }

  async bindInstallation(input: {
    workspaceId: string;
    provider: ScmProvider;
    installationId: string;
    accountLogin: string | null;
    accountType: string | null;
    createdBy: string | null;
  }): Promise<void> {
    await this.db
      .insert(scmInstallations)
      .values({
        workspaceId: input.workspaceId,
        provider: input.provider,
        installationId: input.installationId,
        accountLogin: input.accountLogin,
        accountType: input.accountType,
        createdBy: input.createdBy,
      })
      .onConflictDoUpdate({
        target: [scmInstallations.provider, scmInstallations.installationId],
        set: {
          workspaceId: input.workspaceId,
          accountLogin: input.accountLogin,
          accountType: input.accountType,
          active: true,
          updatedAt: new Date(),
        },
      });
  }

  async findWorkspaceByInstallation(
    provider: ScmProvider,
    installationId: string,
  ): Promise<{ workspaceId: string } | null> {
    const [row] = await this.db
      .select({ workspaceId: scmInstallations.workspaceId })
      .from(scmInstallations)
      .where(
        and(
          eq(scmInstallations.provider, provider),
          eq(scmInstallations.installationId, installationId),
          eq(scmInstallations.active, true),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async deactivateInstallation(
    workspaceId: string,
    provider: ScmProvider,
    installationId: string,
  ): Promise<void> {
    await this.db
      .update(scmInstallations)
      .set({ active: false, updatedAt: new Date() })
      .where(
        and(
          eq(scmInstallations.workspaceId, workspaceId),
          eq(scmInstallations.provider, provider),
          eq(scmInstallations.installationId, installationId),
        ),
      );
    // Cascade: the installation's discovered repos are deactivated too, so
    // disconnecting an org clears its repositories from the dashboard. Reconnect
    // re-activates them (upsertDiscoveredRepo sets active = true on conflict).
    await this.db
      .update(scmRepositories)
      .set({ active: false, updatedAt: new Date() })
      .where(
        and(
          eq(scmRepositories.workspaceId, workspaceId),
          eq(scmRepositories.provider, provider),
          eq(scmRepositories.installationId, installationId),
        ),
      );
    await this.db
      .update(scmRepositories)
      .set({ active: false, updatedAt: new Date() })
      .where(
        and(
          eq(scmRepositories.workspaceId, workspaceId),
          eq(scmRepositories.provider, provider),
          eq(scmRepositories.installationId, installationId),
        ),
      );
  }

  async upsertDiscoveredRepo(input: {
    workspaceId: string;
    provider: ScmProvider;
    fullName: string;
    installationId: string;
  }): Promise<{ id: string }> {
    const [repo] = await this.db
      .insert(scmRepositories)
      .values({
        workspaceId: input.workspaceId,
        provider: input.provider,
        fullName: input.fullName,
        installationId: input.installationId,
      })
      .onConflictDoUpdate({
        target: [scmRepositories.workspaceId, scmRepositories.provider, scmRepositories.fullName],
        set: { active: true, installationId: input.installationId, updatedAt: new Date() },
      })
      .returning({ id: scmRepositories.id });
    return { id: repo.id };
  }

  async deactivateRepository(
    workspaceId: string,
    provider: ScmProvider,
    fullName: string,
  ): Promise<void> {
    await this.db
      .update(scmRepositories)
      .set({ active: false, updatedAt: new Date() })
      .where(
        and(
          eq(scmRepositories.workspaceId, workspaceId),
          eq(scmRepositories.provider, provider),
          eq(scmRepositories.fullName, fullName),
        ),
      );
  }

  async createRepository(input: CreateScmRepositoryInput): Promise<ScmRepository> {
    // A repo maps to a WORKSPACE only — work-item keys are workspace-unique, so
    // any key resolves workspace-wide (no per-project mapping).
    const [repo] = await this.db
      .insert(scmRepositories)
      .values({
        workspaceId: input.workspaceId,
        provider: input.provider,
        fullName: input.fullName,
        baseUrl: input.baseUrl ?? null,
      })
      .onConflictDoUpdate({
        target: [scmRepositories.workspaceId, scmRepositories.provider, scmRepositories.fullName],
        set: { baseUrl: input.baseUrl ?? null, active: true, updatedAt: new Date() },
      })
      .returning();
    return this.toRepository(repo);
  }

  async deleteRepository(workspaceId: string, id: string): Promise<void> {
    await this.db
      .delete(scmRepositories)
      .where(and(eq(scmRepositories.id, id), eq(scmRepositories.workspaceId, workspaceId)));
  }

  async findRepository(
    provider: ScmProvider,
    fullName: string,
  ): Promise<{ workspaceId: string } | null> {
    const [repo] = await this.db
      .select({ workspaceId: scmRepositories.workspaceId })
      .from(scmRepositories)
      .where(
        and(
          eq(scmRepositories.provider, provider),
          eq(scmRepositories.fullName, fullName),
          eq(scmRepositories.active, true),
        ),
      )
      .limit(1);
    return repo ? { workspaceId: repo.workspaceId } : null;
  }

  // ── Backfill ───────────────────────────────────────────────────────────────

  async getRepositoryForBackfill(id: string): Promise<{
    id: string;
    workspaceId: string;
    provider: ScmProvider;
    fullName: string;
    installationId: string | null;
  } | null> {
    const [repo] = await this.db
      .select()
      .from(scmRepositories)
      .where(eq(scmRepositories.id, id))
      .limit(1);
    if (!repo) return null;
    return {
      id: repo.id,
      workspaceId: repo.workspaceId,
      provider: repo.provider,
      fullName: repo.fullName,
      installationId: repo.installationId,
    };
  }

  async setInstallationId(id: string, installationId: string): Promise<void> {
    await this.db
      .update(scmRepositories)
      .set({ installationId, updatedAt: new Date() })
      .where(eq(scmRepositories.id, id));
  }

  async enqueueBackfill(workspaceId: string, repositoryId: string): Promise<void> {
    await this.db.insert(scmBackfillJobs).values({ workspaceId, repositoryId });
  }

  // ── Work-item resolution ──────────────────────────────────────────────────

  async resolveWorkItemId(itemKey: string, workspaceId: string): Promise<string | null> {
    // Workspace-unique keys (Rally FormattedID): (itemKey, workspaceId) resolves a
    // single work item — no projectId needed, which is what makes linking org-level.
    const [row] = await this.db
      .select({ id: workItems.id })
      .from(workItems)
      .where(
        and(
          eq(workItems.itemKey, itemKey),
          eq(workItems.workspaceId, workspaceId),
          isNull(workItems.deletedAt),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  }

  // ── Webhook inbox ───────────────────────────────────────────────────────────

  async insertInboxEvent(row: {
    provider: ScmProvider;
    deliveryId: string;
    eventType: string;
    payload: unknown;
  }): Promise<{ inserted: boolean }> {
    const inserted = await this.db
      .insert(scmWebhookInbox)
      .values({
        provider: row.provider,
        deliveryId: row.deliveryId,
        eventType: row.eventType,
        payload: row.payload,
      })
      .onConflictDoNothing({ target: [scmWebhookInbox.provider, scmWebhookInbox.deliveryId] })
      .returning({ id: scmWebhookInbox.id });
    return { inserted: inserted.length > 0 };
  }

  // ── Links (idempotent upserts) ───────────────────────────────────────────────

  async upsertConnection(input: UpsertConnectionInput): Promise<void> {
    await this.db
      .insert(scmConnections)
      .values(input)
      .onConflictDoUpdate({
        target: [scmConnections.workItemId, scmConnections.externalId],
        // PR edits/merges update the mutable fields; identity stays.
        set: {
          name: input.name,
          url: input.url,
          state: input.state,
          authorName: input.authorName,
          updatedAt: new Date(),
        },
      });
  }

  async upsertChangeset(input: UpsertChangesetInput): Promise<void> {
    await this.db
      .insert(scmChangesets)
      .values(input)
      // Commits are immutable — first write wins, redelivery is a no-op.
      .onConflictDoNothing({
        target: [scmChangesets.workItemId, scmChangesets.revision],
      });
  }

  async listConnections(
    workItemId: string,
    workspaceId: string,
    args: PageArgs,
  ): Promise<PagedResult<ScmConnection>> {
    const conditions = [
      eq(scmConnections.workItemId, workItemId),
      eq(scmConnections.workspaceId, workspaceId),
    ];
    if (args.cursor)
      conditions.push(keysetCondition(scmConnections.createdAt, scmConnections.id, args.cursor));
    const rows = await this.db
      .select()
      .from(scmConnections)
      .where(and(...conditions))
      .orderBy(desc(scmConnections.createdAt), asc(scmConnections.id))
      .limit(args.limit + 1);
    return buildPageResult(
      rows.map(this.toConnection),
      args.limit,
      (c) => [c.createdAt.toISOString()],
      'desc',
    );
  }

  async listChangesets(
    workItemId: string,
    workspaceId: string,
    args: PageArgs,
  ): Promise<PagedResult<ScmChangeset>> {
    const conditions = [
      eq(scmChangesets.workItemId, workItemId),
      eq(scmChangesets.workspaceId, workspaceId),
    ];
    if (args.cursor)
      conditions.push(keysetCondition(scmChangesets.createdAt, scmChangesets.id, args.cursor));
    const rows = await this.db
      .select()
      .from(scmChangesets)
      .where(and(...conditions))
      .orderBy(desc(scmChangesets.createdAt), asc(scmChangesets.id))
      .limit(args.limit + 1);
    return buildPageResult(
      rows.map(this.toChangeset),
      args.limit,
      (c) => [c.createdAt.toISOString()],
      'desc',
    );
  }

  // ── Row mappers ─────────────────────────────────────────────────────────────

  private toRepository(r: typeof scmRepositories.$inferSelect): ScmRepository {
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      provider: r.provider,
      fullName: r.fullName,
      baseUrl: r.baseUrl,
      active: r.active,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  private toConnection = (r: typeof scmConnections.$inferSelect): ScmConnection => ({
    id: r.id,
    workspaceId: r.workspaceId,
    workItemId: r.workItemId,
    provider: r.provider,
    type: r.type,
    externalId: r.externalId,
    name: r.name,
    url: r.url,
    state: r.state,
    authorName: r.authorName,
    sourceCreatedAt: r.sourceCreatedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });

  private toChangeset = (r: typeof scmChangesets.$inferSelect): ScmChangeset => ({
    id: r.id,
    workspaceId: r.workspaceId,
    workItemId: r.workItemId,
    provider: r.provider,
    revision: r.revision,
    name: r.name,
    message: r.message,
    uri: r.uri,
    authorName: r.authorName,
    authorEmail: r.authorEmail,
    committedAt: r.committedAt,
    changes: r.changes ?? [],
    repositoryFullName: r.repositoryFullName,
    createdAt: r.createdAt,
  });
}
