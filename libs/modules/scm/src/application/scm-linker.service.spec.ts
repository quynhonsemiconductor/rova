import { describe, it, expect, beforeEach } from 'vitest';
import { ScmLinkerService } from './scm-linker.service';
import type { IScmStore } from '../domain/ports/scm.store';
import type { UpsertConnectionInput } from '../domain/scm.types';

const WORK_ITEMS: Record<string, string> = {
  'US-162': 'wi-162',
  'US-5': 'wi-5',
  'DE-7': 'wi-7',
};

function pullRequestPayload(body: string | null, action = 'opened') {
  return {
    action,
    pull_request: {
      number: 84,
      title: 'no key in title',
      body,
      html_url: 'https://github.com/acme/demo/pull/84',
      state: 'open',
      merged: false,
      created_at: '2026-11-04T09:00:00Z',
      user: { login: 'octocat' },
      head: { ref: 'feature/x' },
    },
    repository: { full_name: 'acme/demo' },
  };
}

describe('ScmLinkerService — keys named only in the PR description', () => {
  let store: IScmStore;
  let connections: UpsertConnectionInput[];
  let linker: ScmLinkerService;

  beforeEach(() => {
    connections = [];
    store = {
      findRepository: async () => ({ workspaceId: 'ws-1' }),
      resolveWorkItemId: async (key: string) => WORK_ITEMS[key] ?? null,
      upsertConnection: async (input: UpsertConnectionInput) => {
        connections.push(input);
      },
    } as unknown as IScmStore;
    linker = new ScmLinkerService(store);
  });

  it('links a work item named only in the body', async () => {
    const outcome = await linker.linkEvent(
      'github',
      'pull_request',
      pullRequestPayload('Implements US-162 for the training portal.'),
    );

    expect(outcome).toBe('processed');
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({ workItemId: 'wi-162', externalId: 'acme/demo#84' });
  });

  it('an edited body adds the new link and keeps the earlier one', async () => {
    await linker.linkEvent('github', 'pull_request', pullRequestPayload('Implements US-5.'));
    await linker.linkEvent(
      'github',
      'pull_request',
      pullRequestPayload('Implements US-5 and unblocks DE-7.', 'edited'),
    );

    expect(connections.map((c) => c.workItemId)).toEqual(['wi-5', 'wi-5', 'wi-7']);
  });

  it('ignores a key that resolves to no work item and still links the known one', async () => {
    const outcome = await linker.linkEvent(
      'github',
      'pull_request',
      pullRequestPayload('Refs US-999 and US-162.'),
    );

    expect(outcome).toBe('processed');
    expect(connections.map((c) => c.workItemId)).toEqual(['wi-162']);
  });

  it('ignores a PR whose body names no key', async () => {
    const outcome = await linker.linkEvent(
      'github',
      'pull_request',
      pullRequestPayload('No keys at all.'),
    );

    expect(outcome).toBe('ignored');
    expect(connections).toEqual([]);
  });
});
