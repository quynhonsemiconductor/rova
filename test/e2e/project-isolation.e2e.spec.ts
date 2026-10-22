/**
 * Project-isolation E2E — a project-scoped grant must not reach another project.
 *
 * With one workspace in practice (`db/seeds/bootstrap.ts` seeds exactly one),
 * `project` is the boundary that actually separates users. `PolicyGuard` is the
 * single place it is enforced: its docblock says so outright ("replaces
 * PermissionGuard + ProjectPermissionGuard + service-level
 * assertProjectPermission"), and the services below it now only re-check the
 * workspace. So this spec drives the REAL guard — real `AccessService`, real
 * `ProjectScopeResolver`, real Drizzle against the seeded database — rather than
 * a service, because a service-level assertion would prove nothing about the
 * code path that actually decides.
 *
 * `context-isolation-rbac.e2e.spec.ts` already covers the easy direction:
 * listings scoped to a project don't bleed. This covers the hard one — a caller
 * holding a genuine grant on project A, addressing a known id in project B, is
 * refused for every resource kind `ScopedResource` knows how to resolve.
 *
 * The actor is deliberately NOT one of the harness's seeded actors: those carry
 * workspace-tier permissions in the token, which the guard honours on its fast
 * path (policy.guard.ts:104) and which would make every assertion here vacuous.
 * The token is empty; the grant is a real `project_admin` row scoped to project
 * A, resolved from the database per request exactly as production does.
 *
 * Prereqs: docker deps up + `pnpm db:migrate` (see flow-harness).
 */
import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AccessService, PolicyGuard, RequirePermission } from '@modules/access';
import { IterationsService } from '@modules/iterations';
import { MilestonesService } from '@modules/milestones';
import { ProjectsService } from '@modules/projects';
import { ReleasesService } from '@modules/releases';
import { WorkItemsService } from '@modules/work-items';
import { DRIZZLE } from '@platform/database/drizzle.provider';
import type { DrizzleDB } from '@platform';
import { workspaceMembers } from '@db/schema/workspace';
import type { JwtPayload } from '@platform';

import {
  WORKSPACE_ID,
  adminActor,
  bootRovaApp,
  makeActor,
  uniqueKey,
} from './support/flow-harness';

/**
 * A stand-in controller carrying the same decorators the real ones use. The
 * guard reads its policy off the handler via Reflector, so metadata declared
 * here exercises the identical resolution path — including the `resource` load
 * that turns a `:id` into a projectId.
 */
class ProbeController {
  // Method names match `ScopedResource` exactly so `describe.each` can address
  // them by the same key it uses to look up fixture ids.
  @RequirePermission('work_item:view', { resource: 'work_item', from: 'param', field: 'id' })
  work_item(): void {}

  @RequirePermission('iteration:view', { resource: 'iteration', from: 'param', field: 'id' })
  iteration(): void {}

  @RequirePermission('release:view', { resource: 'release', from: 'param', field: 'id' })
  release(): void {}

  @RequirePermission('milestone:view', { resource: 'milestone', from: 'param', field: 'id' })
  milestone(): void {}

  /** Project id straight off the request, the shape create/list routes use. */
  @RequirePermission('work_item:create', { from: 'param', field: 'projectId' })
  createInProject(): void {}
}

type ProbeRoute = Exclude<keyof ProbeController, never>;

function contextFor(route: ProbeRoute, user: JwtPayload, params: Record<string, string>) {
  return {
    getHandler: () => ProbeController.prototype[route],
    getClass: () => ProbeController,
    switchToHttp: () => ({ getRequest: () => ({ user, params, query: {}, body: {} }) }),
  } as unknown as ExecutionContext;
}

