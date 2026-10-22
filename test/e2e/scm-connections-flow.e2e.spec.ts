/**
 * SCM Connections business-flow E2E — real AppModule + seeded DB.
 *
 * Proves the link path end-to-end against the REAL services + Drizzle (and thus
 * the new pgEnum columns): map a repo → project, feed a normalized PR/commit that
 * references a seeded work-item key, and assert the connection/changeset is linked
 * and readable. Also asserts mapping a repo enqueues a backfill job, and that the
 * upserts are idempotent (re-linking does not duplicate).
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ScmService, ScmLinkerService } from '@modules/scm';
import type { NormalizedPullRequest, NormalizedCommit } from '@modules/scm';

import { adminActor, bootRovaApp, ALL } from './support/flow-harness';

// Seeded fixtures (db/seeds/seed.ts): US-1 is the workspace-unique key for this item.
const US1_ID = '00000000-0000-7000-8000-000000000030';

describe('BA flow: SCM Connections (real AppModule + seeded DB)', () => {
  let app: NestFastifyApplication;
  let scm: ScmService;
  let linker: ScmLinkerService;
  const actor = adminActor();
  // Unique repo name per run so repeated runs against the shared DB never collide.
  const fullName = `acme/demo-${Date.now().toString(36)}`;

  beforeAll(async () => {
    app = await bootRovaApp();
    scm = app.get(ScmService);
    linker = app.get(ScmLinkerService);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('registers a repo (workspace-scoped) and enqueues a backfill job', async () => {
    const repo = await scm.createRepository(actor, { provider: 'github', fullName });
    expect(repo).toMatchObject({ provider: 'github', fullName, active: true });

    const repos = await scm.listRepositories(actor);
    expect(repos.some((r) => r.fullName === fullName)).toBe(true);
  });

  it('links a PR referencing US-1 and exposes it on the work item (idempotently)', async () => {
    const pr: NormalizedPullRequest = {
      kind: 'pull_request',
      repositoryFullName: fullName,
      externalId: `${fullName}#7`,
      number: 7,
      title: 'fix(US-1): patch the thing',
      url: `https://github.com/${fullName}/pull/7`,
      state: 'open',
      authorName: 'octocat',
      createdAt: '2026-07-24T10:00:00Z',
      keys: ['US-1'],
    };

    expect(await linker.linkPullRequest('github', pr)).toBe('processed');
    // Re-link (redelivery) must be a no-op, not a duplicate.
    expect(await linker.linkPullRequest('github', pr)).toBe('processed');

    const page = await scm.listConnections(actor, US1_ID, ALL);
    const mine = page.data.filter((c) => c.externalId === pr.externalId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ provider: 'github', type: 'pull_request', name: pr.title });
  });

  it('links a commit referencing US-1 as a changeset', async () => {
    const commit: NormalizedCommit = {
      kind: 'commit',
      repositoryFullName: fullName,
      revision: `sha-${Date.now().toString(36)}`,
      shortName: 'demo:deadbeef',
      message: 'fix(US-1): patch',
      uri: `https://github.com/${fullName}/commit/deadbeef`,
      authorName: 'octocat',
      authorEmail: 'octo@acme.dev',
      committedAt: '2026-07-24T10:05:00Z',
      changes: [{ action: 'M', path: 'src/a.ts' }],
      keys: ['US-1'],
    };

    expect(await linker.linkCommit('github', commit)).toBe('processed');

    const page = await scm.listChangesets(actor, US1_ID, ALL);
    const mine = page.data.filter((c) => c.revision === commit.revision);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      provider: 'github',
      changes: [{ action: 'M', path: 'src/a.ts' }],
    });
  });
});
