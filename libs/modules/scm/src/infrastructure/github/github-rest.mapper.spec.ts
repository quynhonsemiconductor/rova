import { describe, it, expect } from 'vitest';
import { mapRestPullRequest, mapRestCommit } from './github-rest.mapper';
import type { GhRestPull, GhRestCommitListItem, GhRestCommitFile } from './github-rest.client';

describe('mapRestPullRequest', () => {
  const base: GhRestPull = {
    number: 42,
    title: 'fix(US-1): patch',
    body: null,
    html_url: 'https://github.com/acme/demo/pull/42',
    state: 'open',
    merged_at: null,
    created_at: '2026-07-24T10:00:00Z',
    user: { login: 'octocat' },
    head: { ref: 'US-1-branch' },
  };

  it('normalizes a PR to the SAME shape as the webhook parser', () => {
    expect(mapRestPullRequest(base, 'acme/demo')).toMatchObject({
      kind: 'pull_request',
      repositoryFullName: 'acme/demo',
      externalId: 'acme/demo#42',
      title: 'fix(US-1): patch',
      state: 'open',
      authorName: 'octocat',
      keys: ['US-1'],
    });
  });

  it('reports merged state from merged_at', () => {
    const pr = mapRestPullRequest(
      { ...base, state: 'closed', merged_at: '2026-07-24T11:00:00Z' },
      'acme/demo',
    );
    expect(pr?.state).toBe('merged');
  });

  it('picks keys up from the branch when the title has none', () => {
    const pr = mapRestPullRequest({ ...base, title: 'no key here' }, 'acme/demo');
    expect(pr?.keys).toEqual(['US-1']);
  });

  it('returns null when neither title nor branch reference a key', () => {
    expect(
      mapRestPullRequest({ ...base, title: 'no key', head: { ref: 'x' } }, 'acme/demo'),
    ).toBeNull();
  });

  it('picks keys up from the description when title and branch have none', () => {
    const pr = mapRestPullRequest(
      { ...base, title: 'no key', head: { ref: 'x' }, body: 'Implements US-162.' },
      'acme/demo',
    );
    expect(pr?.keys).toEqual(['US-162']);
  });

  it('does not read a bot PR description, but keeps title and branch keys', () => {
    const pr = mapRestPullRequest(
      {
        ...base,
        user: { login: 'release-please[bot]', type: 'Bot' },
        body: 'Release notes for DE-7',
      },
      'acme/demo',
    );
    expect(pr?.keys).toEqual(['US-1']);
  });

  it('returns null for a bot PR whose only keys are in the description', () => {
    expect(
      mapRestPullRequest(
        {
          ...base,
          title: 'chore(main): release 0.9.0',
          head: { ref: 'release-please--branches--main' },
          user: { login: 'release-please[bot]', type: 'Bot' },
          body: 'Includes DE-7.',
        },
        'acme/demo',
      ),
    ).toBeNull();
  });

  it('matches description keys inside code blocks and URLs, and ignores unknown keys', () => {
    const pr = mapRestPullRequest(
      {
        ...base,
        title: 'no key',
        head: { ref: 'x' },
        body: '`DE-3` and https://tracker.acme.dev/items/TA-4 and XX-9',
      },
      'acme/demo',
    );
    expect(pr?.keys).toEqual(['DE-3', 'TA-4']);
  });

  it('tolerates a null author', () => {
    expect(mapRestPullRequest({ ...base, user: null }, 'acme/demo')?.authorName).toBeNull();
  });
});

describe('mapRestCommit', () => {
  const base: GhRestCommitListItem = {
    sha: '5fda056ac289def3f2aa11',
    html_url: 'https://github.com/acme/demo/commit/5fda056a',
    commit: {
      message: 'fix(US-1): patch the thing',
      author: { name: 'Bao Gia Ha', email: 'bao@acme.dev', date: '2026-07-24T10:05:00Z' },
    },
  };
  const files: GhRestCommitFile[] = [
    { filename: 'src/new.ts', status: 'added' },
    { filename: 'src/a.ts', status: 'modified' },
    { filename: 'src/r.ts', status: 'renamed' },
    { filename: 'src/old.ts', status: 'removed' },
    { filename: 'src/c.ts', status: 'copied' },
    { filename: 'src/x.ts', status: 'weird' },
  ];

  it('normalizes a commit, short-shas the name, and maps file actions A/M/D', () => {
    const c = mapRestCommit(base, 'acme/demo', files);
    expect(c).toMatchObject({
      kind: 'commit',
      repositoryFullName: 'acme/demo',
      revision: '5fda056ac289def3f2aa11',
      shortName: 'demo:5fda056a',
      authorName: 'Bao Gia Ha',
      authorEmail: 'bao@acme.dev',
      keys: ['US-1'],
    });
    expect(c?.changes).toEqual([
      { action: 'A', path: 'src/new.ts' },
      { action: 'M', path: 'src/a.ts' },
      { action: 'M', path: 'src/r.ts' },
      { action: 'D', path: 'src/old.ts' },
      { action: 'A', path: 'src/c.ts' },
      { action: 'M', path: 'src/x.ts' }, // unknown status defaults to M
    ]);
  });

  it('returns null when the message references no key', () => {
    expect(
      mapRestCommit(
        { ...base, commit: { ...base.commit, message: 'chore: nothing' } },
        'acme/demo',
        [],
      ),
    ).toBeNull();
  });
});
