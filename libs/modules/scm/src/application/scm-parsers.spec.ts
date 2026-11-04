import { describe, it, expect } from 'vitest';
import { extractWorkItemKeys } from './scm-key-parser';
import {
  parsePullRequestEvent,
  parsePushEvent,
  parseInstallationEvent,
  parseInstallationRepositoriesEvent,
  parseRepositoryEvent,
} from './github-webhook.parser';

describe('extractWorkItemKeys', () => {
  it('finds keys across title, branch and message; de-dups and upper-cases', () => {
    expect(extractWorkItemKeys('fix(US-1): thing', 'us-1-branch', 'also DE-42')).toEqual([
      'US-1',
      'DE-42',
    ]);
  });

  it('matches every type prefix and ignores non-keys', () => {
    expect(extractWorkItemKeys('IN-1 FE-2 US-3 TA-4 DE-5 XX-6 US- 7')).toEqual([
      'IN-1',
      'FE-2',
      'US-3',
      'TA-4',
      'DE-5',
    ]);
  });

  it('returns [] when nothing matches or inputs are empty', () => {
    expect(extractWorkItemKeys('no keys here', null, undefined)).toEqual([]);
  });
});

describe('parsePullRequestEvent', () => {
  const base = {
    action: 'opened',
    pull_request: {
      number: 42,
      title: 'fix(US-1): patch',
      body: null as string | null,
      html_url: 'https://ghe/acme/demo/pull/42',
      state: 'open',
      merged: false,
      created_at: '2026-07-24T10:00:00Z',
      user: { login: 'octocat' },
      head: { ref: 'US-1-branch' },
    },
    repository: { full_name: 'acme/demo' },
  };

  it('normalizes a PR and extracts its keys + externalId', () => {
    const pr = parsePullRequestEvent(base);
    expect(pr).toMatchObject({
      kind: 'pull_request',
      repositoryFullName: 'acme/demo',
      externalId: 'acme/demo#42',
      state: 'open',
      authorName: 'octocat',
      keys: ['US-1'],
    });
  });

  it('reports merged state', () => {
    const pr = parsePullRequestEvent({
      ...base,
      pull_request: { ...base.pull_request, merged: true, state: 'closed' },
    });
    expect(pr?.state).toBe('merged');
  });

  it('ignores unhandled actions and PRs with no key', () => {
    expect(parsePullRequestEvent({ ...base, action: 'labeled' })).toBeNull();
    expect(
      parsePullRequestEvent({
        ...base,
        pull_request: { ...base.pull_request, title: 'no key', head: { ref: 'x' } },
      }),
    ).toBeNull();
  });

  it('links a key named only in the PR description', () => {
    const pr = parsePullRequestEvent({
      ...base,
      pull_request: {
        ...base.pull_request,
        title: 'no key in title',
        head: { ref: 'feature/x' },
        body: 'Implements US-162 for the training portal.',
      },
    });
    expect(pr?.keys).toEqual(['US-162']);
  });

  it('merges title/body/branch keys with one de-dupe', () => {
    const pr = parsePullRequestEvent({
      ...base,
      pull_request: {
        ...base.pull_request,
        body: 'Also closes DE-7 and us-1.',
      },
    });
    expect(pr?.keys).toEqual(['US-1', 'DE-7']);
  });

  it('re-links on an edited body that names a new key', () => {
    const pr = parsePullRequestEvent({
      ...base,
      action: 'edited',
      pull_request: {
        ...base.pull_request,
        title: 'no key in title',
        head: { ref: 'feature/x' },
        body: 'Fixes US-5',
      },
    });
    expect(pr?.keys).toEqual(['US-5']);
  });

  it('matches keys inside code blocks and URLs in the body, like the title', () => {
    const pr = parsePullRequestEvent({
      ...base,
      pull_request: {
        ...base.pull_request,
        title: 'no key in title',
        head: { ref: 'feature/x' },
        body: '```\nUS-8\n```\nSee https://tracker.acme.dev/items/TA-9.',
      },
    });
    expect(pr?.keys).toEqual(['US-8', 'TA-9']);
  });

  it('ignores key-shaped text with an unknown prefix or a missing number', () => {
    const pr = parsePullRequestEvent({
      ...base,
      pull_request: {
        ...base.pull_request,
        title: 'no key in title',
        head: { ref: 'feature/x' },
        body: 'Refs XX-6 and US- and USE-4.',
      },
    });
    expect(pr).toBeNull();
  });
});

