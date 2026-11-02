/**
 * SCM org-level auto-discovery E2E — real AppModule + Drizzle (throwaway DB).
 *
 * Proves the installation → workspace binding + webhook-driven repo lifecycle
 * against the REAL store (scm.installations, scm.repositories, scm.backfill_jobs):
 *  1. bind an installation to the workspace,
 *  2. an `installation_repositories: added` webhook auto-registers a repo AND
 *     enqueues a backfill (so `listRepositories` surfaces it with a pending
 *     `lastSync`),
 *  3. a `removed` webhook deactivates it (drops out of the active list),
 *  4. an `installation: deleted` webhook deactivates the whole installation.
 * No GitHub network calls — the webhook path is store-only (connect()'s REST
 * discovery is covered by the unit spec with a stubbed client).
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ScmService, ScmInstallationService, SCM_STORE } from '@modules/scm';
import type { IScmStore } from '@modules/scm';

import { adminActor, bootRovaApp } from './support/flow-harness';

describe('BA flow: SCM org-level auto-discovery (real AppModule + DB)', () => {
  let app: NestFastifyApplication;
  let scm: ScmService;
  let installations: ScmInstallationService;
  let store: IScmStore;
  const actor = adminActor();
  // GitHub installation ids are numeric; keep it unique per run for the shared DB.
  const installationId = String(Math.floor(Math.random() * 1_000_000_000) + 1);
  const suffix = Date.now().toString(36);
  const repoName = `acme/discovered-${suffix}`;

  beforeAll(async () => {
    app = await bootRovaApp();
    scm = app.get(ScmService);
    installations = app.get(ScmInstallationService);
    store = app.get<IScmStore>(SCM_STORE);

    // Bind the installation to the workspace (connect()'s REST discovery skipped).
    await store.bindInstallation({
      workspaceId: actor.workspaceId,
      provider: 'github',
      installationId,
      accountLogin: 'acme',
      accountType: 'Organization',
      createdBy: actor.sub,
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('binds the installation and lists it for the workspace', async () => {
    const bound = await store.findWorkspaceByInstallation('github', installationId);
    expect(bound?.workspaceId).toBe(actor.workspaceId);

    const list = await installations.listInstallations(actor);
    expect(list.some((i) => i.installationId === installationId)).toBe(true);
  });

  it('"installation_repositories: added" auto-registers a repo with a pending sync', async () => {
    const added = await installations.handleWebhook('installation_repositories', {
      action: 'added',
      installation: { id: Number(installationId) },
      repositories_added: [{ full_name: repoName }],
      repositories_removed: [],
    });
    expect(added).toBe('processed');

    const repos = await scm.listRepositories(actor);
    const mine = repos.find((r) => r.fullName === repoName);
    expect(mine).toBeDefined();
    expect(mine?.active).toBe(true);
    expect(mine?.installationId).toBe(installationId);
    // enqueueBackfill inserted a pending job → lastSync reflects it.
    expect(mine?.lastSync?.status).toBe('pending');
  });

  it('"installation_repositories: removed" deactivates the repo', async () => {
    const removed = await installations.handleWebhook('installation_repositories', {
      action: 'removed',
      installation: { id: Number(installationId) },
      repositories_added: [],
      repositories_removed: [{ full_name: repoName }],
    });
    expect(removed).toBe('processed');

    const repos = await scm.listRepositories(actor);
    expect(repos.some((r) => r.fullName === repoName && r.active)).toBe(false);
  });

  it('"installation: deleted" deactivates the whole installation', async () => {
    const del = await installations.handleWebhook('installation', {
      action: 'deleted',
      installation: { id: Number(installationId) },
    });
    expect(del).toBe('processed');

    // Unbound installations are ignored on subsequent webhooks.
    const again = await installations.handleWebhook('installation', {
      action: 'deleted',
      installation: { id: Number(installationId) },
    });
    expect(again).toBe('ignored');
  });

  it('disconnect() cascades: its repos drop off the dashboard', async () => {
    const instId = String(Math.floor(Math.random() * 1_000_000_000) + 1);
    const name = `acme/disc-${suffix}`;
    await store.bindInstallation({
      workspaceId: actor.workspaceId,
      provider: 'github',
      installationId: instId,
      accountLogin: 'acme',
      accountType: 'Organization',
      createdBy: actor.sub,
    });
    await installations.handleWebhook('installation_repositories', {
      action: 'added',
      installation: { id: Number(instId) },
      repositories_added: [{ full_name: name }],
      repositories_removed: [],
    });
    expect((await scm.listRepositories(actor)).some((r) => r.fullName === name)).toBe(true);

    await installations.disconnect(actor, instId);

    // Gone from the list entirely (deactivated + filtered out), not just inactive.
    expect((await scm.listRepositories(actor)).some((r) => r.fullName === name)).toBe(false);
  });
});
