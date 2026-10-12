/**
 * BA business-flow E2E — Phase 4.2 Roles & Permissions + Phase 4.3 Settings & Audit.
 *
 * Encodes two cross-phase flows from the Phase 4 development pack
 * (product-docs/projects/mini-rally/04_Developement_tracking/Phase 4/
 *  PHASE4_DEVELOPMENT_TRACKING.md):
 *
 *   E2E-018 (P4-SET-06 Audit Log, P4-SET-01 Workspace Settings) — every
 *     administrative mutation records an audit entry, and the Audit Log read
 *     model is workspace-scoped and filterable.
 *   E2E-019 (P4-RBAC-03/04) — a read-only principal is denied destructive /
 *     governance actions the service layer enforces.
 *
 * Architecture note — administrative actions record audit entries through a
 * transactional outbox (`AuditProducer.emit` → `messaging.outbox_events`); the
 * Worker `AuditProjectionRelay` then persists `audit.audit_logs`, which AuditService
 * reads. The first two blocks boot only the API AppModule, so they prove the producer
 * contract at the outbox seam and the read model by driving AuditService directly.
 *
 * E2E-018c covers the MIDDLE HOP, and it exists because leaving it uncovered cost a
 * year of audit history: this file used to assert the two ends and nothing in between,
 * so when the projection was an SNS→SQS pipeline whose audit queue had no subscription,
 * every test here still passed while `audit_logs` received nothing in any deployed
 * environment. Two ends passing is not a chain.
 *
 * Drives the REAL application services against the seeded DB.
 */
import { randomUUID } from 'node:crypto';

import type { ExecutionContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditService } from '@modules/audit';
import { ProjectsService } from '@modules/projects';
import { WorkItemsService } from '@modules/work-items';
import { WorkspaceService } from '@modules/workspace';
import { PolicyGuard, RequirePermission } from '@modules/access';
import { DRIZZLE, type DrizzleDB, type JwtPayload } from '@platform';

import { AuditProjectionRelay } from '../../apps/worker/src/audit/audit-projection.relay';
import { outboxEvents } from '../../db/schema/messaging';
import { auditLogs } from '../../db/schema/audit';
import {
  WORKSPACE_ID,
  adminActor,
  bootAuditProjectionRelay,
  bootRallyApp,
  uniqueKey,
  viewerActor,
} from './support/flow-harness';

/**
 * Since P2, destructive-action authorization lives in the PolicyGuard (not the
 * work-items service). This service-level harness cannot mint an authenticated
 * HTTP request, so E2E-019 exercises the REAL guard directly: the probe carries
 * the same `@RequirePermission` metadata the delete route declares, and the guard
 * resolves the item's project from the seeded DB via AccessService.
 */
class DeleteWorkItemProbe {
  @RequirePermission('work_item:delete', { resource: 'work_item', from: 'param', field: 'id' })
  delete(): void {}
}

function deletePolicyContext(actor: JwtPayload, workItemId: string): ExecutionContext {
  return {
    getHandler: () => DeleteWorkItemProbe.prototype.delete,
    getClass: () => DeleteWorkItemProbe,
    switchToHttp: () => ({
      getRequest: () => ({ user: actor, params: { id: workItemId }, query: {}, body: {} }),
    }),
  } as unknown as ExecutionContext;
}