describe('parsePushEvent', () => {
  it('normalizes commits, maps A/M/D changes, and skips key-less commits', () => {
    const commits = parsePushEvent({
      ref: 'refs/heads/US-1-branch',
      repository: { full_name: 'acme/demo' },
      commits: [
        {
          id: '5fda056ac289def3f2',
          message: 'fix(US-1): patch the thing',
          timestamp: '2026-07-24T10:05:00Z',
          url: 'https://ghe/acme/demo/commit/5fda056a',
          author: { name: 'Bao Gia Ha', email: 'bao@acme.dev' },
          added: ['src/new.ts'],
          modified: ['src/a.ts'],
          removed: ['src/old.ts'],
        },
        { id: 'deadbeef', message: 'chore: no key', added: [], modified: [], removed: [] },
      ],
    });
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      kind: 'commit',
      revision: '5fda056ac289def3f2',
      shortName: 'demo:5fda056a',
      authorName: 'Bao Gia Ha',
      keys: ['US-1'],
    });
    expect(commits[0].changes).toEqual([
      { action: 'A', path: 'src/new.ts' },
      { action: 'M', path: 'src/a.ts' },
      { action: 'D', path: 'src/old.ts' },
    ]);
  });

  it('returns [] when repository or commits are missing', () => {
    expect(parsePushEvent({ commits: [] })).toEqual([]);
    expect(parsePushEvent({ repository: { full_name: 'acme/demo' } })).toEqual([]);
  });
});

describe('parseInstallationEvent', () => {
  it('extracts action, id (as string), account, and repositories', () => {
    expect(
      parseInstallationEvent({
        action: 'created',
        installation: { id: 42, account: { login: 'acme', type: 'Organization' } },
        repositories: [{ full_name: 'acme/api' }, { full_name: 'acme/web' }],
      }),
    ).toEqual({
      action: 'created',
      installationId: '42',
      accountLogin: 'acme',
      accountType: 'Organization',
      repositories: ['acme/api', 'acme/web'],
    });
  });

  it('returns null without a numeric installation id or action', () => {
    expect(parseInstallationEvent({ action: 'created' })).toBeNull();
    expect(parseInstallationEvent({ installation: { id: 42 } })).toBeNull();
  });
});

describe('parseInstallationRepositoriesEvent', () => {
  it('splits added/removed repositories', () => {
    expect(
      parseInstallationRepositoriesEvent({
        action: 'added',
        installation: { id: 7 },
        repositories_added: [{ full_name: 'acme/new' }],
        repositories_removed: [{ full_name: 'acme/old' }],
      }),
    ).toEqual({
      action: 'added',
      installationId: '7',
      added: ['acme/new'],
      removed: ['acme/old'],
    });
  });

  it('returns null when the installation id is missing', () => {
    expect(parseInstallationRepositoriesEvent({ action: 'added' })).toBeNull();
  });
});

describe('parseRepositoryEvent', () => {
  it('extracts action, id, full name, and archived flag', () => {
    expect(
      parseRepositoryEvent({
        action: 'archived',
        installation: { id: 42 },
        repository: { full_name: 'acme/api', archived: true },
      }),
    ).toEqual({ action: 'archived', installationId: '42', fullName: 'acme/api', archived: true });
  });

  it('returns null without a numeric id, action, or repository full name', () => {
    expect(parseRepositoryEvent({ action: 'archived', installation: { id: 42 } })).toBeNull();
    expect(
      parseRepositoryEvent({ installation: { id: 42 }, repository: { full_name: 'a/b' } }),
    ).toBeNull();
    expect(
      parseRepositoryEvent({ action: 'archived', repository: { full_name: 'a/b' } }),
    ).toBeNull();
  });
});
