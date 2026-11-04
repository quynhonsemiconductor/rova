/**
 * GitHub / GitHub-Enterprise webhook payload → provider-agnostic normalized
 * artifacts. Pure functions (no I/O) so they're trivially unit-testable.
 *
 * We only consume `pull_request` and `push`. Payload shapes are typed minimally
 * (just the fields we read) rather than importing GitHub's full types.
 */
import { extractWorkItemKeys, repoShortName } from './scm-key-parser';
import type { NormalizedPullRequest, NormalizedCommit, ScmChange } from '../domain/scm.types';

interface GhPullRequestPayload {
  action?: string;
  pull_request?: {
    number?: number;
    title?: string;
    body?: string | null;
    html_url?: string;
    state?: string;
    merged?: boolean;
    created_at?: string;
    user?: { login?: string; type?: string };
    head?: { ref?: string };
  };
  repository?: { full_name?: string };
}

interface GhPushCommit {
  id?: string;
  message?: string;
  timestamp?: string;
  url?: string;
  author?: { name?: string; email?: string; username?: string };
  added?: string[];
  modified?: string[];
  removed?: string[];
}
interface GhPushPayload {
  ref?: string;
  repository?: { full_name?: string };
  commits?: GhPushCommit[];
}

/** PR actions worth ingesting (open/update/close lifecycle). */
const PR_ACTIONS = new Set([
  'opened',
  'edited',
  'synchronize',
  'reopened',
  'closed',
  'ready_for_review',
]);

export function parsePullRequestEvent(payload: unknown): NormalizedPullRequest | null {
  const p = payload as GhPullRequestPayload;
  if (p.action && !PR_ACTIONS.has(p.action)) return null;
  const pr = p.pull_request;
  const fullName = p.repository?.full_name;
  if (!pr || !fullName || typeof pr.number !== 'number' || !pr.title || !pr.html_url) return null;

  // A bot's description is generated, not written for the item it changes:
  // release-please lists every key in the release and rewrites the body on each
  // push, which would link the release PR to the whole release. Title and branch
  // are still parsed — they name the one item the change is for.
  const body = pr.user?.type === 'Bot' ? null : pr.body;
  const keys = extractWorkItemKeys(pr.title, pr.head?.ref, body);
  if (keys.length === 0) return null; // nothing to link

  const state = pr.merged ? 'merged' : (pr.state ?? 'open');
  return {
    kind: 'pull_request',
    repositoryFullName: fullName,
    externalId: `${fullName}#${pr.number}`,
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    state,
    authorName: pr.user?.login ?? null,
    createdAt: pr.created_at ?? null,
    keys,
  };
}

export function parsePushEvent(payload: unknown): NormalizedCommit[] {
  const p = payload as GhPushPayload;
  const fullName = p.repository?.full_name;
  const commits = p.commits;
  if (!fullName || !Array.isArray(commits)) return [];

  const out: NormalizedCommit[] = [];
  for (const c of commits) {
    if (!c.id || !c.message) continue;
    const keys = extractWorkItemKeys(c.message);
    if (keys.length === 0) continue;

    const changes: ScmChange[] = [
      ...(c.added ?? []).map((path) => ({ action: 'A' as const, path })),
      ...(c.modified ?? []).map((path) => ({ action: 'M' as const, path })),
      ...(c.removed ?? []).map((path) => ({ action: 'D' as const, path })),
    ];
    out.push({
      kind: 'commit',
      repositoryFullName: fullName,
      revision: c.id,
      shortName: `${repoShortName(fullName)}:${c.id.slice(0, 8)}`,
      message: c.message,
      uri: c.url ?? '',
      authorName: c.author?.name ?? c.author?.username ?? null,
      authorEmail: c.author?.email ?? null,
      committedAt: c.timestamp ?? null,
      changes,
      keys,
    });
  }
  return out;
}

// ── Installation management events (org-level auto-discovery) ────────────────

interface GhInstallationPayload {
  action?: string;
  installation?: {
    id?: number;
    account?: { login?: string; type?: string } | null;
  };
  repositories?: Array<{ full_name?: string }>;
  repositories_added?: Array<{ full_name?: string }>;
  repositories_removed?: Array<{ full_name?: string }>;
}

export interface InstallationEvent {
  action: string;
  installationId: string;
  accountLogin: string | null;
  accountType: string | null;
  /** Repos present at install time (`installation` event only). */
  repositories: string[];
}

export function parseInstallationEvent(payload: unknown): InstallationEvent | null {
  const p = payload as GhInstallationPayload;
  const id = p.installation?.id;
  if (typeof id !== 'number' || !p.action) return null;
  return {
    action: p.action,
    installationId: String(id),
    accountLogin: p.installation?.account?.login ?? null,
    accountType: p.installation?.account?.type ?? null,
    repositories: (p.repositories ?? []).map((r) => r.full_name).filter((n): n is string => !!n),
  };
}

export interface InstallationReposEvent {
  action: string;
  installationId: string;
  added: string[];
  removed: string[];
}

export function parseInstallationRepositoriesEvent(
  payload: unknown,
): InstallationReposEvent | null {
  const p = payload as GhInstallationPayload;
  const id = p.installation?.id;
  if (typeof id !== 'number' || !p.action) return null;
  const names = (a?: Array<{ full_name?: string }>) =>
    (a ?? []).map((r) => r.full_name).filter((n): n is string => !!n);
  return {
    action: p.action,
    installationId: String(id),
    added: names(p.repositories_added),
    removed: names(p.repositories_removed),
  };
}

export interface RepositoryEvent {
  action: string;
  installationId: string;
  fullName: string;
  archived: boolean;
}

/**
 * `repository` event — a repo was archived/unarchived/deleted/renamed after
 * discovery. Lets us drop a repo that gets archived later (no more events come
 * from it) and re-add one that is unarchived.
 */
export function parseRepositoryEvent(payload: unknown): RepositoryEvent | null {
  const p = payload as GhInstallationPayload & {
    repository?: { full_name?: string; archived?: boolean };
  };
  const id = p.installation?.id;
  const fullName = p.repository?.full_name;
  if (typeof id !== 'number' || !p.action || !fullName) return null;
  return {
    action: p.action,
    installationId: String(id),
    fullName,
    archived: !!p.repository?.archived,
  };
}
