/**
 * Map GitHub REST responses (backfill) to the SAME normalized shapes the webhook
 * parser produces, so both feed the one idempotent linker.
 */
import { extractWorkItemKeys, repoShortName } from '../../application/scm-key-parser';
import type { NormalizedPullRequest, NormalizedCommit, ScmChange } from '../../domain/scm.types';
import type { GhRestPull, GhRestCommitListItem, GhRestCommitFile } from './github-rest.client';

const FILE_ACTION: Record<string, ScmChange['action']> = {
  added: 'A',
  removed: 'D',
  modified: 'M',
  renamed: 'M',
  changed: 'M',
  copied: 'A',
};

export function mapRestPullRequest(pr: GhRestPull, fullName: string): NormalizedPullRequest | null {
  // Same rule as the webhook parser: a bot's description is generated, so only
  // its title and branch may link it.
  const body = pr.user?.type === 'Bot' ? null : pr.body;
  const keys = extractWorkItemKeys(pr.title, pr.head?.ref, body);
  if (keys.length === 0) return null;
  return {
    kind: 'pull_request',
    repositoryFullName: fullName,
    externalId: `${fullName}#${pr.number}`,
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    state: pr.merged_at ? 'merged' : pr.state,
    authorName: pr.user?.login ?? null,
    createdAt: pr.created_at ?? null,
    keys,
  };
}

export function mapRestCommit(
  c: GhRestCommitListItem,
  fullName: string,
  files: GhRestCommitFile[],
): NormalizedCommit | null {
  const message = c.commit?.message ?? '';
  const keys = extractWorkItemKeys(message);
  if (keys.length === 0) return null;
  return {
    kind: 'commit',
    repositoryFullName: fullName,
    revision: c.sha,
    shortName: `${repoShortName(fullName)}:${c.sha.slice(0, 8)}`,
    message,
    uri: c.html_url,
    authorName: c.commit?.author?.name ?? null,
    authorEmail: c.commit?.author?.email ?? null,
    committedAt: c.commit?.author?.date ?? null,
    changes: files.map((f) => ({ action: FILE_ACTION[f.status] ?? 'M', path: f.filename })),
    keys,
  };
}
