import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mocked } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { UnitOfWork, AuditProducer, DRIZZLE, PreconditionFailedException } from '@platform';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { AccessService } from './access.service';
import { ROLE_REPOSITORY, IRoleRepository } from '../domain/ports/role.repository';
import {
  ROLE_ASSIGNMENT_REPOSITORY,
  IRoleAssignmentRepository,
} from '../domain/ports/role-assignment.repository';
import { PROJECT_ACCESS_REPOSITORY } from '../domain/ports/project-access.repository';
import type {
  SystemRole,
  UserRoleAssignment,
  ScopeType,
  EffectiveAssignment,
} from '../domain/access.types';

// ── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * The per-Project grant reads and writes. Every method takes an optional executor because
 * `grantProjectAccess` has to be joinable to a transaction its caller already opened — see the
 * port's docblock. Defaults describe the ordinary case: a live project, an active workspace member,
 * no Workspace Admins, no existing grant.
 */
/** The tx `UnitOfWork.run` hands the work, exposed so a test can prove the writes enlisted on it. */
const makeUow = () => {
  const tx = { __tx: 'uow' };
  return { run: vi.fn((fn: (tx: unknown) => unknown) => fn(tx)), tx };
};

const makeProjectAccessRepo = () => ({
  findLiveProject: vi.fn().mockResolvedValue({ id: 'proj-1' }),
  isActiveWorkspaceMember: vi.fn().mockResolvedValue(true),
  listWorkspaceAdminUserIds: vi.fn().mockResolvedValue([]),
  findGrant: vi.fn().mockResolvedValue(null),
  createGrant: vi
    .fn()
    .mockImplementation((input: { id: string; accessLevel?: string }) =>
      Promise.resolve({ id: input.id, accessLevel: input.accessLevel ?? null }),
    ),
  setGrantLevel: vi
    .fn()
    .mockImplementation((id: string, accessLevel: string) => Promise.resolve({ id, accessLevel })),
});

// Phase 3: effectiveAssignments reads per-Project access_level rows directly. There is no second
// `project_members` variable any more: `listReadableProjectIds` used to query the roster itself,
// unfiltered by the permission it was asked about, and that half is gone — membership now reaches it
// only through the synthesis these rows drive.
let accessLevelRows: Array<{ projectId: string; accessLevel: string | null }> = [];

const WORKSPACE = 'ws-1';
const USER = 'user-1';

const role = (slug: string, permissions: string[]): SystemRole => ({
  id: `role-${slug}`,
  workspaceId: null,
  name: slug,
  slug,
  description: null,
  permissions,
  createdAt: new Date(),
});

const assignment = (
  roleId: string,
  scopeType: ScopeType,
  scopeId: string | null = null,
): UserRoleAssignment => ({
  id: `a-${roleId}-${scopeType}-${scopeId ?? 'none'}`,
  workspaceId: WORKSPACE,
  userId: USER,
  roleId,
  scopeType,
  scopeId,
  grantedBy: null,
  createdAt: new Date(),
});

/** A role joined with a scope — the shape returned by listEffectiveForUser. */
const eff = (
  r: SystemRole,
  scopeType: ScopeType,
  scopeId: string | null = null,
): EffectiveAssignment => ({
  scopeType,
  scopeId,
  roleSlug: r.slug,
  permissions: r.permissions,
});

