import { describe, it, expect, beforeEach } from 'vitest';
import { ScmLinkerService, MAX_KEYS_PER_PULL_REQUEST } from './scm-linker.service';
import type { IScmStore } from '../domain/ports/scm.store';
import type { UpsertConnectionInput, ScmProvider } from '../domain/scm.types';

/** Work items by workspace, so a key in another workspace must not resolve. */
const WORK_ITEMS: Record<string, Record<string, string>> = {
  'ws-1': {
    'US-162': 'wi-162',
    'US-5': 'wi-5',
    'DE-7': 'wi-7',
    'TA-1': 'wi-ta-1',
    ...Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`US-${i + 1}`, `wi-${i + 1}`] as const),
    ),
  },
  'ws-other': { 'US-162': 'wi-other-162', 'US-777': 'wi-other-777' },
};

function pullRequestPayload(
  body: string | null,
  {
    action = 'opened',
    title = 'no key in title',
    branch = 'feature/x',
    repo = 'acme/demo',
    user = { login: 'octocat', type: 'User' },
  }: {
    action?: string;
    title?: string;
    branch?: string;
    repo?: string;
    user?: { login: string; type?: string };
  } = {},
) {
  return {
    action,
    pull_request: {
      number: 84,
      title,
      body,
      html_url: `https://github.com/${repo}/pull/84`,
      state: 'open',
      merged: false,
      created_at: '2026-11-04T09:00:00Z',
      user,
      head: { ref: branch },
    },
    repository: { full_name: repo },
  };
}

describe('ScmLinkerService — keys named only in the PR description', () => {
  let store: IScmStore;
  /** The connection rows a real upsert would leave behind, keyed as the DB is. */
  let rows: Map<string, UpsertConnectionInput>;
  let resolveCalls: string[][];

  beforeEach(() => {
    rows = new Map();
    resolveCalls = [];
    store = {
      findRepository: async (_provider: ScmProvider, fullName: string) => ({
        workspaceId: fullName === 'acme/other' ? 'ws-other' : 'ws-1',
      }),
      resolveWorkItemIds: async (keys: string[], workspaceId: string) => {
        resolveCalls.push(keys);
        const known = WORK_ITEMS[workspaceId] ?? {};
        return new Map(keys.filter((key) => known[key]).map((key) => [key, known[key]] as const));
      },
      upsertConnection: async (input: UpsertConnectionInput) => {
        rows.set(`${input.workItemId}|${input.externalId}`, input);
      },
    } as unknown as IScmStore;
  });

  const linker = () => new ScmLinkerService(store);

  const workItemIds = () => [...rows.values()].map((row) => row.workItemId).sort();

  it('links a work item named only in the body', async () => {
    const outcome = await linker().linkEvent(
      'github',
      'pull_request',
      pullRequestPayload('Implements US-162 for the training portal.'),
    );

    expect(outcome).toBe('processed');
    expect(rows.size).toBe(1);
    expect([...rows.values()][0]).toMatchObject({
      workItemId: 'wi-162',
      externalId: 'acme/demo#84',
    });
  });

  it('an edited body adds the new link and keeps the earlier one', async () => {
    await linker().linkEvent('github', 'pull_request', pullRequestPayload('Implements US-5.'));
    await linker().linkEvent(
      'github',
      'pull_request',
      pullRequestPayload('Implements US-5 and unblocks DE-7.', { action: 'edited' }),
    );

    expect(workItemIds()).toEqual(['wi-5', 'wi-7']);
  });

  it('an edited event with an unchanged body creates no new connection row', async () => {
    const payload = pullRequestPayload('Implements US-5.');
    await linker().linkEvent('github', 'pull_request', payload);
    await linker().linkEvent('github', 'pull_request', { ...payload, action: 'edited' });

    expect(rows.size).toBe(1);
    expect(workItemIds()).toEqual(['wi-5']);
  });

  it('does not resolve a key that belongs to another workspace', async () => {
    // US-777 exists only in ws-other; this repo resolves to ws-1.
    const outcome = await linker().linkEvent(
      'github',
      'pull_request',
      pullRequestPayload('Implements US-777.'),
    );

    expect(outcome).toBe('ignored');
    expect(rows.size).toBe(0);
    expect(resolveCalls).toEqual([['US-777']]);
  });

  it('ignores a key that resolves to no work item and still links the known one', async () => {
    const outcome = await linker().linkEvent(
      'github',
      'pull_request',
      pullRequestPayload('Refs US-999 and US-162.'),
    );

    expect(outcome).toBe('processed');
    expect(workItemIds()).toEqual(['wi-162']);
  });

  it('ignores a PR whose body names no key', async () => {
    const outcome = await linker().linkEvent(
      'github',
      'pull_request',
      pullRequestPayload('No keys at all.'),
    );

    expect(outcome).toBe('ignored');
    expect(rows.size).toBe(0);
  });

  it('does not link a bot PR by its body', async () => {
    const outcome = await linker().linkEvent(
      'github',
      'pull_request',
      pullRequestPayload('Release notes for US-5 and DE-7.', {
        title: 'chore(main): release 0.9.0',
        branch: 'release-please--branches--main',
        user: { login: 'release-please[bot]', type: 'Bot' },
      }),
    );

    expect(outcome).toBe('ignored');
    expect(rows.size).toBe(0);
  });

  it('caps a PR at MAX_KEYS_PER_PULL_REQUEST distinct keys in ONE resolution query', async () => {
    const body = Array.from({ length: 60 }, (_, i) => `US-${i + 1}`).join(' ');
    const outcome = await linker().linkEvent('github', 'pull_request', pullRequestPayload(body));

    expect(outcome).toBe('processed');
    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0]).toHaveLength(MAX_KEYS_PER_PULL_REQUEST);
    expect(rows.size).toBe(MAX_KEYS_PER_PULL_REQUEST);
  });

  it('keeps the title key ahead of the body keys when it caps', async () => {
    const body = Array.from({ length: 60 }, (_, i) => `US-${i + 1}`).join(' ');
    await linker().linkEvent(
      'github',
      'pull_request',
      pullRequestPayload(body, { title: 'fix(TA-1): capped' }),
    );

    expect(resolveCalls[0][0]).toBe('TA-1');
    expect(resolveCalls[0]).toHaveLength(MAX_KEYS_PER_PULL_REQUEST);
    expect(workItemIds()).toContain('wi-ta-1');
  });
});