describe('project isolation: a project-scoped grant does not reach another project', () => {
  let app: NestFastifyApplication;
  let guard: PolicyGuard;
  let access: AccessService;

  const admin = adminActor();
  /**
   * Fresh id per run: this suite never cleans up its rows (same rationale as
   * `uniqueKey`), and `assignRole` rejects a duplicate (user, role, scope).
   */
  const scopedUserId = randomUUID();
  /** Empty token — every decision below must come from the database grant. */
  const scopedActor = makeActor(scopedUserId, []);

  /** `granted` lives in project A, `foreign` in project B, per resource kind. */
  const ids: Record<string, { granted: string; foreign: string }> = {};
  let projectAId: string;
  let projectBId: string;

  beforeAll(async () => {
    app = await bootRovaApp();
    guard = app.get(PolicyGuard);
    access = app.get(AccessService);
    const db = app.get<DrizzleDB>(DRIZZLE);

    const projects = app.get(ProjectsService);
    const workItems = app.get(WorkItemsService);
    const releases = app.get(ReleasesService);
    const iterations = app.get(IterationsService);
    const milestones = app.get(MilestonesService);

    const [projectA, projectB] = await Promise.all([
      projects.createProject(admin, { key: uniqueKey(), name: 'Isolation A' }),
      projects.createProject(admin, { key: uniqueKey(), name: 'Isolation B' }),
    ]);
    projectAId = projectA.id;
    projectBId = projectB.id;

    const inBoth = async <T extends { id: string }>(
      make: (projectId: string, label: string) => Promise<T>,
    ) => {
      const [a, b] = await Promise.all([make(projectAId, 'A'), make(projectBId, 'B')]);
      return { granted: a.id, foreign: b.id };
    };

    ids.work_item = await inBoth((p, l) =>
      workItems.createWorkItem(admin, p, 'story', `${l} story`),
    );
    ids.release = await inBoth((p, l) => releases.createRelease(admin, p, `${l} release`, {}));
    ids.iteration = await inBoth((p, l) =>
      iterations.createIteration(admin, p, `${l} iteration`, {}),
    );
    ids.milestone = await inBoth((p, l) =>
      milestones.createMilestone(admin, p, `${l} milestone`, {}),
    );

    // RBAC migration: addProjectMember requires workspace membership first.
    await db.insert(workspaceMembers).values({
      workspaceId: WORKSPACE_ID,
      userId: scopedUserId,
      status: 'active',
    });
    // RBAC migration: project access is now access_level on project_members.
    const member = await projects.setProjectAccess(
      WORKSPACE_ID,
      projectAId,
      scopedUserId,
      admin.sub,
      {},
    );
    await projects.updateProjectMember(
      WORKSPACE_ID,
      projectAId,
      member.id,
      { accessLevel: 'admin' },
      admin.sub,
    );
  });

  afterAll(async () => {
    await app?.close();
  });

  it('resolves the grant from the database, not from the token', async () => {
    expect(scopedActor.permissions).toEqual([]);

    const inA = await access.getProjectPermissions(scopedUserId, WORKSPACE_ID, projectAId);
    expect(inA).toContain('work_item:view');
    expect(inA).toContain('release:view');

    const inB = await access.getProjectPermissions(scopedUserId, WORKSPACE_ID, projectBId);
    expect(inB).toEqual([]);
  });

  describe.each(['work_item', 'iteration', 'release', 'milestone'] as const)(
    'resource-resolved scope: %s',
    (resource) => {
      it('admits the id that lives in the granted project', async () => {
        const ctx = contextFor(resource, scopedActor, { id: ids[resource].granted });
        await expect(guard.canActivate(ctx)).resolves.toBe(true);
      });

      it('refuses the id that lives in another project', async () => {
        const ctx = contextFor(resource, scopedActor, { id: ids[resource].foreign });
        await expect(guard.canActivate(ctx)).rejects.toMatchObject({
          code: 'PROJECT_PERMISSION_DENIED',
        });
      });
    },
  );

  describe('project id taken straight from the request', () => {
    it('admits the granted project', async () => {
      const ctx = contextFor('createInProject', scopedActor, { projectId: projectAId });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('refuses another project', async () => {
      const ctx = contextFor('createInProject', scopedActor, { projectId: projectBId });
      await expect(guard.canActivate(ctx)).rejects.toMatchObject({
        code: 'PROJECT_PERMISSION_DENIED',
      });
    });
  });

  describe('the boundary itself', () => {
    it('refuses when the resource id does not resolve at all', async () => {
      const ctx = contextFor('work_item', scopedActor, { id: randomUUID() });
      // A bad id is a clean 404 from ProjectScopeResolver, never a silent admit.
      await expect(guard.canActivate(ctx)).rejects.toMatchObject({
        code: 'WORK_ITEM_NOT_FOUND',
      });
    });

    it('still honours a workspace-wide grant as the fast path', async () => {
      const ctx = contextFor('work_item', admin, { id: ids.work_item.foreign });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('refuses a caller with no grant anywhere', async () => {
      const stranger = makeActor(randomUUID(), []);
      const ctx = contextFor('work_item', stranger, { id: ids.work_item.granted });
      await expect(guard.canActivate(ctx)).rejects.toMatchObject({
        code: 'PROJECT_PERMISSION_DENIED',
      });
    });
  });
});