describe('AccessService — scope-aware permission resolution', () => {
  let service: AccessService;
  let assignmentRepo: Mocked<IRoleAssignmentRepository>;
  let projectAccessRepo: ReturnType<typeof makeProjectAccessRepo>;
  let uow: ReturnType<typeof makeUow>;
  let audit: { emit: ReturnType<typeof vi.fn> };
  let cache: Mocked<CacheService>;

  beforeEach(async () => {
    projectAccessRepo = makeProjectAccessRepo();
    uow = makeUow();
    audit = { emit: vi.fn().mockResolvedValue(undefined) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccessService,
        {
          provide: ROLE_REPOSITORY,
          useValue: {
            findById: vi.fn(),
            listForWorkspace: vi.fn().mockResolvedValue([]),
            updatePermissions: vi.fn(),
            create: vi.fn(),
            delete: vi.fn(),
          },
        },
        {
          provide: ROLE_ASSIGNMENT_REPOSITORY,
          useValue: {
            findById: vi.fn(),
            findExisting: vi.fn(),
            listForUser: vi.fn(),
            listEffectiveForUser: vi.fn(),
            listUserIdsForRole: vi.fn().mockResolvedValue([]),
            create: vi.fn(),
            delete: vi.fn(),
          },
        },
        { provide: PROJECT_ACCESS_REPOSITORY, useValue: projectAccessRepo },
        { provide: UnitOfWork, useValue: uow },
        { provide: AuditProducer, useValue: audit },
        {
          // `effectiveAssignments` reads the per-Project access_level rows directly (no port
          // exists for the roster). Chainable stub; `accessLevelRows` is what each test controls.
          provide: DRIZZLE,
          useValue: {
            select: () => ({
              from: () => ({
                where: () => Promise.resolve(accessLevelRows),
                innerJoin: () => ({
                  where: () => Promise.resolve(accessLevelRows),
                }),
              }),
            }),
          },
        },
        {
          provide: CacheService,
          useValue: {
            // Always a miss, so every resolution reaches the repository mocks the
            // assertions below are written against.
            getJson: vi.fn().mockResolvedValue(null),
            setJson: vi.fn().mockResolvedValue(undefined),
            del: vi.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get(AccessService);
    assignmentRepo = module.get(ROLE_ASSIGNMENT_REPOSITORY);
    cache = module.get(CacheService);
    // Default: the acting user is a workspace admin. Escalation checks now resolve
    // the ACTOR's own permissions from the database instead of reading the token,
    // so tests that exercise a write need a resolvable actor; the no-escalation
    // cases narrow this deliberately.
    accessLevelRows = [];
    assignmentRepo.listEffectiveForUser.mockResolvedValue([
      {
        scopeType: 'workspace',
        scopeId: null,
        roleSlug: 'workspace_admin',
        permissions: ['workspace:*'],
      },
    ] as never);
  });

  /**
   * `GAP-P4-RBAC-003` AC1/AC3, reinstating the Editor Team scope on the BA's 2026-08-17 ruling.
   *
   * The DECISION is what is asserted here, with `listScopedTeamIds` stubbed: which principals the rule
   * applies to, and what it does with an empty scope versus a foreign team. The SQL half — an active
   * roster row on a team still actively linked to the project — and the route reach are covered over
   * real HTTP in `test/e2e/editor-team-scope.e2e.spec.ts`, because a spec that calls a service
   * directly cannot see whether the ROUTES arrive at the rule.
   */
  describe('assertTeamInScope — an Editor works only inside their own Teams', () => {
    const asEditor = () => {
      assignmentRepo.listEffectiveForUser.mockResolvedValue([] as never);
      accessLevelRows = [{ projectId: 'proj-1', accessLevel: 'editor' }];
    };
    const scoped = (teamIds: string[]) =>
      vi.spyOn(service, 'listScopedTeamIds').mockResolvedValue(teamIds);

    it('refuses EVERYTHING when the Editor has no active Team (AC1)', async () => {
      asEditor();
      scoped([]);

      await expect(service.assertTeamInScope('ws-1', 'u-1', 'proj-1', null)).rejects.toMatchObject({
        code: 'EDITOR_NO_TEAM_SCOPE',
      });
      await expect(
        service.assertTeamInScope('ws-1', 'u-1', 'proj-1', 'team-any'),
      ).rejects.toMatchObject({ code: 'EDITOR_NO_TEAM_SCOPE' });
    });

    /**
     * INVERTED by the BA's ruling of 2026-08-17. This used to assert that a team-agnostic record
     * PASSED, on the reading that `work_items.team_id` is nullable and mostly unset so refusing it
     * would make the ordinary case unreachable. The BA closed that hole without a migration: "Null
     * means Project Backlog, accessible only to Workspace Admin and Project Admin."
     */
    it('refuses a record with NO Team — that is the Project Backlog', async () => {
      asEditor();
      scoped(['team-mine']);

      await expect(service.assertTeamInScope('ws-1', 'u-1', 'proj-1', null)).rejects.toMatchObject({
        code: 'PROJECT_BACKLOG_ADMIN_ONLY',
      });
    });

    it('refuses a record owned by another Team (AC3)', async () => {
      asEditor();
      scoped(['team-mine']);

      await expect(
        service.assertTeamInScope('ws-1', 'u-1', 'proj-1', 'team-theirs'),
      ).rejects.toMatchObject({ code: 'TEAM_NOT_IN_SCOPE' });
    });

    it('admits their own Team, which is the only thing it admits', async () => {
      asEditor();
      scoped(['team-mine']);

      await expect(
        service.assertTeamInScope('ws-1', 'u-1', 'proj-1', 'team-mine'),
      ).resolves.toBeUndefined();
    });

    /**
     * `resolveTeamScope` is the same decision in the shape a QUERY needs, and every list, report,
     * search and picker narrows through it — a boundary the reads do not share is a filter with a
     * security-sounding name, which is the failure the 2026-08-14 removal note describes.
     */
    describe('resolveTeamScope — the same rule, for reads', () => {
      it('is UNRESTRICTED for a Workspace Admin', async () => {
        projectAccessRepo.listWorkspaceAdminUserIds.mockResolvedValue(['u-1']);

        await expect(service.resolveTeamScope('ws-1', 'u-1', 'proj-1')).resolves.toEqual({
          unrestricted: true,
        });
      });

      it('is UNRESTRICTED for a per-project Admin — All Teams plus the Project Backlog', async () => {
        assignmentRepo.listEffectiveForUser.mockResolvedValue([] as never);
        accessLevelRows = [{ projectId: 'proj-1', accessLevel: 'admin' }];

        await expect(service.resolveTeamScope('ws-1', 'u-1', 'proj-1')).resolves.toEqual({
          unrestricted: true,
        });
      });

      it("is the Editor's own Teams", async () => {
        asEditor();
        scoped(['team-mine', 'team-also-mine']);

        await expect(service.resolveTeamScope('ws-1', 'u-1', 'proj-1')).resolves.toEqual({
          unrestricted: false,
          teamIds: ['team-mine', 'team-also-mine'],
        });
      });

      it('answers an EMPTY list rather than unrestricted for an Editor with no Team', async () => {
        // The `null`-versus-`[]` distinction `listReadableProjectIds` documents: a caller that
        // flattens `[]` into "no filter" hands that Editor the whole project.
        asEditor();
        scoped([]);

        await expect(service.resolveTeamScope('ws-1', 'u-1', 'proj-1')).resolves.toEqual({
          unrestricted: false,
          teamIds: [],
        });
      });

      it('leaves a principal with NO level unrestricted — their refusal is a permission one', async () => {
        assignmentRepo.listEffectiveForUser.mockResolvedValue([] as never);
        accessLevelRows = [];

        // Narrowing them to zero teams would turn a 403 into an empty grid, which reads as "this
        // project has no work" — `assertProjectPermission` is what refuses them.
        await expect(service.resolveTeamScope('ws-1', 'u-1', 'proj-1')).resolves.toEqual({
          unrestricted: true,
        });
      });
    });

    it('does not apply to a per-project Admin — All Teams, §3.1', async () => {
      assignmentRepo.listEffectiveForUser.mockResolvedValue([] as never);
      accessLevelRows = [{ projectId: 'proj-1', accessLevel: 'admin' }];
      const spy = scoped([]);

      await expect(
        service.assertTeamInScope('ws-1', 'u-1', 'proj-1', 'team-theirs'),
      ).resolves.toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
    });

    it('does not apply to a Workspace Admin, whose authority is the workspace grant', async () => {
      projectAccessRepo.listWorkspaceAdminUserIds.mockResolvedValue(['u-1']);
      const spy = scoped([]);

      await expect(
        service.assertTeamInScope('ws-1', 'u-1', 'proj-1', 'team-theirs'),
      ).resolves.toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
    });

    it('leaves a principal with NO level to assertProjectPermission', async () => {
      assignmentRepo.listEffectiveForUser.mockResolvedValue([] as never);
      accessLevelRows = [];
      const spy = scoped([]);

      // No Access is not this rule's refusal to make: answering `EDITOR_NO_TEAM_SCOPE` here would
      // describe the wrong reason, and the permission check refuses them first anyway.
      await expect(
        service.assertTeamInScope('ws-1', 'u-1', 'proj-1', 'team-theirs'),
      ).resolves.toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('listReadableProjectIds — the boundary behind every cross-project list', () => {
    // Mirrors Rally, where access to an artifact follows from permission on its PROJECT
    // rather than any per-artifact grant. Getting this wrong leaks another project's data,
    // so each source and each degenerate case is asserted separately.

    it('returns null (unrestricted) for a workspace-wide wildcard', () => {
      // `workspace:*` is Rally's Workspace Admin — every project, no filter.
      // null, not "every id": enumerating projects would race with project creation.
      return expect(
        service.listReadableProjectIds(WORKSPACE, USER, 'portfolio:view'),
      ).resolves.toBeNull();
    });

    it('returns null for an explicit workspace-tier grant of the same permission', async () => {
      assignmentRepo.listEffectiveForUser.mockResolvedValue([
        {
          scopeType: 'workspace',
          scopeId: null,
          roleSlug: 'custom',
          permissions: ['portfolio:view'],
        },
      ] as never);
      await expect(
        service.listReadableProjectIds(WORKSPACE, USER, 'portfolio:view'),
      ).resolves.toBeNull();
    });

    it('returns only the projects a project-scoped role grants', async () => {
      assignmentRepo.listEffectiveForUser.mockResolvedValue([
        {
          scopeType: 'project',
          scopeId: 'proj-a',
          roleSlug: 'project_admin',
          permissions: ['portfolio:view'],
        },
        {
          scopeType: 'project',
          scopeId: 'proj-b',
          roleSlug: 'project_member',
          permissions: ['work_item:view'],
        },
      ] as never);

      const ids = await service.listReadableProjectIds(WORKSPACE, USER, 'portfolio:view');
      // proj-b is excluded: the role there does not grant THIS permission. A grant on
      // one project must never imply the same grant elsewhere.
      expect(ids).toEqual(['proj-a']);
    });

    it('unions project-scoped roles with membership whose LEVEL grants the permission', async () => {
      assignmentRepo.listEffectiveForUser.mockResolvedValue([
        {
          scopeType: 'project',
          scopeId: 'proj-a',
          roleSlug: 'project_admin',
          permissions: ['portfolio:view'],
        },
      ] as never);
      // An `admin` membership row, which reaches the result through the synthesis in
      // `effectiveAssignments` — not through a roster query of its own.
      accessLevelRows = [{ projectId: 'proj-c', accessLevel: 'admin' }];

      const ids = await service.listReadableProjectIds(WORKSPACE, USER, 'portfolio:view');
      expect(ids?.sort()).toEqual(['proj-a', 'proj-c']);
    });

    it('EXCLUDES a project whose membership level does not grant the permission', async () => {
      // The over-grant this method shipped with. A raw `project_members` query was unioned in
      // unconditionally, so an `editor` — a level that deliberately withholds `portfolio:view`
      // (§3.2 hides Portfolio Items from an Editor) — read every Epic and Feature in each of
      // their projects. The `permission` argument was passed and decided nothing.
      assignmentRepo.listEffectiveForUser.mockResolvedValue([] as never);
      accessLevelRows = [{ projectId: 'proj-e', accessLevel: 'editor' }];

      await expect(
        service.listReadableProjectIds(WORKSPACE, USER, 'portfolio:view'),
      ).resolves.toEqual([]);
      // Same row, a code the level DOES grant: the row is not being ignored, it is being
      // filtered. Both directions, or this test would also pass with the source deleted.
      await expect(
        service.listReadableProjectIds(WORKSPACE, USER, 'work_item:view'),
      ).resolves.toEqual(['proj-e']);
    });

    it('ignores a membership row whose level the catalogue does not know', async () => {
      // The synthesis filters on `isProjectAccessLevel`, where the deleted roster query used
      // `isNotNull` — so a level outside the catalogue (a removed one, a hand-written row) used
      // to be readable on the strength of being non-null.
      assignmentRepo.listEffectiveForUser.mockResolvedValue([] as never);
      accessLevelRows = [{ projectId: 'proj-x', accessLevel: 'viewer' }];

      await expect(
        service.listReadableProjectIds(WORKSPACE, USER, 'work_item:view'),
      ).resolves.toEqual([]);
    });

    it('de-duplicates a project reachable through both sources', async () => {
      assignmentRepo.listEffectiveForUser.mockResolvedValue([
        {
          scopeType: 'project',
          scopeId: 'proj-a',
          roleSlug: 'project_admin',
          permissions: ['portfolio:view'],
        },
      ] as never);
      accessLevelRows = [{ projectId: 'proj-a', accessLevel: 'admin' }];

      // A duplicate id would make `inArray` redundant rather than wrong, but a caller
      // counting the result would be misled. Both sources still exist — a legacy
      // `scope_type='project'` assignment row AND the synthesized membership one.
      expect(await service.listReadableProjectIds(WORKSPACE, USER, 'portfolio:view')).toEqual([
        'proj-a',
      ]);
    });

    it('returns an EMPTY ARRAY, not null, when nothing is readable', async () => {
      // The distinction that keeps this fail-closed: [] means "no projects" and must
      // return no rows, while null means "all". A caller conflating them opens a leak.
      assignmentRepo.listEffectiveForUser.mockResolvedValue([] as never);
      const ids = await service.listReadableProjectIds(WORKSPACE, USER, 'portfolio:view');
      expect(ids).toEqual([]);
      expect(ids).not.toBeNull();
    });

    it('honours a namespace wildcard on a project-scoped role', async () => {
      assignmentRepo.listEffectiveForUser.mockResolvedValue([
        {
          scopeType: 'project',
          scopeId: 'proj-a',
          roleSlug: 'custom',
          permissions: ['portfolio:*'],
        },
      ] as never);
      // Same wildcard semantics the guard applies, so the two cannot disagree about
      // what a grant means.
      await expect(
        service.listReadableProjectIds(WORKSPACE, USER, 'portfolio:view'),
      ).resolves.toEqual(['proj-a']);
    });

    it('ignores a project assignment with a null scopeId', async () => {
      // Defensive: scope_id is nullable in the schema (global scope uses null), so a
      // malformed project-scoped row must not become a filter of `[null]`.
      assignmentRepo.listEffectiveForUser.mockResolvedValue([
        {
          scopeType: 'project',
          scopeId: null,
          roleSlug: 'custom',
          permissions: ['portfolio:view'],
        },
      ] as never);
      await expect(
        service.listReadableProjectIds(WORKSPACE, USER, 'portfolio:view'),
      ).resolves.toEqual([]);
    });
  });

  describe('getUserRoleAndPermissions (workspace baseline)', () => {
    it('grants NO workspace-tier permission when the user has no assignments', async () => {
      assignmentRepo.listEffectiveForUser.mockResolvedValue([]);
      const result = await service.getUserRoleAndPermissions(USER, WORKSPACE);
      // No workspace/global assignment means no workspace-tier permission at all. This
      // returned `['workspace:view']` as a "minimal shell baseline" until migration 0111
      // deleted the workspace-scoped tier assignments and put every normal user in this
      // branch — at which point the floor handed the whole company a code that gates
      // Workspace Settings and the SCM inventory. Delivery access is per-Project, and
      // `getProjectPermissions` unions this baseline, so an empty one takes nothing away.
      expect(result.role).toBe('');
      expect(result.permissions).toEqual([]);
    });

    it('unions permissions across multiple baseline (workspace + global) roles', async () => {
      const member = role('project_member', ['work_item:edit', 'project:view']);
      const globalRole = role('some_global', ['audit:view', 'project:view']);
      assignmentRepo.listEffectiveForUser.mockResolvedValue([
        eff(member, 'workspace'),
        eff(globalRole, 'global'),
      ]);

      const result = await service.getUserRoleAndPermissions(USER, WORKSPACE);
      // deduped union of both roles
      expect(new Set(result.permissions)).toEqual(
        new Set(['work_item:edit', 'project:view', 'audit:view']),
      );
      // representative role prefers the global-scoped one
      expect(result.role).toBe('some_global');
    });

    it('excludes project-scoped assignments from the baseline', async () => {
      const workspaceRole = role('project_viewer', ['work_item:view']);
      const projectRole = role('project_admin', ['project:edit', 'project:manage_members']);
      assignmentRepo.listEffectiveForUser.mockResolvedValue([
        eff(workspaceRole, 'workspace'),
        eff(projectRole, 'project', 'proj-9'),
      ]);

      const result = await service.getUserRoleAndPermissions(USER, WORKSPACE);
      // project-scoped project:edit must NOT leak into the workspace-wide baseline
      expect(result.permissions).toEqual(['work_item:view']);
    });
  });

  describe('getProjectPermissions (per-project resolution)', () => {
    it('unions baseline with the role scoped to the requested project', async () => {
      const workspaceRole = role('project_viewer', ['work_item:view', 'project:view']);
      const projectRole = role('project_admin', ['project:edit', 'project:manage_members']);
      assignmentRepo.listEffectiveForUser.mockResolvedValue([
        eff(workspaceRole, 'workspace'),
        eff(projectRole, 'project', 'proj-9'),
      ]);

      const perms = await service.getProjectPermissions(USER, WORKSPACE, 'proj-9');
      expect(new Set(perms)).toEqual(
        new Set(['work_item:view', 'project:view', 'project:edit', 'project:manage_members']),
      );
    });

    it('does NOT include a role scoped to a different project', async () => {
      const workspaceRole = role('project_viewer', ['work_item:view']);
      const projectRole = role('project_admin', ['project:edit']);
      assignmentRepo.listEffectiveForUser.mockResolvedValue([
        eff(workspaceRole, 'workspace'),
        eff(projectRole, 'project', 'proj-OTHER'),
      ]);

      const perms = await service.getProjectPermissions(USER, WORKSPACE, 'proj-9');
      // project:edit belongs to a different project — must not apply here
      expect(perms).toEqual(['work_item:view']);
    });
  });

  describe('assertProjectPermission', () => {
    const actor = (permissions: string[]) =>
      ({ sub: USER, workspaceId: WORKSPACE, permissions }) as never;

    it('passes on a workspace wildcard, resolved from the database', async () => {
      // There is no token fast path any more: `getProjectPermissions` unions the
      // workspace baseline, so a workspace-wide holder passes via resolution.
      const adminRole = role('workspace_admin', ['workspace:*']);
      assignmentRepo.listEffectiveForUser.mockResolvedValue([eff(adminRole, 'workspace')]);

      await expect(
        service.assertProjectPermission(actor([]), 'proj-9', 'release:edit'),
      ).resolves.toBeUndefined();
      expect(assignmentRepo.listEffectiveForUser).toHaveBeenCalledWith(WORKSPACE, USER);
    });

    it('passes when the project-scoped role grants the permission', async () => {
      const projectRole = role('project_admin', ['release:edit']);
      assignmentRepo.listEffectiveForUser.mockResolvedValue([
        eff(projectRole, 'project', 'proj-9'),
      ]);

      await expect(
        service.assertProjectPermission(actor([]), 'proj-9', 'release:edit'),
      ).resolves.toBeUndefined();
    });

    it('throws when neither baseline nor project scope grants it', async () => {
      const otherProjectRole = role('project_admin', ['release:edit']);
      assignmentRepo.listEffectiveForUser.mockResolvedValue([
        eff(otherProjectRole, 'project', 'proj-OTHER'),
      ]);

      await expect(
        service.assertProjectPermission(actor([]), 'proj-9', 'release:edit'),
      ).rejects.toMatchObject({ code: 'PROJECT_PERMISSION_DENIED' });
    });
  });

  // `updateRolePermissions`, `createRole` and `deleteRole` had describe blocks here.
  //
  // All three methods are GONE (ruling 2026-08-14, AC-11): custom roles and the editable permission
  // matrix are deleted, because `db/permissions.catalog.ts` is the single source of truth a custom
  // matrix would fork, and custom-role CRUD plus workspace-scoped tier assignment together re-create
  // the company-wide over-grant migration 0111 removed. The tests went with the methods rather than
  // being pointed at a stub — a spec that passes against a no-op is worse than no spec.

  describe('grantProjectAccess — the one per-Project grant writer', () => {
    const grant = (o: Record<string, unknown> = {}) => ({
      workspaceId: WORKSPACE,
      projectId: 'proj-1',
      userId: 'user-2',
      actorId: 'admin-1',
      onWorkspaceAdmin: 'refuse' as const,
      ...o,
    });

    it('grants a user who is an active workspace member', async () => {
      await service.grantProjectAccess(grant());
      expect(projectAccessRepo.createGrant).toHaveBeenCalled();
    });

    it('404s an unknown or soft-deleted project before any check that could leak it exists', async () => {
      projectAccessRepo.findLiveProject.mockResolvedValue(null);
      await expect(service.grantProjectAccess(grant())).rejects.toMatchObject({
        code: 'PROJECT_NOT_FOUND',
      });
      expect(projectAccessRepo.createGrant).not.toHaveBeenCalled();
    });

    it('rejects a user who is not an active workspace member', async () => {
      // The rule that stops a user from another workspace/tenant becoming a project member.
      projectAccessRepo.isActiveWorkspaceMember.mockResolvedValue(false);
      await expect(service.grantProjectAccess(grant({ userId: 'foreign-user' }))).rejects.toThrow(
        PreconditionFailedException,
      );
      expect(projectAccessRepo.createGrant).not.toHaveBeenCalled();
    });

    it('persists the chosen access level up front (Add Existing User flow)', async () => {
      await service.grantProjectAccess(grant({ accessLevel: 'editor' }));
      expect(projectAccessRepo.createGrant).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-2', accessLevel: 'editor' }),
        uow.tx,
      );
    });

    it('omits accessLevel when none is supplied (lands NULL until a PATCH)', async () => {
      await service.grantProjectAccess(grant());
      expect(projectAccessRepo.createGrant).toHaveBeenCalledWith(
        expect.not.objectContaining({ accessLevel: expect.anything() }),
        uow.tx,
      );
    });

    it('upserts: an existing NULL-level row gets the level instead of a 409', async () => {
      // The team-derived / pre-fix shape: an explicit row with no level. Refusing the POST meant
      // the UI could show the user in the project yet be unable to give them a level.
      projectAccessRepo.findGrant.mockResolvedValue({
        id: 'pm-existing',
        userId: 'user-2',
        accessLevel: null,
      });

      const result = await service.grantProjectAccess(grant({ accessLevel: 'editor' }));

      expect(projectAccessRepo.setGrantLevel).toHaveBeenCalledWith('pm-existing', 'editor', uow.tx);
      expect(result.accessLevel).toBe('editor');
      expect(audit.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'project.member.updated',
          changes: {
            before: { userId: 'user-2', accessLevel: null },
            after: { userId: 'user-2', accessLevel: 'editor' },
          },
        }),
        uow.tx,
      );
    });

    it('is idempotent when the level already matches — no write, no audit row', async () => {
      const existing = { id: 'pm-existing', userId: 'user-2', accessLevel: 'editor' };
      projectAccessRepo.findGrant.mockResolvedValue(existing);

      await expect(service.grantProjectAccess(grant({ accessLevel: 'editor' }))).resolves.toBe(
        existing,
      );
      expect(projectAccessRepo.setGrantLevel).not.toHaveBeenCalled();
      expect(audit.emit).not.toHaveBeenCalled();
    });

    it('emits project.member.added in the SAME tx as the write', async () => {
      // Same tx as the mutation: the outbox row can never diverge from the grant it records.
      await service.grantProjectAccess(grant({ accessLevel: 'admin' }));
      expect(audit.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'project.member.added',
          projectId: 'proj-1',
          changes: { after: { userId: 'user-2', accessLevel: 'admin' } },
        }),
        uow.tx,
      );
    });

    it('invalidates the cached permissions AFTER the transaction it owns', async () => {
      await service.grantProjectAccess(grant({ accessLevel: 'editor' }));
      expect(cache.del).toHaveBeenCalledWith(`authz:assign:${WORKSPACE}:user-2`);
    });

    /**
     * RBE-03. AC-8 / §2.1: "a Workspace Admin is not added as a Project user or Team member."
     * `listProjectMembers` HIDES these rows, so a row created here would be an invisible grant —
     * live Project Admin the moment the user stops being a Workspace Admin.
     */
    describe('a Workspace Admin is not a project user (§2.1)', () => {
      beforeEach(() => {
        projectAccessRepo.listWorkspaceAdminUserIds.mockResolvedValue(['wa-1']);
      });

      it('REFUSES the grant when the caller asked for one directly', async () => {
        await expect(
          service.grantProjectAccess(grant({ userId: 'wa-1', accessLevel: 'editor' })),
        ).rejects.toMatchObject({ code: 'PROJECT_MEMBER_IS_WORKSPACE_ADMIN' });
        expect(projectAccessRepo.createGrant).not.toHaveBeenCalled();
      });

      it('SKIPS the grant when it is a side effect of another action', async () => {
        // Accepting an invitation or joining a team must not become unredeemable/uncreatable
        // because the user already has every project by workspace grant.
        await expect(
          service.grantProjectAccess(
            grant({ userId: 'wa-1', accessLevel: 'editor', onWorkspaceAdmin: 'skip' }),
          ),
        ).resolves.toBeNull();
        expect(projectAccessRepo.createGrant).not.toHaveBeenCalled();
      });
    });

    /**
     * The reason this method takes a `tx` at all. `WorkspaceService.acceptInvitation` writes the
     * user's `workspace_members` row and grants project access in ONE transaction — and
     * `UnitOfWork.run` is `db.transaction`, which does not nest. A membership check that read the
     * pool instead of the caller's tx could not see the uncommitted row and would refuse the grant
     * with `ASSIGNEE_NOT_WORKSPACE_MEMBER`; skipping the check instead is what would let a user
     * from another workspace/tenant in.
     */
    describe('joining a caller’s transaction', () => {
      const callerTx = { __tx: 'caller' } as never;

      it('threads the caller’s tx through every CHECK, not just the writes', async () => {
        await service.grantProjectAccess(grant({ accessLevel: 'editor' }), callerTx);

        expect(projectAccessRepo.findLiveProject).toHaveBeenCalledWith(
          WORKSPACE,
          'proj-1',
          callerTx,
        );
        expect(projectAccessRepo.isActiveWorkspaceMember).toHaveBeenCalledWith(
          WORKSPACE,
          'user-2',
          callerTx,
        );
        expect(projectAccessRepo.listWorkspaceAdminUserIds).toHaveBeenCalledWith(
          WORKSPACE,
          callerTx,
        );
        expect(projectAccessRepo.findGrant).toHaveBeenCalledWith('proj-1', 'user-2', callerTx);
        expect(projectAccessRepo.createGrant).toHaveBeenCalledWith(expect.anything(), callerTx);
      });

      it('does not open its own transaction', async () => {
        await service.grantProjectAccess(grant({ accessLevel: 'editor' }), callerTx);
        expect(uow.run).not.toHaveBeenCalled();
      });

      it('leaves cache invalidation to the caller, who knows when the tx commits', async () => {
        // Invalidating before commit lets a concurrent request repopulate from pre-commit state —
        // the exact staleness the cache exists to remove.
        await service.grantProjectAccess(grant({ accessLevel: 'editor' }), callerTx);
        expect(cache.del).not.toHaveBeenCalled();
      });
    });
  });
});

/**
 * A permission change must invalidate the tokens that embed the old snapshot,
 * otherwise `PermissionGuard` keeps authorizing from it until the token expires
 * (up to JWT_ACCESS_EXPIRY). These tests pin *which* writes invalidate and which
 * deliberately do not.
 */
describe('AccessService — cached-permission invalidation', () => {
  let service: AccessService;
  let roleRepo: Mocked<IRoleRepository>;
  let assignmentRepo: Mocked<IRoleAssignmentRepository>;
  let cache: Mocked<CacheService>;
  let projectAccessRepo: ReturnType<typeof makeProjectAccessRepo>;
  let uow: ReturnType<typeof makeUow>;

  const actor = {
    sub: 'admin-1',
    workspaceId: WORKSPACE,
    permissions: ['workspace:*'],
  } as unknown as Parameters<AccessService['assertProjectPermission']>[0];

  beforeEach(async () => {
    projectAccessRepo = makeProjectAccessRepo();
    uow = makeUow();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccessService,
        {
          provide: ROLE_REPOSITORY,
          useValue: {
            findById: vi.fn(),
            listForWorkspace: vi.fn().mockResolvedValue([]),
            updatePermissions: vi.fn(),
            create: vi.fn(),
            delete: vi.fn(),
          },
        },
        {
          provide: ROLE_ASSIGNMENT_REPOSITORY,
          useValue: {
            findById: vi.fn(),
            findExisting: vi.fn().mockResolvedValue(null),
            listForUser: vi.fn().mockResolvedValue([]),
            listEffectiveForUser: vi.fn().mockResolvedValue([]),
            listUserIdsForRole: vi.fn().mockResolvedValue([]),
            create: vi.fn(),
            delete: vi.fn().mockResolvedValue(undefined),
          },
        },
        { provide: PROJECT_ACCESS_REPOSITORY, useValue: projectAccessRepo },
        { provide: UnitOfWork, useValue: uow },
        { provide: AuditProducer, useValue: { emit: vi.fn().mockResolvedValue(undefined) } },
        {
          // `effectiveAssignments` reads the per-Project access_level rows directly (no port
          // exists for the roster). Chainable stub; `accessLevelRows` is what each test controls.
          provide: DRIZZLE,
          useValue: {
            select: () => ({
              from: () => ({
                where: () => Promise.resolve(accessLevelRows),
                innerJoin: () => ({
                  where: () => Promise.resolve(accessLevelRows),
                }),
              }),
            }),
          },
        },
        {
          provide: CacheService,
          useValue: {
            // Always a miss, so every resolution reaches the repository mocks the
            // assertions below are written against.
            getJson: vi.fn().mockResolvedValue(null),
            setJson: vi.fn().mockResolvedValue(undefined),
            del: vi.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get(AccessService);
    roleRepo = module.get(ROLE_REPOSITORY);
    assignmentRepo = module.get(ROLE_ASSIGNMENT_REPOSITORY);
    cache = module.get(CacheService);
    // The acting admin's own permissions are resolved from the database now, so the
    // write paths under test need a resolvable actor.
    assignmentRepo.listEffectiveForUser.mockResolvedValue([
      {
        scopeType: 'workspace',
        scopeId: null,
        roleSlug: 'workspace_admin',
        permissions: ['workspace:*'],
      },
    ] as never);
  });

  it('invalidates the user when a workspace-scoped role is revoked', async () => {
    // This is the case that used to leave a revoked admin fully privileged for
    // up to 15 minutes.
    assignmentRepo.findById.mockResolvedValue(assignment('role-workspace_admin', 'workspace'));

    await service.revokeRole(actor, 'a-1');

    expect(cache.del).toHaveBeenCalledWith(`authz:assign:${WORKSPACE}:${USER}`);
  });

  it('invalidates on elevation to workspace_admin', async () => {
    const admin = role('workspace_admin', ['workspace:*']);
    roleRepo.listForWorkspace.mockResolvedValue([admin]);
    assignmentRepo.listForUser.mockResolvedValue([]);
    assignmentRepo.create.mockResolvedValue(assignment(admin.id, 'workspace'));

    await expect(service.elevateToWorkspaceAdmin(USER, WORKSPACE)).resolves.toBe(true);

    expect(cache.del).toHaveBeenCalledWith(`authz:assign:${WORKSPACE}:${USER}`);
  });

  it('does not invalidate when a failed write throws before commit', async () => {
    // A grant for a project that does not exist throws before the transaction opens. Invalidating
    // here would evict a live cache entry on behalf of a write that never happened.
    //
    // This used to assert the same property through `assignRole`, which is gone with custom roles
    // (ruling 2026-08-14). `grantProjectAccess` is the surviving writer, so it is the one that has to
    // hold the property.
    projectAccessRepo.findLiveProject.mockResolvedValue(undefined);

    await expect(
      service.grantProjectAccess({
        workspaceId: WORKSPACE,
        projectId: 'proj-missing',
        userId: USER,
        actorId: actor.sub,
        accessLevel: 'editor',
        onWorkspaceAdmin: 'refuse',
      }),
    ).rejects.toThrow();

    expect(cache.del).not.toHaveBeenCalled();
  });
});