describe('BA flows: Phase 4 governance — RBAC + audit (real AppModule + seeded DB)', () => {
  let app: NestFastifyApplication;
  let projects: ProjectsService;
  let workItems: WorkItemsService;
  let workspace: WorkspaceService;
  let audit: AuditService;
  let db: DrizzleDB;
  let policy: PolicyGuard;
  const admin = adminActor();
  const viewer = viewerActor();

  beforeAll(async () => {
    app = await bootRallyApp();
    projects = app.get(ProjectsService);
    workItems = app.get(WorkItemsService);
    workspace = app.get(WorkspaceService);
    audit = app.get(AuditService);
    db = app.get<DrizzleDB>(DRIZZLE);
    policy = app.get(PolicyGuard);
  });

  afterAll(async () => {
    await app?.close();
  });

  const outboxRows = (eventType: string, aggregateId: string) =>
    db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.eventType, eventType), eq(outboxEvents.aggregateId, aggregateId)));

  // ── E2E-018a: audit producer contract ───────────────────────────────────────
  describe('E2E-018a administrative mutations record an audit event', () => {
    it('archiving a project emits a project.archived audit event', async () => {
      const project = await projects.createProject(admin, {
        key: uniqueKey(),
        name: 'Audited Project',
      });

      // No project_members row for the actor, deliberately. §2.1: a Workspace Admin is not added
      // as a Project user, and `addProjectMember` now REFUSES one — its authority for archiving is
      // the workspace-wide `workspace:edit` grant `updateProject` actually checks. The block that
      // used to add and promote it here dated from "creator is no longer auto-lead" and granted
      // nothing this assertion needs.
      await projects.updateProject(admin, project.id, { status: 'archived' });

      const rows = await outboxRows('project.archived', project.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.workspaceId).toBe(WORKSPACE_ID);
      expect((rows[0]?.payload as { actorId?: string })?.actorId).toBe(admin.sub);
    });

    it('updating workspace settings emits a workspace.settings.updated audit event', async () => {
      await workspace.updateSettings(WORKSPACE_ID, { timezone: 'Asia/Ho_Chi_Minh' }, admin.sub);

      const rows = await outboxRows('workspace.settings.updated', WORKSPACE_ID);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.every((r) => r.workspaceId === WORKSPACE_ID)).toBe(true);
    });
  });

  // ── E2E-018b: audit read model ──────────────────────────────────────────────
  describe('E2E-018b the audit log is workspace-scoped and filterable', () => {
    it('returns matching entries, filters by action and never leaks other workspaces', async () => {
      const resourceId = randomUUID();
      const foreignWorkspaceId = randomUUID();

      await audit.record({
        workspaceId: WORKSPACE_ID,
        actorId: admin.sub,
        action: 'project.archived',
        resourceType: 'project',
        resourceId,
      });
      await audit.record({
        workspaceId: WORKSPACE_ID,
        actorId: admin.sub,
        action: 'project.updated',
        resourceType: 'project',
        resourceId,
      });
      // Same resource id, different workspace — must never surface for this actor.
      await audit.record({
        workspaceId: foreignWorkspaceId,
        actorId: admin.sub,
        action: 'project.archived',
        resourceType: 'project',
        resourceId,
      });

      const all = await audit.listAuditLogs(admin, { resourceId });
      expect(all.data.map((l) => l.action).sort()).toEqual(['project.archived', 'project.updated']);
      expect(all.data.every((l) => l.workspaceId === WORKSPACE_ID)).toBe(true);

      const archivedOnly = await audit.listAuditLogs(admin, {
        resourceId,
        action: 'project.archived',
      });
      expect(archivedOnly.data).toHaveLength(1);
      expect(archivedOnly.data[0]?.action).toBe('project.archived');
    });

    /**
     * P45-04 — the filter must reach a row the loaded page does not contain, and the page must
     * report the size of the whole matching set.
     *
     * Paged to one row deliberately: a filter proved only against a page that already holds the
     * answer is proved against nothing, which is how a page-local search on the Audit Log screen
     * looked correct for as long as the seeded log fitted in one window. `total` is the other half
     * — without it the screen cannot tell "three events matched" from "three of this page's fifty
     * matched", and it is counted under the SAME predicates as the rows (one builder in
     * `AuditDrizzleRepository`), so the two cannot disagree.
     */
    it('reaches a row beyond the first page and reports the whole matching set', async () => {
      const resourceId = randomUUID();
      await audit.record({
        workspaceId: WORKSPACE_ID,
        actorId: admin.sub,
        action: 'project.archived',
        resourceType: 'project',
        resourceId,
      });
      await audit.record({
        workspaceId: WORKSPACE_ID,
        actorId: admin.sub,
        action: 'project.restored',
        resourceType: 'project',
        resourceId,
      });

      const firstPage = await audit.listAuditLogs(admin, { resourceId }, 1, 0);
      expect(firstPage.data).toHaveLength(1);
      expect(firstPage.pageInfo.total).toBe(2);
      expect(firstPage.pageInfo.hasNextPage).toBe(true);

      // Whichever of the two the newest-first page did NOT show — findable in one request,
      // without paging, and its own total is 1.
      const absent =
        firstPage.data[0]?.action === 'project.archived' ? 'project.restored' : 'project.archived';
      const found = await audit.listAuditLogs(admin, { resourceId, action: absent }, 1, 0);
      expect(found.data.map((l) => l.action)).toEqual([absent]);
      expect(found.pageInfo.total).toBe(1);
      expect(found.pageInfo.hasNextPage).toBe(false);
    });
  });

  // ── E2E-019: RBAC boundary (read-only principal) ────────────────────────────
  describe('E2E-019 a read-only principal is denied destructive and governance actions', () => {
    it('blocks a viewer from deleting a work item', async () => {
      const project = await projects.createProject(admin, {
        key: uniqueKey(),
        name: 'RBAC Delete Project',
      });
      const story = await workItems.createWorkItem(admin, project.id, 'story', 'Protected');

      // The guard denies work_item:delete for a read-only principal on the item's
      // project; an admin (workspace:*) fast-paths through.
      await expect(policy.canActivate(deletePolicyContext(viewer, story.id))).rejects.toMatchObject(
        { code: 'PROJECT_PERMISSION_DENIED' },
      );
      await expect(policy.canActivate(deletePolicyContext(admin, story.id))).resolves.toBe(true);
    });

    it('blocks a non-member viewer from archiving a project', async () => {
      const project = await projects.createProject(admin, {
        key: uniqueKey(),
        name: 'RBAC Archive Project',
      });

      await expect(
        projects.updateProject(viewer, project.id, { status: 'archived' }),
      ).rejects.toMatchObject({ code: 'PROJECT_PERMISSION_DENIED' });
    });
  });
});

