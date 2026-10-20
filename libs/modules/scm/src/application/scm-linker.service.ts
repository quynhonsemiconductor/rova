import { Inject, Injectable, Logger } from '@nestjs/common';
import { SCM_STORE, type IScmStore } from '../domain/ports/scm.store';
import type { ScmProvider, NormalizedPullRequest, NormalizedCommit } from '../domain/scm.types';
import { parsePullRequestEvent, parsePushEvent } from './github-webhook.parser';

export type LinkOutcome = 'processed' | 'ignored';

/**
 * Turns a raw webhook event into linked connections/changesets. Called by the
 * worker relay (once per inbox row). Resolution: repo→workspace, then
 * key → work item (keys are workspace-unique, Rally FormattedID), so linking is
 * org-level — no per-project mapping. Upserts are idempotent (unique
 * constraints), so redelivery/retries never duplicate. Workspace is derived from
 * the registered repo, never trusted from the payload.
 */
@Injectable()
export class ScmLinkerService {
  private readonly logger = new Logger(ScmLinkerService.name);

  constructor(@Inject(SCM_STORE) private readonly store: IScmStore) {}

  async linkEvent(
    provider: ScmProvider,
    eventType: string,
    payload: unknown,
  ): Promise<LinkOutcome> {
    if (eventType === 'pull_request') {
      const pr = parsePullRequestEvent(payload);
      return pr ? this.linkPullRequest(provider, pr) : 'ignored';
    }
    if (eventType === 'push') {
      const commits = parsePushEvent(payload);
      let processed = false;
      for (const commit of commits) {
        if ((await this.linkCommit(provider, commit)) === 'processed') processed = true;
      }
      return processed ? 'processed' : 'ignored';
    }
    return 'ignored';
  }

  async linkPullRequest(provider: ScmProvider, pr: NormalizedPullRequest): Promise<LinkOutcome> {
    const repo = await this.store.findRepository(provider, pr.repositoryFullName);
    if (!repo) return this.unmapped(pr.repositoryFullName);
    let linked = false;
    for (const { workItemId } of await this.resolve(repo, pr.keys)) {
      await this.store.upsertConnection({
        workspaceId: repo.workspaceId,
        workItemId,
        provider,
        type: 'pull_request',
        externalId: pr.externalId,
        name: pr.title,
        url: pr.url,
        state: pr.state,
        authorName: pr.authorName,
        sourceCreatedAt: pr.createdAt ? new Date(pr.createdAt) : null,
      });
      linked = true;
    }
    return linked ? 'processed' : 'ignored';
  }

  async linkCommit(provider: ScmProvider, commit: NormalizedCommit): Promise<LinkOutcome> {
    const repo = await this.store.findRepository(provider, commit.repositoryFullName);
    if (!repo) return this.unmapped(commit.repositoryFullName);
    let linked = false;
    for (const { workItemId } of await this.resolve(repo, commit.keys)) {
      await this.store.upsertChangeset({
        workspaceId: repo.workspaceId,
        workItemId,
        provider,
        revision: commit.revision,
        name: commit.shortName,
        message: commit.message,
        uri: commit.uri,
        authorName: commit.authorName,
        authorEmail: commit.authorEmail,
        committedAt: commit.committedAt ? new Date(commit.committedAt) : null,
        changes: commit.changes,
        repositoryFullName: commit.repositoryFullName,
      });
      linked = true;
    }
    return linked ? 'processed' : 'ignored';
  }

  /** Resolve each key to a work item id, workspace-wide (skips misses). */
  private async resolve(
    repo: { workspaceId: string },
    keys: string[],
  ): Promise<Array<{ workItemId: string }>> {
    const out: Array<{ workItemId: string }> = [];
    for (const key of keys) {
      const workItemId = await this.store.resolveWorkItemId(key, repo.workspaceId);
      if (workItemId) out.push({ workItemId });
    }
    return out;
  }

  private unmapped(fullName: string): LinkOutcome {
    this.logger.debug(
      { repository: fullName },
      'SCM event for unmapped/inactive repository — ignoring',
    );
    return 'ignored';
  }
}
