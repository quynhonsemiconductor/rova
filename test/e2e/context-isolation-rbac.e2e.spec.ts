/**
 * BA business-flow E2E — context isolation + read-only RBAC.
 *
 * Encodes flows E2E-008 (project context isolation) and E2E-009 (read-only user
 * behaviour) from
 * product-docs/projects/mini-rally/testing/E2E_BUSINESS_FLOW_COVERAGE.md,
 * driving the REAL application services against the seeded DB.
 */
import type { ExecutionContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ProjectsService } from '@modules/projects';
import { WorkItemsService } from '@modules/work-items';
import type { WorkItemFilters } from '@modules/work-items';
import { PolicyGuard, RequirePermission } from '@modules/access';
import type { JwtPayload } from '@platform';

import {
  ALL,
  DEVELOPER_ID,
  SEEDED,
  adminActor,
  bootRovaApp,
  grantProjectAccess,
  makeActor,
  uniqueKey,
  viewerActor,
} from './support/flow-harness';

/**
 * Since P2 the per-route project authorization lives in the PolicyGuard, not in
 * the work-items service. This service-level harness cannot mint an authenticated
 * HTTP request, so we exercise the REAL guard directly: a probe class carries the
 * exact `@RequirePermission` metadata each route declares, and we ask the real
 * PolicyGuard (resolving the project from the seeded DB via AccessService) whether
 * a given actor may act. This is the production decision path end-to-end.
 */
class WorkItemPolicyProbe {
  @RequirePermission('work_item:view', { resource: 'work_item', from: 'param', field: 'id' })
  view(): void {}
  @RequirePermission('work_item:edit', { resource: 'work_item', from: 'param', field: 'id' })
  edit(): void {}
  @RequirePermission('work_item:create', { from: 'body', field: 'projectId' })
  create(): void {}
  @RequirePermission('work_item:delete', { resource: 'work_item', from: 'param', field: 'id' })
  delete(): void {}
  @RequirePermission('release:create', { from: 'param', field: 'projectId' })
  releaseCreate(): void {}
  @RequirePermission('iteration:create', { from: 'param', field: 'projectId' })
  iterationCreate(): void {}
}

function policyContext(
  handler: (...args: unknown[]) => unknown,
  actor: JwtPayload,
  req: {
    params?: Record<string, string>;
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
  },
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => WorkItemPolicyProbe,
    switchToHttp: () => ({
      getRequest: () => ({ user: actor, params: {}, query: {}, body: {}, ...req }),
    }),
  } as unknown as ExecutionContext;
}

const NO_WI_FILTERS = {} as WorkItemFilters;