// ── E2E-018c: the projection half of the pipeline ────────────────────────────
//
// The suite above proves the producer contract (service → outbox_events) and the read
// model (audit_logs → AuditService). This block proves the middle: the real
// AuditProjectionRelay selectDue → deliver → markSent/markFailed cycle, its
// idempotency, and that a failed write is RETRIED rather than acked — the property
// that was missing when this ran over SNS.
describe('BA flows: audit projection relay — real selectDue/deliver/markSent', () => {
  let relayModule: TestingModule;
  let relay: AuditProjectionRelay;
  let db: DrizzleDB;
  const admin = adminActor();

  beforeAll(async () => {
    const booted = await bootAuditProjectionRelay();
    relayModule = booted.module;
    relay = booted.relay;
    db = relayModule.get<DrizzleDB>(DRIZZLE);
  });

  afterAll(async () => {
    await relayModule?.close();
  });

  /** A pending outbox row shaped exactly as AuditProducer writes one. */
  async function enqueue(overrides: { eventType?: string; aggregateType?: string } = {}) {
    const [row] = await db
      .insert(outboxEvents)
      .values({
        eventId: randomUUID(),
        eventType: overrides.eventType ?? 'project.archived',
        aggregateType: overrides.aggregateType ?? 'project',
        aggregateId: randomUUID(),
        workspaceId: WORKSPACE_ID,
        payload: { actorId: admin.sub, changes: { before: { status: 'active' } } },
        occurredAt: new Date(),
      })
      .returning();
    return row;
  }

  const outboxById = async (id: string) =>
    (await db.select().from(outboxEvents).where(eq(outboxEvents.id, id)))[0];

  /**
   * Relay until OUR row has been picked up, or give up after a bounded number of passes.
   *
   * `fetchBatch` takes the 50 oldest pending rows (`AbstractOutboxRelay.batchSize`), so a single
   * `relay()` only projects this test's row if fewer than 50 pending rows are older than it. Alone
   * that always held; in a full-suite run it does not, because every workspace, project, team and
   * access write in the other 47 files emits an outbox row. This test failed intermittently for
   * exactly that reason and passed whenever run on its own — a batch-position dependency, not a
   * projection defect.
   *
   * Draining rather than truncating the backlog: those rows belong to other specs' assertions, and
   * this file's subject is the projection mechanics, not who is at the front of the queue.
   */
  async function relayUntil(
    id: string,
    done: (row: Awaited<ReturnType<typeof outboxById>>) => boolean,
    what: string,
    maxPasses = 20,
  ): Promise<void> {
    for (let pass = 0; pass < maxPasses; pass++) {
      await relay.relay();
      if (done(await outboxById(id))) return;
    }
    throw new Error(
      `Outbox row ${id} was not ${what} after ${maxPasses} relay passes ` +
        `(~${maxPasses * 50} rows). Either the relay is not draining, or the pending backlog is ` +
        `larger than this bound.`,
    );
  }

  /** Picked up at all — projected or failed, but no longer waiting behind other rows. */
  const relayUntilPicked = (id: string) =>
    relayUntil(id, (row) => row?.status !== 'pending', 'picked up');

  /** Picked up and ATTEMPTED, for the failure path — a starved row also reads as `pending`. */
  const relayUntilAttempted = (id: string) =>
    relayUntil(id, (row) => (row?.attempts ?? 0) > 0, 'attempted');

  const auditFor = async (sourceEventId: string) =>
    db.select().from(auditLogs).where(eq(auditLogs.sourceEventId, sourceEventId));

  it('projects a pending event into audit_logs and marks the row published', async () => {
    const row = await enqueue();

    await relayUntilPicked(row.id);

    const after = await outboxById(row.id);
    expect(after?.status).toBe('published');
    expect(after?.publishedAt).not.toBeNull();

    const logs = await auditFor(row.id);
    expect(logs).toHaveLength(1);
    // The event's own fields become the audit row's identity, unchanged.
    expect(logs[0]?.action).toBe('project.archived');
    expect(logs[0]?.resourceType).toBe('project');
    expect(logs[0]?.resourceId).toBe(row.aggregateId);
    expect(logs[0]?.workspaceId).toBe(WORKSPACE_ID);
    expect(logs[0]?.actorId).toBe(admin.sub);
    expect(logs[0]?.metadata).toMatchObject({ source: 'domain-event' });
  });

  it('is idempotent: reprojecting the same event does not duplicate the audit row', async () => {
    const row = await enqueue();

    await relayUntilPicked(row.id);
    // Migration 0102 does exactly this to rebuild history, so the second pass has to
    // be a no-op rather than a second row. One plain `relay()` is enough for the second pass: the
    // drain above cleared everything older, and the reset restores this row's original createdAt,
    // so it is now at the front of the queue.
    await db
      .update(outboxEvents)
      .set({ status: 'pending', publishedAt: null })
      .where(eq(outboxEvents.id, row.id));
    await relay.relay();

    expect(await auditFor(row.id)).toHaveLength(1);
    expect((await outboxById(row.id))?.status).toBe('published');
  });

  it('leaves a row pending for retry when the audit write fails', async () => {
    // aggregate_type is varchar(100) on the outbox and resource_type is varchar(50) on
    // audit_logs, so an over-long value inserts here and throws there — a real failure
    // rather than a stubbed one.
    const row = await enqueue({ aggregateType: 'x'.repeat(60) });

    // Waits for an ATTEMPT, not for the status to change: this row is expected to stay `pending`, so
    // "still pending" cannot distinguish a correctly-retried row from one that never got picked up.
    await relayUntilAttempted(row.id);

    const after = await outboxById(row.id);
    // NOT 'published'. Routed through AuditService.record(), which catches and logs
    // every error, this row would have been acked with no audit row written — the
    // exact silent loss this pipeline was rebuilt to remove.
    expect(after?.status).toBe('pending');
    expect(after?.attempts).toBe(1);
    expect(after?.lastError).toBeTruthy();
    expect(await auditFor(row.id)).toHaveLength(0);
  });
});
