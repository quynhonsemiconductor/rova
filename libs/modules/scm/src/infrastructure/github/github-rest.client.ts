/**
 * Minimal GitHub REST client for backfill — authenticated with an installation
 * access token. Bounded (page caps) so a huge repo can't run away or exhaust the
 * 5k/hr rate limit. Only the fields the mapper reads are typed.
 */

export interface GhRestPull {
  number: number;
  title: string;
  html_url: string;
  state: string;
  merged_at: string | null;
  created_at: string;
  user: { login: string } | null;
  head: { ref: string } | null;
}

export interface GhRestCommitListItem {
  sha: string;
  html_url: string;
  commit: { message: string; author: { name?: string; email?: string; date?: string } | null };
}

export interface GhRestCommitFile {
  filename: string;
  status: string; // added | modified | removed | renamed | copied | changed
}

import { RetryAfterError, retryAfterMsFrom } from '@platform';
import { githubCallSignal } from './github-http';

/** The wait GitHub asks for on a 403/429 rate limit (primary or secondary), or undefined when this is not one. */
export function rateLimitWaitMs(res: Response): number | undefined {
  if (res.status !== 403 && res.status !== 429) return undefined;
  return retryAfterMsFrom(res.headers);
}

export class GithubRestClient {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly token: string,
    /** Cancels the call in flight when the caller's run budget is spent. Every call also has its own deadline. */
    private readonly signal?: AbortSignal,
  ) {}

  /**
   * Active repos the installation can access (owner/name), paginated. Archived
   * and disabled repos are skipped: they never emit new PRs/commits, so they'd
   * sit as permanently-unsynced rows and waste a backfill each on discovery.
   */
  async listInstallationRepositories({
    perPage = 100,
    maxPages = 20,
  }: { perPage?: number; maxPages?: number } = {}): Promise<string[]> {
    const out: string[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const body = await this.get<{
        repositories?: Array<{ full_name: string; archived?: boolean; disabled?: boolean }>;
      }>(`/installation/repositories?per_page=${perPage}&page=${page}`);
      const batch = body.repositories ?? [];
      out.push(...batch.filter((r) => !r.archived && !r.disabled).map((r) => r.full_name));
      if (batch.length < perPage) break;
    }
    return out;
  }

  /** Recent PRs (all states), newest first. Capped by maxPages × perPage. */
  async listPullRequests(
    fullName: string,
    { perPage = 100, maxPages = 1 }: { perPage?: number; maxPages?: number } = {},
  ): Promise<GhRestPull[]> {
    const [owner, repo] = fullName.split('/');
    const out: GhRestPull[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.get<GhRestPull[]>(
        `/repos/${owner}/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${perPage}&page=${page}`,
      );
      out.push(...batch);
      if (batch.length < perPage) break;
    }
    return out;
  }

  /** Commits since a date, newest first. Capped by maxPages × perPage. */
  async listCommits(
    fullName: string,
    {
      since,
      perPage = 100,
      maxPages = 3,
    }: { since?: string; perPage?: number; maxPages?: number } = {},
  ): Promise<GhRestCommitListItem[]> {
    const [owner, repo] = fullName.split('/');
    const sinceQ = since ? `&since=${encodeURIComponent(since)}` : '';
    const out: GhRestCommitListItem[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.get<GhRestCommitListItem[]>(
        `/repos/${owner}/${repo}/commits?per_page=${perPage}&page=${page}${sinceQ}`,
      );
      out.push(...batch);
      if (batch.length < perPage) break;
    }
    return out;
  }

  /** File list for one commit (only fetched for commits that reference a key). */
  async getCommitFiles(fullName: string, sha: string): Promise<GhRestCommitFile[]> {
    const [owner, repo] = fullName.split('/');
    const body = await this.get<{ files?: GhRestCommitFile[] }>(
      `/repos/${owner}/${repo}/commits/${sha}`,
    );
    return body.files ?? [];
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.apiBaseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: githubCallSignal(this.signal),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const message = `GitHub REST GET ${path} failed (${res.status}): ${text.slice(0, 200)}`;
      // A rate limit says how long to wait: back the job off for that long, not for the 30 s curve.
      const wait = rateLimitWaitMs(res);
      if (wait !== undefined) throw new RetryAfterError(message, wait);
      throw new Error(message);
    }
    return (await res.json()) as T;
  }
}
