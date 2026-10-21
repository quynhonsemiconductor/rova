import { Inject, Injectable, Logger } from '@nestjs/common';
import { SCM_STORE, type IScmStore } from '../domain/ports/scm.store';
import { ScmLinkerService } from './scm-linker.service';
import { extractWorkItemKeys } from './scm-key-parser';
import { GithubAppAuthService } from '../infrastructure/github/github-app-auth.service';
import { GithubRestClient } from '../infrastructure/github/github-rest.client';
import { mapRestPullRequest, mapRestCommit } from '../infrastructure/github/github-rest.mapper';

export interface BackfillCounts {
  prs: number;
  commits: number;
  connections: number;
  changesets: number;
}

/**
 * The most network time one backfill may spend, in total. A run is at most ~306 GitHub calls (installation
 * lookup, token, one PR page, three commit pages and a file list for each key-referencing commit), which at
 * the per-call deadline could be hours; the budget bounds the whole run instead. A run that hits it is
 * cancelled mid-call and fails as an ordinary retryable error: backfill is idempotent and bounded-recent, so
 * the retry redoes the same work, and a repo that cannot finish within the budget five times in a row
 * dead-letters (with the alarm) instead of holding a lease for hours.
 *
 * The relay's lease is `BACKFILL_RUN_BUDGET_MS` + one call deadline + the lease margin, so it always
 * outlives the run.
 */
export const BACKFILL_RUN_BUDGET_MS = 8 * 60_000;

/** Bounded-recent scope (see plan): ~100 latest PRs + commits from the last 90 days. */
const PR_PAGES = 1;
const COMMIT_PAGES = 3;
const COMMIT_SINCE_DAYS = 90;

/**
 * Pulls a repo's existing PRs + commits via the GitHub App REST API and links
 * the ones that reference work-item keys — the same idempotent upsert path as
 * the webhook relay, so re-running (or overlapping with a webhook) never dups.
 */
@Injectable()
export class ScmBackfillService {
  private readonly logger = new Logger(ScmBackfillService.name);

  constructor(
    @Inject(SCM_STORE) private readonly store: IScmStore,
    private readonly appAuth: GithubAppAuthService,
    private readonly linker: ScmLinkerService,
  ) {}

  async run(
    repositoryId: string,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<BackfillCounts> {
    const counts: BackfillCounts = { prs: 0, commits: 0, connections: 0, changesets: 0 };
    if (!this.appAuth.isConfigured()) {
      this.logger.warn('GitHub App not configured — skipping backfill');
      return counts;
    }

    const repo = await this.store.getRepositoryForBackfill(repositoryId);
    if (!repo) {
      this.logger.warn({ repositoryId }, 'Backfill: repository not found');
      return counts;
    }
    const provider = repo.provider;

    // Resolve + cache the App installation id for this repo.
    let installationId = repo.installationId;
    if (!installationId) {
      installationId = await this.appAuth.resolveInstallationId(repo.fullName, signal);
      await this.store.setInstallationId(repo.id, installationId);
    }
    const token = await this.appAuth.getInstallationToken(installationId, signal);
    const client = new GithubRestClient(this.appAuth.apiBaseUrl, token, signal);

    // ── Pull requests ────────────────────────────────────────────────────────
    const pulls = await client.listPullRequests(repo.fullName, { maxPages: PR_PAGES });
    counts.prs = pulls.length;
    for (const pr of pulls) {
      signal?.throwIfAborted();
      const normalized = mapRestPullRequest(pr, repo.fullName);
      if (!normalized) continue;
      if ((await this.linker.linkPullRequest(provider, normalized)) === 'processed') {
        counts.connections++;
      }
    }

    // ── Commits (only fetch files for key-referencing commits) ────────────────
    const since = new Date(Date.now() - COMMIT_SINCE_DAYS * 86_400_000).toISOString();
    const commits = await client.listCommits(repo.fullName, { since, maxPages: COMMIT_PAGES });
    counts.commits = commits.length;
    for (const commit of commits) {
      signal?.throwIfAborted();
      if (extractWorkItemKeys(commit.commit?.message).length === 0) continue;
      const files = await client.getCommitFiles(repo.fullName, commit.sha);
      const normalized = mapRestCommit(commit, repo.fullName, files);
      if (!normalized) continue;
      if ((await this.linker.linkCommit(provider, normalized)) === 'processed') {
        counts.changesets++;
      }
    }

    this.logger.log({ repositoryId, ...counts }, 'Backfill complete');
    return counts;
  }
}