describe('BA flows: context isolation + read-only RBAC (real AppModule + seeded DB)', () => {
  let app: NestFastifyApplication;
  let projects: ProjectsService;
  let workItems: WorkItemsService;
  let policy: PolicyGuard;
  const admin = adminActor();
  /**
   * The NO ACCESS principal.
   *
   * This was a "read-only viewer" backed by a workspace-owned CUSTOM ROLE assigned at WORKSPACE scope,
   * which is why it could read a project created inside the test. Both halves of that are gone: the BA
   * removed the `Viewer` level (`product-docs` 55e7dbb, §2.2 lists two levels), and custom roles plus
   * workspace-scoped tier assignment were deleted by ruling (AC-11) precisely because one row granting
   * project-tier codes across every project IS the over-grant migration 0111 removed.
   *
   * So the model's third state is No Access — the ABSENCE of an active `project_members` row — and this
   * seeded user has none on the projects these tests create. Nothing to arrange; that is the point.
   */
  const noAccess = viewerActor();

  beforeAll(async () => {
    app = await bootRovaApp();
    projects = app.get(ProjectsService);
    workItems = app.get(WorkItemsService);
    policy = app.get(PolicyGuard);
  });

  afterAll(async () => {
    await app?.close();
  });

  // ── E2E-008: Project context isolation ──────────────────────────────────────
  describe('E2E-008 context isolation', () => {
    /**
     * Both isolation tests run on the two SEEDED projects rather than building four of their own.
     *
     * Isolation needs two projects that differ, not two projects that are new — and every project a
     * test creates is one the suite never deletes. `SEEDED.nxp` and `SEEDED.pay` are exactly that
     * pair, seeded with a full graph each, so the assertions get stronger (real neighbours, not two
     * empty shells) while four `createProject` calls disappear.
     */
    it('does not leak one project’s work items into the other’s listings', async () => {
      const storyA = await workItems.createWorkItem(
        admin,
        SEEDED.nxp.projectId,
        'story',
        `Iso A ${uniqueKey()}`,
      );
      const storyB = await workItems.createWorkItem(
        admin,
        SEEDED.pay.projectId,
        'story',
        `Iso B ${uniqueKey()}`,
      );

      const listA = await workItems.listWorkItems(admin, SEEDED.nxp.projectId, NO_WI_FILTERS, ALL);
      const idsA = listA.data.map((w) => w.id);
      expect(idsA).toContain(storyA.id);
      expect(idsA).not.toContain(storyB.id);

      const listB = await workItems.listWorkItems(admin, SEEDED.pay.projectId, NO_WI_FILTERS, ALL);
      const idsB = listB.data.map((w) => w.id);
      expect(idsB).toContain(storyB.id);
      expect(idsB).not.toContain(storyA.id);
    });

    it('rejects cross-project parenting (a defect cannot parent onto another project)', async () => {
      // The seeded story in NXP is the parent a PAY defect must not be allowed to claim.
      await expect(
        workItems.createWorkItem(admin, SEEDED.pay.projectId, 'defect', 'Cross defect', {
          parentId: SEEDED.nxp.storyId,
        }),
      ).rejects.toMatchObject({ code: 'WORK_ITEM_PARENT_SCOPE_MISMATCH' });
    });
  });

  // ── E2E-009: No Access behaviour (enforced by the PolicyGuard) ───────────────
  describe('E2E-009 No Access', () => {
    /**
     * Retitled from "read-only user". §2.2 lists two levels — `Admin` and `Editor` — with No Access
     * implicit, so there is no read-only principal to assert. What replaced it is stronger, because a
     * read-only grant admitted the VIEW and only refused the writes: No Access is refused the read too.
     */
    it('refuses a No Access user every route, including the read', async () => {
      const project = await projects.createProject(admin, {
        key: uniqueKey(),
        name: 'Viewer Project',
      });
      const story = await workItems.createWorkItem(admin, project.id, 'story', 'Read-only target');

      // No Access cannot even VIEW. This is the assertion that changed: the old read-only viewer was
      // ALLOWED here, and a grant that admits the read is a different security claim entirely.
      await expect(
        policy.canActivate(
          policyContext(WorkItemPolicyProbe.prototype.view, noAccess, { params: { id: story.id } }),
        ),
      ).rejects.toMatchObject({ code: 'PROJECT_PERMISSION_DENIED' });

      // Nor create — no `project_members` row means no project-tier permission at all.
      await expect(
        policy.canActivate(
          policyContext(WorkItemPolicyProbe.prototype.create, noAccess, {
            body: { projectId: project.id },
          }),
        ),
      ).rejects.toMatchObject({ code: 'PROJECT_PERMISSION_DENIED' });

      // Nor edit.
      await expect(
        policy.canActivate(
          policyContext(WorkItemPolicyProbe.prototype.edit, noAccess, { params: { id: story.id } }),
        ),
      ).rejects.toMatchObject({ code: 'PROJECT_PERMISSION_DENIED' });

      // And an admin (workspace:*) fast-paths every project-tier check.
      await expect(
        policy.canActivate(
          policyContext(WorkItemPolicyProbe.prototype.edit, admin, { params: { id: story.id } }),
        ),
      ).resolves.toBe(true);
    });
  });

  // ── Role × route matrix: prove each canonical role's allow/deny through the
  // REAL guard against the seeded DB. Covers all three resolution paths:
  //   admin    → workspace:* fast-path
  //   editor   → DB-resolved per-project grant (empty token forces the DB path)
  //   noAccess → no `project_members` row, so nothing resolves
  describe('E2E-RBAC canonical role × route matrix', () => {
    it('enforces the reconciled catalog for every role', async () => {
      const project = await projects.createProject(admin, { key: uniqueKey(), name: 'Matrix' });
      const story = await workItems.createWorkItem(admin, project.id, 'story', 'Matrix target');

      /**
       * DEVELOPER_ID as an EDITOR of this project, granted explicitly.
       *
       * It used to be "a seeded workspace-scoped project_member", i.e. the legacy over-grant that
       * gave one role row write access to every project in the workspace. Migration 0111 deletes
       * those rows and the seed no longer re-creates them, so on a project this test creates dev now
       * holds nothing — and the `allow(...)` lines below failed as PROJECT_PERMISSION_DENIED.
       *
       * The grant is what the matrix is actually about: `editor` carries full work-item CRUD and
       * neither `release:create` nor `iteration:create`, which is the exact split asserted below.
       * The token stays deliberately empty so the guard must resolve it from the database.
       */
      await grantProjectAccess(app, DEVELOPER_ID, project.id, 'editor');
      const member = makeActor(DEVELOPER_ID, []);

      const P = WorkItemPolicyProbe.prototype;
      const byId = { params: { id: story.id } };
      const byProject = { params: { projectId: project.id } };
      const bodyProject = { body: { projectId: project.id } };

      const allow = (h: (...a: unknown[]) => unknown, who: JwtPayload, req: object) =>
        expect(policy.canActivate(policyContext(h, who, req))).resolves.toBe(true);
      const deny = (h: (...a: unknown[]) => unknown, who: JwtPayload, req: object) =>
        expect(policy.canActivate(policyContext(h, who, req))).rejects.toMatchObject({
          code: 'PROJECT_PERMISSION_DENIED',
        });

      // workspace_admin (workspace:*) — everything.
      await allow(P.view, admin, byId);
      await allow(P.delete, admin, byId);
      await allow(P.releaseCreate, admin, byProject);
      await allow(P.iterationCreate, admin, byProject);

      // editor — full work-item CRUD (incl. delete), but NOT release or iteration management
      // (per the Phase 4.2 reconciliation, now carried by ACCESS_LEVEL_PERMISSIONS.editor).
      await allow(P.view, member, byId);
      await allow(P.create, member, bodyProject);
      await allow(P.edit, member, byId);
      await allow(P.delete, member, byId);
      await deny(P.releaseCreate, member, byProject);
      await deny(P.iterationCreate, member, byProject);

      // No Access — nothing, INCLUDING the read. There is no read-only level to sit between this and
      // `editor` above: §2.2 lists two levels and makes No Access the absence of a row.
      await deny(P.view, noAccess, byId);
      await deny(P.create, noAccess, bodyProject);
      await deny(P.edit, noAccess, byId);
      await deny(P.delete, noAccess, byId);
    });
  });
});
