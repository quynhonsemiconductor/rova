import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ScmBackfillService } from './scm-backfill.service';
import type { IScmStore } from '../domain/ports/scm.store';
import type { ScmLinkerService } from './scm-linker.service';
import type { GithubAppAuthService } from '../infrastructure/github/github-app-auth.service';

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => '' } as Response;
}

const KEY_PR = {
  number: 1,
  title: 'fix(US-1): thing',
  html_url: 'https://github.com/acme/demo/pull/1',
  state: 'open',
  merged_at: null,
  created_at: '2026-07-24T10:00:00Z',
  user: { login: 'octocat' },
  head: { ref: 'US-1' },
};
const NOKEY_PR = { ...KEY_PR, number: 2, title: 'chore: nothing', head: { ref: 'x' } };

const KEY_COMMIT = {
  sha: 'abc123def456',
  html_url: 'https://github.com/acme/demo/commit/abc123',
  commit: {
    message: 'fix(US-1): patch',
    author: { name: 'A', email: 'a@x.dev', date: '2026-07-24T10:05:00Z' },
  },
};
const NOKEY_COMMIT = {
  ...KEY_COMMIT,
  sha: 'zzz999',
  commit: { message: 'chore: none', author: null },
};

describe('ScmBackfillService', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let store: IScmStore;
  let appAuth: GithubAppAuthService;
  let linker: ScmLinkerService;
  let svc: ScmBackfillService;

  beforeEach(() => {
    fetchMock = vi.fn((url: string) => {
      if (url.includes('/pulls')) return Promise.resolve(jsonResponse([KEY_PR, NOKEY_PR]));
      if (/\/commits\/[^?]+$/.test(url)) {
        return Promise.resolve(
          jsonResponse({ files: [{ filename: 'src/a.ts', status: 'modified' }] }),
        );
      }
      if (url.includes('/commits'))
        return Promise.resolve(jsonResponse([KEY_COMMIT, NOKEY_COMMIT]));
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    store = {
      getRepositoryForBackfill: vi.fn(async () => ({
        id: 'repo-1',
        workspaceId: 'ws-1',
        provider: 'github' as const,
        fullName: 'acme/demo',
        installationId: null,
      })),
      setInstallationId: vi.fn(async () => {}),
    } as unknown as IScmStore;

    appAuth = {
      isConfigured: () => true,
      apiBaseUrl: 'https://api.github.com',
      resolveInstallationId: vi.fn(async () => '99'),
      getInstallationToken: vi.fn(async () => 'ghs_token'),
    } as unknown as GithubAppAuthService;

    linker = {
      linkPullRequest: vi.fn(async () => 'processed' as const),
      linkCommit: vi.fn(async () => 'processed' as const),
    } as unknown as ScmLinkerService;

    svc = new ScmBackfillService(store, appAuth, linker);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('links only key-referencing PRs/commits and returns counts', async () => {
    const counts = await svc.run('repo-1');

    expect(counts).toEqual({ prs: 2, commits: 2, connections: 1, changesets: 1 });
    expect(linker.linkPullRequest).toHaveBeenCalledTimes(1);
    expect(linker.linkCommit).toHaveBeenCalledTimes(1);
  });

  it('fetches commit files ONLY for commits that reference a key', async () => {
    await svc.run('repo-1');
    const fileCalls = fetchMock.mock.calls.filter(([u]) => /\/commits\/[^?]+$/.test(u as string));
    expect(fileCalls).toHaveLength(1);
    expect(fileCalls[0][0]).toContain('/commits/abc123def456');
  });

  it('resolves + caches the installation id when the repo has none', async () => {
    await svc.run('repo-1');
    expect(appAuth.resolveInstallationId).toHaveBeenCalledWith('acme/demo', undefined);
    expect(store.setInstallationId).toHaveBeenCalledWith('repo-1', '99');
    expect(appAuth.getInstallationToken).toHaveBeenCalledWith('99', undefined);
  });

  describe("the run's network budget", () => {
    it('hands the run signal to the installation lookup, the token request and every GitHub request', async () => {
      const controller = new AbortController();

      await svc.run('repo-1', { signal: controller.signal });

      expect(appAuth.resolveInstallationId).toHaveBeenCalledWith('acme/demo', controller.signal);
      expect(appAuth.getInstallationToken).toHaveBeenCalledWith('99', controller.signal);
      // Each request carries a signal of its own (the 30 s deadline merged with the run's), so it can be
      // cancelled in flight; without one a stalled socket outlives the relay's lease.
      expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
      for (const [, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
        expect(init.signal).toBeInstanceOf(AbortSignal);
      }
    });

    it('cancels the request in flight when the budget is spent', async () => {
      const controller = new AbortController();
      let seen: AbortSignal | undefined;
      fetchMock.mockImplementation((_url: string, init: RequestInit) => {
        seen = init.signal as AbortSignal;
        controller.abort(); // the budget runs out while this request is in flight
        return Promise.reject(new DOMException('This operation was aborted', 'AbortError')); // as fetch does
      });

      await expect(svc.run('repo-1', { signal: controller.signal })).rejects.toThrow();
      expect(seen?.aborted).toBe(true);
    });

    it('stops linking once the budget is spent, instead of finishing the batch', async () => {
      const controller = new AbortController();
      (linker.linkPullRequest as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        controller.abort();
        return 'processed';
      });

      await expect(svc.run('repo-1', { signal: controller.signal })).rejects.toThrow();
      expect(linker.linkCommit).not.toHaveBeenCalled();
    });
  });

  it('re-run yields identical counts (link path is idempotent upstream)', async () => {
    const first = await svc.run('repo-1');
    const second = await svc.run('repo-1');
    expect(second).toEqual(first);
  });

  it('skips entirely when the GitHub App is not configured', async () => {
    appAuth.isConfigured = () => false;
    const counts = await svc.run('repo-1');
    expect(counts).toEqual({ prs: 0, commits: 0, connections: 0, changesets: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
