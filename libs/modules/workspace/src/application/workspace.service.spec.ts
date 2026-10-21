import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mocked } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { AccessService } from '@modules/access';
import { ApiTokensService } from '@modules/api-tokens/application/api-tokens.service';
import { WorkspaceService } from './workspace.service';
import { GuestInviteSchedulerService } from './guest-invite-scheduler.service';
import { WORKSPACE_REPOSITORY, IWorkspaceRepository } from '../domain/ports/workspace.repository';
import {
  WORKSPACE_MEMBER_REPOSITORY,
  IWorkspaceMemberRepository,
} from '../domain/ports/workspace-member.repository';
import { TEAM_MEMBER_REPOSITORY } from '../domain/ports/team-member.repository';
import {
  WORKSPACE_INVITATION_REPOSITORY,
  IWorkspaceInvitationRepository,
} from '../domain/ports/workspace-invitation.repository';
import {
  WORKSPACE_SETTINGS_REPOSITORY,
  IWorkspaceSettingsRepository,
} from '../domain/ports/workspace-settings.repository';
import type { Workspace, WorkspaceMember, WorkspaceInvitation } from '../domain/workspace.types';
import {
  NotFoundException,
  ConflictException,
  PreconditionFailedException,
  AppConfigService,
  EmailSchedulerService,
  EmailDeliveryService,
  UnitOfWork,
  AuditProducer,
} from '@platform';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const now = new Date('2024-06-01');

const mockWorkspace = (o: Partial<Workspace> = {}): Workspace => ({
  id: 'ws-1',
  slug: 'main',
  name: 'Main',
  description: null,
  avatarUrl: null,
  status: 'active',
  settings: {},
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
  ...o,
});

const mockMember = (o: Partial<WorkspaceMember> = {}): WorkspaceMember => ({
  id: 'member-1',
  workspaceId: 'ws-1',
  userId: 'user-1',
  roleId: null,
  status: 'active',
  lastActiveAt: now,
  joinedAt: now,
  updatedAt: now,
  createdAt: now,
  ...o,
});

const mockInvitation = (o: Partial<WorkspaceInvitation> = {}): WorkspaceInvitation => ({
  id: 'inv-1',
  workspaceId: 'ws-1',
  email: 'bob@example.com',
  roleId: null,
  // NULL by default: the ordinary invitation has no guest object (staff, or the flag off), so the
  // address binding applies unless a spec sets this.
  entraGuestObjectId: null,
  status: 'pending',
  invitedBy: 'user-1',
  expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
  resendCount: 0,
  lastSentAt: now,
  acceptedBy: null,
  acceptedAt: null,
  createdAt: now,
  updatedAt: now,
  ...o,
});

// ── Mock factories ────────────────────────────────────────────────────────────

const makeWorkspaceRepo = (): Mocked<IWorkspaceRepository> => ({
  findById: vi.fn(),
  findBySlug: vi.fn(),
  listForUser: vi.fn(),
  listAll: vi.fn().mockResolvedValue([]),
  count: vi.fn().mockResolvedValue(0),
  create: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn().mockResolvedValue(undefined),
});

const makeMemberRepo = (): Mocked<IWorkspaceMemberRepository> => ({
  findMember: vi.fn(),
  findMemberById: vi.fn(),
  findMembershipsForUser: vi.fn().mockResolvedValue([]),
  listMembersWithProfile: vi.fn().mockResolvedValue([]),
  listMemberOptions: vi.fn().mockResolvedValue([]),
  addMember: vi.fn(),
  updateMember: vi.fn(),
  removeMember: vi.fn().mockResolvedValue(undefined),
  isMember: vi.fn().mockResolvedValue(false),
  touchLastActive: vi.fn().mockResolvedValue(undefined),
  countActiveAdmins: vi.fn().mockResolvedValue(2),
  isActiveAdmin: vi.fn().mockResolvedValue(false),
  // The invited address by default, so an accept in these specs is a matching one; a test that
  // cares about the mismatch overrides it.
  findUserEmail: vi.fn().mockResolvedValue('bob@example.com'),
  // Empty by default so the address binding is the one under test; the oid-binding specs override it.
  findSsoSubjects: vi.fn().mockResolvedValue([]),
  grantWorkspaceRole: vi.fn().mockResolvedValue(undefined),
});

const makeInvitationRepo = (): Mocked<IWorkspaceInvitationRepository> => ({
  findByTokenHash: vi.fn(),
  findById: vi.fn(),
  findPendingByEmail: vi.fn(),
  listByWorkspace: vi.fn().mockResolvedValue([]),
  create: vi.fn(),
  updateStatus: vi.fn().mockResolvedValue(undefined),
  cancelExistingForEmail: vi.fn().mockResolvedValue(undefined),
  setProjectAccess: vi.fn().mockResolvedValue(undefined),
  // §6.4 — no initial project access by default; the RBE-11 tests set this.
  listProjectAccess: vi.fn().mockResolvedValue([]),
  countProjectsInWorkspace: vi.fn().mockResolvedValue(0),
  rotateForResend: vi.fn(),
});

const makeSettingsRepo = (): Mocked<IWorkspaceSettingsRepository> => ({
  findByWorkspace: vi.fn(),
  upsert: vi.fn(),
});

/** `vals` is mutable so a spec can switch a setting on for one test (`config.vals.X = …`). */
const makeConfig = () => {
  const vals: Record<string, unknown> = {
    APP_BASE_URL: 'http://localhost:5173',
    INVITATION_TTL_DAYS: 7,
  };
  return { vals, get: vi.fn((key: string) => vals[key]) };
};

const makeEmailScheduler = () => ({
  schedule: vi.fn().mockResolvedValue(undefined),
});

/**
 * Entra B2B guest provisioning. `false` = the flag is off, which is the default and must leave
 * `inviteMember` behaving exactly as it did before the feature existed.
 */
const makeGuestInviteScheduler = () => ({
  schedule: vi.fn().mockResolvedValue(false),
});

// Run the wrapped work immediately with a stub transaction so repository mocks
// receive a tx argument exactly as they would in production.
/** Exposes the tx so a test can prove a write enlisted on the SAME transaction as the membership. */
const makeUow = () => {
  const tx = { __tx: 'uow' };
  return { run: vi.fn((fn: (tx: unknown) => unknown) => fn(tx)), tx };
};

/**
 * `AccessService` — accepting an invitation grants the invited role (so the permission cache has to
 * be dropped for that user) AND, since §6.4, the invitation's initial per-Project access through the
 * one grant writer. `findRole: null` = "no role found", so the role-grant path proceeds; the
 * tier-role refusal is a separate behaviour, mocked per test.
 */
const makeAccessService = () => ({
  invalidateUser: vi.fn().mockResolvedValue(undefined),
  findRole: vi.fn().mockResolvedValue(null),
  grantProjectAccess: vi.fn().mockResolvedValue({ id: 'pm-1' }),
  // The picker feed's scope (RBE-07). Defaults to UNRESTRICTED so unrelated tests are unaffected;
  // `null` and `[]` are DIFFERENT answers, which is exactly what the tests below assert.
  listReadableProjectIds: vi.fn().mockResolvedValue(null),
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('WorkspaceService', () => {
  let service: WorkspaceService;
  let workspaceRepo: ReturnType<typeof makeWorkspaceRepo>;
  let memberRepo: ReturnType<typeof makeMemberRepo>;
  let invitationRepo: ReturnType<typeof makeInvitationRepo>;
  let settingsRepo: ReturnType<typeof makeSettingsRepo>;
  let emailScheduler: ReturnType<typeof makeEmailScheduler>;
  let guestInviteScheduler: ReturnType<typeof makeGuestInviteScheduler>;
  let access: ReturnType<typeof makeAccessService>;
  let uow: ReturnType<typeof makeUow>;
  let config: ReturnType<typeof makeConfig>;
  let moduleRef: TestingModule;

  /**
   * Offboarding revokes a departing member's machine credentials: cache invalidation makes the principal
   * powerless but leaves the token AUTHENTICATING for up to a year (migration 0125).
   */
  const apiTokens = { revokeAllForUser: vi.fn().mockResolvedValue(0) };

  beforeEach(async () => {
    workspaceRepo = makeWorkspaceRepo();
    memberRepo = makeMemberRepo();
    invitationRepo = makeInvitationRepo();
    settingsRepo = makeSettingsRepo();
    emailScheduler = makeEmailScheduler();
    guestInviteScheduler = makeGuestInviteScheduler();
    access = makeAccessService();
    uow = makeUow();
    config = makeConfig();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkspaceService,
        { provide: WORKSPACE_REPOSITORY, useValue: workspaceRepo },
        { provide: WORKSPACE_MEMBER_REPOSITORY, useValue: memberRepo },
        { provide: TEAM_MEMBER_REPOSITORY, useValue: { setTeamsForUser: vi.fn() } },
        { provide: WORKSPACE_INVITATION_REPOSITORY, useValue: invitationRepo },
        { provide: WORKSPACE_SETTINGS_REPOSITORY, useValue: settingsRepo },
        { provide: AppConfigService, useValue: config },
        { provide: EmailSchedulerService, useValue: emailScheduler },
        // statusesFor is a total answer (unknown pre-seeded); tests that care about a
        // verdict override the mock per-case.
        {
          provide: EmailDeliveryService,
          useValue: {
            statusesFor: vi
              .fn()
              .mockImplementation(
                async (keys: readonly string[]) => new Map(keys.map((k: string) => [k, 'unknown'])),
              ),
          },
        },
        { provide: UnitOfWork, useValue: uow },
        { provide: AuditProducer, useValue: { emit: vi.fn().mockResolvedValue(undefined) } },
        { provide: AccessService, useValue: access },
        { provide: GuestInviteSchedulerService, useValue: guestInviteScheduler },
        { provide: ApiTokensService, useValue: apiTokens },
      ],
    }).compile();

    moduleRef = module;
    service = module.get(WorkspaceService);
  });

  // ── ensureDefaultWorkspace ───────────────────────────────────────────────────

  describe('ensureDefaultWorkspace', () => {
    it('creates a default workspace when none exist', async () => {
      workspaceRepo.count.mockResolvedValue(0);
      workspaceRepo.create.mockResolvedValue(mockWorkspace({ slug: 'default' }));

      const result = await service.ensureDefaultWorkspace();

      expect(result?.slug).toBe('default');
      expect(workspaceRepo.create).toHaveBeenCalledOnce();
    });

    it('does nothing when a workspace already exists (idempotent)', async () => {
      workspaceRepo.count.mockResolvedValue(1);

      const result = await service.ensureDefaultWorkspace();

      expect(result).toBeNull();
      expect(workspaceRepo.create).not.toHaveBeenCalled();
    });
  });

  // ── getMembership / touch / enroll ───────────────────────────────────────────

  describe('membership helpers', () => {
    it('getMemberships delegates to the member repo', async () => {
      memberRepo.findMembershipsForUser.mockResolvedValue([]);
      await service.getMemberships('user-1');
      expect(memberRepo.findMembershipsForUser).toHaveBeenCalledWith('user-1');
    });

    it('enrollMember adds a member when not already enrolled', async () => {
      memberRepo.findMember.mockResolvedValue(null);
      await service.enrollMember('ws-1', 'user-2');
      expect(memberRepo.addMember).toHaveBeenCalledOnce();
    });

    it('enrollMember is a no-op when already a member', async () => {
      memberRepo.findMember.mockResolvedValue(mockMember());
      await service.enrollMember('ws-1', 'user-1');
      expect(memberRepo.addMember).not.toHaveBeenCalled();
    });
  });

  // ── provisionWorkspace ───────────────────────────────────────────────────────

  describe('provisionWorkspace', () => {
    it('creates a workspace and enrolls the creator', async () => {
      workspaceRepo.create.mockResolvedValue(mockWorkspace());
      memberRepo.addMember.mockResolvedValue(mockMember());

      const result = await service.provisionWorkspace('Acme', 'user-1');

      expect(result.id).toBe('ws-1');
      expect(workspaceRepo.create).toHaveBeenCalledOnce();
      expect(memberRepo.addMember).toHaveBeenCalledOnce();
    });
  });

  // ── getWorkspace ─────────────────────────────────────────────────────────────

  describe('getWorkspace', () => {
    it('returns the workspace when found', async () => {
      workspaceRepo.findById.mockResolvedValue(mockWorkspace());
      const result = await service.getWorkspace('ws-1');
      expect(result.name).toBe('Main');
    });

    it('throws NotFoundException when not found', async () => {
      workspaceRepo.findById.mockResolvedValue(null);
      await expect(service.getWorkspace('missing')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when soft-deleted', async () => {
      workspaceRepo.findById.mockResolvedValue(mockWorkspace({ deletedAt: now }));
      await expect(service.getWorkspace('ws-1')).rejects.toThrow(NotFoundException);
    });
  });

  // ── createWorkspace ──────────────────────────────────────────────────────────

  describe('createWorkspace', () => {
    const actor = {
      sub: 'user-1',
      workspaceId: 'ws-1',
      contextId: 'ws-1',
      sessionId: 's1',
      jti: 'j1',
      iat: 0,
      exp: 0,
      iss: '',
      aud: '',
      permissions: [] as string[],
      claims: { permissions: [] as string[] },
      authMethod: 'password' as const,
    };

    it('creates workspace when slug is available', async () => {
      workspaceRepo.findBySlug.mockResolvedValue(null);
      workspaceRepo.create.mockResolvedValue(mockWorkspace());
      memberRepo.addMember.mockResolvedValue(mockMember());

      const result = await service.createWorkspace(actor, 'main', 'Main');
      expect(result.name).toBe('Main');
      expect(workspaceRepo.create).toHaveBeenCalledOnce();
      expect(memberRepo.addMember).toHaveBeenCalledOnce();
    });

    it('throws ConflictException when slug is taken', async () => {
      workspaceRepo.findBySlug.mockResolvedValue(mockWorkspace());
      await expect(service.createWorkspace(actor, 'main', 'Main')).rejects.toThrow(
        ConflictException,
      );
    });
  });

  // ── updateWorkspace ──────────────────────────────────────────────────────────

  describe('updateWorkspace', () => {
    it('updates workspace', async () => {
      workspaceRepo.findById.mockResolvedValue(mockWorkspace());
      workspaceRepo.update.mockResolvedValue(mockWorkspace({ name: 'Updated' }));

      const result = await service.updateWorkspace('ws-1', { name: 'Updated' }, 'actor-1');
      expect(result.name).toBe('Updated');
    });

    it('throws when workspace not found', async () => {
      workspaceRepo.findById.mockResolvedValue(null);
      await expect(service.updateWorkspace('missing', {}, 'actor-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── deleteWorkspace ──────────────────────────────────────────────────────────

  describe('deleteWorkspace', () => {
    it('soft-deletes workspace', async () => {
      workspaceRepo.findById.mockResolvedValue(mockWorkspace());
      await service.deleteWorkspace('ws-1');
      expect(workspaceRepo.softDelete).toHaveBeenCalledWith('ws-1');
    });
  });

  // ── listMemberOptions — the picker half of the roster split (RBE-07) ─────────
  //
  // The check is IN THE SERVICE (`@AuthorizedInService`), so a service spec is the right shape for
  // it: what a service spec cannot see is a GUARD defect, and there is no guard on this route by
  // design. `test/e2e/directory-team-authz.e2e.spec.ts` drives it over real HTTP as well.

  describe('listMemberOptions', () => {
    const roster = [
      {
        userId: 'user-1',
        displayName: 'Ada',
        email: 'ada@example.com',
        avatarUrl: null,
        // The DECISION a picker needs, never the raw `workspace_members.status` — see
        // `WorkspaceMemberOption.assignable`.
        assignable: true,
      },
    ];

    beforeEach(() => {
      workspaceRepo.findById.mockResolvedValue(mockWorkspace());
      memberRepo.listMemberOptions.mockResolvedValue(roster);
    });

    it('returns the roster to a Workspace Admin (null = UNRESTRICTED)', async () => {
      access.listReadableProjectIds.mockResolvedValue(null);

      await expect(service.listMemberOptions('ws-1', 'user-1')).resolves.toEqual(roster);
    });

    it('returns the roster to a caller who can read at least one project', async () => {
      // The other direction, and the one that matters most: over-restricting here silently breaks
      // every owner and assignee picker, which is what deferred this fix the first time.
      access.listReadableProjectIds.mockResolvedValue(['proj-1']);

      await expect(service.listMemberOptions('ws-1', 'user-1')).resolves.toEqual(roster);
    });

    it('returns NOBODY to a No Access principal ([] = nothing), without querying', async () => {
      access.listReadableProjectIds.mockResolvedValue([]);

      await expect(service.listMemberOptions('ws-1', 'nobody')).resolves.toEqual([]);
      expect(memberRepo.listMemberOptions).not.toHaveBeenCalled();
    });

    it('asks for project:view, the code every level holds', async () => {
      access.listReadableProjectIds.mockResolvedValue(null);

      await service.listMemberOptions('ws-1', 'user-1');

      expect(access.listReadableProjectIds).toHaveBeenCalledWith('ws-1', 'user-1', 'project:view');
    });
  });

  // ── addMember ────────────────────────────────────────────────────────────────

  describe('addMember', () => {
    it('adds member when not already a member', async () => {
      workspaceRepo.findById.mockResolvedValue(mockWorkspace());
      memberRepo.findMember.mockResolvedValue(null);
      memberRepo.addMember.mockResolvedValue(mockMember());

      const result = await service.addMember('ws-1', 'user-2', 'actor-1');
      expect(result.userId).toBe('user-1');
    });

    it('throws ConflictException if user is already a member', async () => {
      workspaceRepo.findById.mockResolvedValue(mockWorkspace());
      memberRepo.findMember.mockResolvedValue(mockMember());

      await expect(service.addMember('ws-1', 'user-1', 'actor-1')).rejects.toThrow(
        ConflictException,
      );
    });
  });

  // ── updateMember ─────────────────────────────────────────────────────────────

  describe('updateMember', () => {
    it('updates member status', async () => {
      workspaceRepo.findById.mockResolvedValue(mockWorkspace());
      memberRepo.findMemberById.mockResolvedValue(mockMember());
      memberRepo.updateMember.mockResolvedValue(mockMember({ status: 'suspended' }));

      const result = await service.updateMember(
        'ws-1',
        'member-1',
        { status: 'suspended' },
        'actor-1',
      );
      expect(result.status).toBe('suspended');
    });

    it('throws SOLE_ADMIN_VIOLATION when suspending the last admin', async () => {
      workspaceRepo.findById.mockResolvedValue(mockWorkspace());
      memberRepo.findMemberById.mockResolvedValue(mockMember());
      memberRepo.isActiveAdmin.mockResolvedValue(true);
      memberRepo.countActiveAdmins.mockResolvedValue(1);

      await expect(
        service.updateMember('ws-1', 'member-1', { status: 'suspended' }, 'actor-1'),
      ).rejects.toThrow(PreconditionFailedException);
    });

    it('throws NotFoundException when member not in workspace', async () => {
      workspaceRepo.findById.mockResolvedValue(mockWorkspace());
      memberRepo.findMemberById.mockResolvedValue(mockMember({ workspaceId: 'other' }));

      await expect(
        service.updateMember('ws-1', 'member-1', { status: 'suspended' }, 'actor-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── removeMember ─────────────────────────────────────────────────────────────

  describe('removeMember', () => {
    it('removes member', async () => {
      workspaceRepo.findById.mockResolvedValue(mockWorkspace());
      memberRepo.findMember.mockResolvedValue(mockMember());

      await service.removeMember('ws-1', 'user-1', 'actor-1');
      expect(memberRepo.removeMember).toHaveBeenCalledWith('ws-1', 'user-1', expect.anything());
    });

    it('throws NotFoundException if user is not a member', async () => {
      workspaceRepo.findById.mockResolvedValue(mockWorkspace());
      memberRepo.findMember.mockResolvedValue(null);

      await expect(service.removeMember('ws-1', 'user-99', 'actor-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws SOLE_ADMIN_VIOLATION when removing the last admin', async () => {
      workspaceRepo.findById.mockResolvedValue(mockWorkspace());
      memberRepo.findMember.mockResolvedValue(mockMember());
      memberRepo.isActiveAdmin.mockResolvedValue(true);
      memberRepo.countActiveAdmins.mockResolvedValue(1);

      await expect(service.removeMember('ws-1', 'user-1', 'actor-1')).rejects.toThrow(
        PreconditionFailedException,
      );
    });
    it("revokes the departing member's API tokens, not just their grants", async () => {
      // Invalidating the permission cache makes the principal powerless but leaves a token
      // AUTHENTICATING for up to a year (migration 0125). A live 401-vs-403 distinction is the
      // difference between a credential that is dead and one that is merely idle.
      workspaceRepo.findById.mockResolvedValue(mockWorkspace());
      memberRepo.findMember.mockResolvedValue(mockMember());
      memberRepo.isActiveAdmin.mockResolvedValue(false);

      await service.removeMember('ws-1', 'user-1', 'actor-1');

      expect(apiTokens.revokeAllForUser).toHaveBeenCalledWith('ws-1', 'user-1');
    });

    it('completes the removal even when token revocation fails', async () => {
      // Best-effort on purpose: a transient outage must not roll back a removal that has already
      // committed, which would leave the member in the workspace.
      workspaceRepo.findById.mockResolvedValue(mockWorkspace());
      memberRepo.findMember.mockResolvedValue(mockMember());
      memberRepo.isActiveAdmin.mockResolvedValue(false);
      apiTokens.revokeAllForUser.mockRejectedValueOnce(new Error('database gone'));

      await expect(service.removeMember('ws-1', 'user-1', 'actor-1')).resolves.toBeUndefined();
      expect(access.invalidateUser).toHaveBeenCalledWith('ws-1', 'user-1');
    });
  });

  // ── inviteMember ─────────────────────────────────────────────────────────────

  describe('inviteMember', () => {
    it('creates invitation and sends email INLINE while guest provisioning is off', async () => {
      workspaceRepo.findById.mockResolvedValue(mockWorkspace());
      invitationRepo.create.mockResolvedValue(mockInvitation());

      const result = await service.inviteMember('ws-1', 'bob@example.com', undefined, 'actor-1');

      expect(result.email).toBe('bob@example.com');
      expect(invitationRepo.cancelExistingForEmail).toHaveBeenCalledWith(
        'ws-1',
        'bob@example.com',
        expect.anything(),
      );
      expect(invitationRepo.create).toHaveBeenCalledOnce();
      expect(emailScheduler.schedule).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'bob@example.com',
          template: 'workspace-invitation',
          vars: expect.objectContaining({
            workspaceName: 'Main',
            inviteUrl: expect.stringContaining('/accept-invitation?token='),
          }),
          // The key the relay uses too, so the two possible writers cannot both produce an email.
          idempotencyKey: 'inv-1',
        }),
        expect.anything(),
      );
    });

    it('normalises email to lowercase before creating invitation', async () => {
      workspaceRepo.findById.mockResolvedValue(mockWorkspace());
      invitationRepo.create.mockResolvedValue(mockInvitation({ email: 'bob@example.com' }));

      await service.inviteMember('ws-1', 'BOB@Example.com', undefined, 'actor-1');

      expect(invitationRepo.cancelExistingForEmail).toHaveBeenCalledWith(
        'ws-1',
        'bob@example.com',
        expect.anything(),
      );
    });
  });

  // ── inviteMember — Entra B2B guest provisioning (migration 0123) ──────────────

  describe('inviteMember — Entra guest provisioning', () => {
    beforeEach(() => {
      workspaceRepo.findById.mockResolvedValue(mockWorkspace());
      invitationRepo.create.mockResolvedValue(mockInvitation());
    });

    it('enqueues the provisioning intent on the SAME transaction as the invitation', async () => {
      // The intent cannot exist without the invitation, and cannot be lost by one that committed —
      // which is only true while both writes share one transaction. `uow.tx` is the same handle
      // `invitationRepo.create` received.
      await service.inviteMember('ws-1', 'bob@example.com', undefined, 'actor-1');

      expect(guestInviteScheduler.schedule).toHaveBeenCalledWith(uow.tx, {
        invitationId: 'inv-1',
        workspaceId: 'ws-1',
        email: 'bob@example.com',
        // The raw token rides along, because the relay schedules the email and only the sha256 is
        // persisted — see the flag-on tests below.
        inviteToken: expect.any(String),
      });
    });

    it('keys the intent on the invitation id, so the address is the NORMALISED one', async () => {
      // Graph is invited with the address the invitation was bound to, not the one that was typed:
      // acceptance compares case-insensitively against the normalised value.
      invitationRepo.create.mockResolvedValue(mockInvitation({ email: 'bob@example.com' }));

      await service.inviteMember('ws-1', 'BOB@Example.com', undefined, 'actor-1');

      expect(guestInviteScheduler.schedule).toHaveBeenCalledWith(
        uow.tx,
        expect.objectContaining({ email: 'bob@example.com', invitationId: 'inv-1' }),
      );
    });

    it('does not enqueue when the invitation itself is refused', async () => {
      // The refusal happens before the transaction opens, so nothing may be queued for an
      // invitation that was never created.
      invitationRepo.countProjectsInWorkspace.mockResolvedValue(0);

      await expect(
        service.inviteMember('ws-1', 'bob@example.com', undefined, 'actor-1', [
          { projectId: 'proj-elsewhere', accessLevel: 'editor' },
        ]),
      ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });

      expect(guestInviteScheduler.schedule).not.toHaveBeenCalled();
    });

    it('resend re-enqueues under the SAME key, never a per-send one, and owes no email', async () => {
      // The email deliberately uses a fresh `${id}:r${n}` key per send; a directory guest must be
      // created at most once ever, so this one keys on the invitation id and the second call is a
      // no-op inside the scheduler. It is what recovers an invitation sent while the flag was off.
      //
      // NO `inviteToken`, which is the whole reason resend keeps mailing inline: a duplicate enqueue
      // is swallowed, so an email hung off this row would never be scheduled at all, and the token
      // the queued row already holds has just been superseded by this rotation.
      invitationRepo.findById.mockResolvedValue(
        mockInvitation({ lastSentAt: new Date(Date.now() - 120_000) }),
      );
      invitationRepo.rotateForResend.mockResolvedValue(
        mockInvitation({ resendCount: 1, lastSentAt: new Date() }),
      );

      await service.resendInvitation('ws-1', 'inv-1', 'actor-1');

      expect(guestInviteScheduler.schedule).toHaveBeenCalledWith(uow.tx, {
        invitationId: 'inv-1',
        workspaceId: 'ws-1',
        email: 'bob@example.com',
      });
    });

    it('resend still emails INLINE even with the flag on', async () => {
      // Provisioning has long since resolved by then — the 60s cooldown starts at invite time and the
      // relay is woken immediately — and resend is the operator's escape hatch for an invitee whose
      // provisioning failed, so it must not be gated behind the queue.
      guestInviteScheduler.schedule.mockResolvedValue(true);
      invitationRepo.findById.mockResolvedValue(
        mockInvitation({ lastSentAt: new Date(Date.now() - 120_000) }),
      );
      invitationRepo.rotateForResend.mockResolvedValue(
        mockInvitation({ resendCount: 1, lastSentAt: new Date() }),
      );

      await service.resendInvitation('ws-1', 'inv-1', 'actor-1');

      expect(emailScheduler.schedule).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: 'inv-1:r1' }),
        expect.anything(),
      );
    });

    it('with the flag ON, does NOT schedule the invitation email itself', async () => {
      /**
       * The defect this closes. Both rows used to be written here and drained by two independent
       * relays — the email relay every 5s AND woken instantly, the guest relay on a 30s cron with no
       * wake signal — so the link arrived in under a second and the Entra guest object up to 30s
       * later, plus Microsoft's directory replication. An invitee who clicks immediately then has
       * nothing to authenticate against. The email is now scheduled by the relay, which is the only
       * component that knows the guest is ready.
       */
      guestInviteScheduler.schedule.mockResolvedValue(true);

      await service.inviteMember('ws-1', 'bob@example.com', undefined, 'actor-1');

      expect(guestInviteScheduler.schedule).toHaveBeenCalledOnce();
      expect(emailScheduler.schedule).not.toHaveBeenCalled();
    });

    it('with the flag ON, hands the relay the RAW token the email needs', async () => {
      // Only the sha256 is persisted, so without this the relay could not rebuild `inviteUrl` at all.
      guestInviteScheduler.schedule.mockResolvedValue(true);

      await service.inviteMember('ws-1', 'bob@example.com', undefined, 'actor-1');

      const [, opts] = guestInviteScheduler.schedule.mock.calls[0] as [
        unknown,
        { inviteToken?: string },
      ];
      expect(opts.inviteToken).toMatch(/^[\w-]{20,}$/);
    });
  });

  // ── internal domains + copy-link ────────────────────────────────────────────

  describe('inviteMember — internal email domains', () => {
    beforeEach(() => {
      workspaceRepo.findById.mockResolvedValue(mockWorkspace());
      invitationRepo.create.mockResolvedValue(mockInvitation());
      guestInviteScheduler.schedule.mockResolvedValue(true);
      config.vals.INTERNAL_EMAIL_DOMAINS = 'qnsc.vn, Example.COM';
    });

    it('skips the guest queue for an internal address and emails INLINE, flag on', async () => {
      // A directory member has nothing to provision — the same-tenant Graph collision the relay
      // resolves as "nothing to do" — so the invitation must not wait on that hop.
      await service.inviteMember('ws-1', 'alice@qnsc.vn', undefined, 'actor-1');

      expect(guestInviteScheduler.schedule).not.toHaveBeenCalled();
      expect(emailScheduler.schedule).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'alice@qnsc.vn', template: 'workspace-invitation' }),
        expect.anything(),
      );
    });

    it('matches the domain case-insensitively and across the comma list', async () => {
      await service.inviteMember('ws-1', 'Somebody@Example.com', undefined, 'actor-1');
      expect(guestInviteScheduler.schedule).not.toHaveBeenCalled();
    });

    it('does NOT match a subdomain of an internal domain', async () => {
      // `partner.qnsc.vn` is a different administrative reality; guessing otherwise would
      // provision the wrong identity kind for the invitee.
      await service.inviteMember('ws-1', 'x@partner.qnsc.vn', undefined, 'actor-1');
      expect(guestInviteScheduler.schedule).toHaveBeenCalledOnce();
    });

    it('still enqueues the guest queue for an external address', async () => {
      await service.inviteMember('ws-1', 'bob@example.org', undefined, 'actor-1');
      expect(guestInviteScheduler.schedule).toHaveBeenCalledOnce();
    });

    it('resend also skips the guest enqueue for an internal address', async () => {
      invitationRepo.findById.mockResolvedValue(
        mockInvitation({ email: 'alice@qnsc.vn', lastSentAt: new Date(Date.now() - 120_000) }),
      );
      invitationRepo.rotateForResend.mockResolvedValue(
        mockInvitation({ email: 'alice@qnsc.vn', resendCount: 1 }),
      );

      await service.resendInvitation('ws-1', 'inv-1', 'actor-1');

      expect(guestInviteScheduler.schedule).not.toHaveBeenCalled();
      expect(emailScheduler.schedule).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'alice@qnsc.vn' }),
        expect.anything(),
      );
    });
  });

  describe('listInvitations — email delivery verdict', () => {
    it('attaches the feedback-loop verdict per invitation', async () => {
      workspaceRepo.findById.mockResolvedValue(mockWorkspace());
      invitationRepo.listByWorkspace.mockResolvedValue([
        mockInvitation({ id: 'inv-bounced' }),
        mockInvitation({ id: 'inv-delivered' }),
      ]);
      const delivery = moduleRef.get(EmailDeliveryService);
      (delivery as unknown as { statusesFor: ReturnType<typeof vi.fn> }).statusesFor = vi
        .fn()
        .mockResolvedValue(
          new Map([
            ['inv-bounced', 'bounced'],
            ['inv-delivered', 'sent'],
          ]),
        );

      const result = await service.listInvitations('ws-1');

      expect(result.find((i) => i.id === 'inv-bounced')?.emailDelivery).toBe('bounced');
      expect(result.find((i) => i.id === 'inv-delivered')?.emailDelivery).toBe('sent');
    });

    it('asks statusesFor for exactly the invitation ids on the page', async () => {
      workspaceRepo.findById.mockResolvedValue(mockWorkspace());
      invitationRepo.listByWorkspace.mockResolvedValue([mockInvitation({ id: 'inv-1' })]);
      const delivery = moduleRef.get(EmailDeliveryService);
      (
        delivery as unknown as { statusesFor: ReturnType<typeof vi.fn> }
      ).statusesFor.mockResolvedValue(new Map([['inv-1', 'unknown']]));

      await service.listInvitations('ws-1');

      expect(delivery.statusesFor).toHaveBeenCalledWith(['inv-1']);
    });
  });

  describe('buildInvitationLink (copy-link)', () => {
    beforeEach(() => {
      workspaceRepo.findById.mockResolvedValue(mockWorkspace());
    });

    it('rotates the token and returns the accept URL WITHOUT emailing', async () => {
      const originalSentAt = new Date(Date.now() - 120_000);
      invitationRepo.findById.mockResolvedValue(
        mockInvitation({ email: 'alice@qnsc.vn', lastSentAt: originalSentAt }),
      );
      invitationRepo.rotateForResend.mockResolvedValue(
        mockInvitation({ email: 'alice@qnsc.vn', resendCount: 1, lastSentAt: originalSentAt }),
      );

      const link = await service.buildInvitationLink('ws-1', 'inv-1', 'actor-1');

      expect(link.inviteUrl).toMatch(/^http:\/\/localhost:5173\/accept-invitation\?token=.+$/);
      expect(link.email).toBe('alice@qnsc.vn');
      expect(emailScheduler.schedule).not.toHaveBeenCalled();
    });

    it('PRESERVES lastSentAt so the resend cooldown does not trip on a copy', async () => {
      // Copying a link is not a send; the cooldown rate SENDS. rotateForResend takes the
      // value to write, so this is where a fresh now() would leak in.
      const originalSentAt = new Date(Date.now() - 5_000);
      invitationRepo.findById.mockResolvedValue(mockInvitation({ lastSentAt: originalSentAt }));
      invitationRepo.rotateForResend.mockResolvedValue(
        mockInvitation({ resendCount: 1, lastSentAt: originalSentAt }),
      );

      await service.buildInvitationLink('ws-1', 'inv-1', 'actor-1');

      expect(invitationRepo.rotateForResend).toHaveBeenCalledWith(
        'inv-1',
        expect.objectContaining({ lastSentAt: originalSentAt }),
        expect.anything(),
      );
    });

    it('refuses anything but pending or expired', async () => {
      invitationRepo.findById.mockResolvedValue(mockInvitation({ status: 'accepted' }));

      await expect(service.buildInvitationLink('ws-1', 'inv-1', 'actor-1')).rejects.toThrow(
        PreconditionFailedException,
      );
    });

    it('refuses an invitation from another workspace', async () => {
      invitationRepo.findById.mockResolvedValue(mockInvitation({ workspaceId: 'ws-other' }));

      await expect(service.buildInvitationLink('ws-1', 'inv-1', 'actor-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── cancelInvitation ─────────────────────────────────────────────────────────

  describe('cancelInvitation', () => {
    it('cancels pending invitation', async () => {
      workspaceRepo.findById.mockResolvedValue(mockWorkspace());
      invitationRepo.findById.mockResolvedValue(mockInvitation());

      await service.cancelInvitation('ws-1', 'inv-1', 'actor-1');

      expect(invitationRepo.updateStatus).toHaveBeenCalledWith(
        'inv-1',
        'cancelled',
        undefined,
        expect.anything(),
      );
    });

    it('throws NotFoundException when invitation not found', async () => {
      workspaceRepo.findById.mockResolvedValue(mockWorkspace());
      invitationRepo.findById.mockResolvedValue(null);

      await expect(service.cancelInvitation('ws-1', 'inv-missing', 'actor-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('inviteMember — initial per-Project access (§6.4)', () => {
    beforeEach(() => {
      workspaceRepo.findById.mockResolvedValue(mockWorkspace());
      invitationRepo.create.mockResolvedValue(mockInvitation());
    });

    it('records the projects and levels inside the invite transaction', async () => {
      // Same tx as the invitation row: the intent cannot exist without the invitation carrying it.
      invitationRepo.countProjectsInWorkspace.mockResolvedValue(1);

      await service.inviteMember('ws-1', 'bob@example.com', undefined, 'actor-1', [
        { projectId: 'proj-1', accessLevel: 'editor' },
      ]);

      expect(invitationRepo.setProjectAccess).toHaveBeenCalledWith(
        'inv-1',
        [{ projectId: 'proj-1', accessLevel: 'editor' }],
        uow.tx,
      );
    });

    it('REFUSES a project that is not in this workspace, before the email goes out', async () => {
      // Fail-fast on the inviter's screen, where the mistake can be fixed — not days later on the
      // invitee's, where `grantProjectAccess` would refuse it with PROJECT_NOT_FOUND.
      invitationRepo.countProjectsInWorkspace.mockResolvedValue(0);

      await expect(
        service.inviteMember('ws-1', 'bob@example.com', undefined, 'actor-1', [
          { projectId: 'proj-elsewhere', accessLevel: 'editor' },
        ]),
      ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });

      expect(invitationRepo.create).not.toHaveBeenCalled();
      expect(emailScheduler.schedule).not.toHaveBeenCalled();
    });

    it('REFUSES a level the catalogue does not have', async () => {
      // Through `isProjectAccessLevel`, never a hand-written pair: `AccessService` had exactly that
      // bug twice, and a granted row read as No Access for the week a third level existed.
      await expect(
        service.inviteMember('ws-1', 'bob@example.com', undefined, 'actor-1', [
          { projectId: 'proj-1', accessLevel: 'viewer' as never },
        ]),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(invitationRepo.create).not.toHaveBeenCalled();
    });

    it('REFUSES the same project twice', async () => {
      // Two rows for one project make the resulting grant order-dependent.
      await expect(
        service.inviteMember('ws-1', 'bob@example.com', undefined, 'actor-1', [
          { projectId: 'proj-1', accessLevel: 'editor' },
          { projectId: 'proj-1', accessLevel: 'admin' },
        ]),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(invitationRepo.create).not.toHaveBeenCalled();
    });

    it('an invitation with no initial access stays legal (pre-§6.4 behaviour)', async () => {
      await service.inviteMember('ws-1', 'bob@example.com', undefined, 'actor-1');

      expect(invitationRepo.create).toHaveBeenCalled();
      expect(invitationRepo.setProjectAccess).toHaveBeenCalledWith('inv-1', [], uow.tx);
      expect(invitationRepo.countProjectsInWorkspace).not.toHaveBeenCalled();
    });
  });

  // ── acceptInvitation ─────────────────────────────────────────────────────────

  describe('acceptInvitation', () => {
    it('accepts pending invitation and adds member', async () => {
      invitationRepo.findByTokenHash.mockResolvedValue(mockInvitation({ status: 'pending' }));
      memberRepo.findMember.mockResolvedValue(null);
      memberRepo.addMember.mockResolvedValue(mockMember());

      await service.acceptInvitation('raw-token', 'user-2');

      expect(invitationRepo.updateStatus).toHaveBeenCalledWith(
        'inv-1',
        'accepted',
        'user-2',
        expect.anything(),
      );
      expect(memberRepo.addMember).toHaveBeenCalledOnce();
    });

    it('REFUSES an invitation addressed to someone else', async () => {
      // The token used to be a bearer capability: acceptance checked only `pending` + not-expired, so
      // a forwarded link made the wrong person a member at the invited role. §5.2 step 4 binds it to
      // the address it was sent to.
      invitationRepo.findByTokenHash.mockResolvedValue(mockInvitation({ status: 'pending' }));
      memberRepo.findUserEmail.mockResolvedValue('someone.else@example.com');

      await expect(service.acceptInvitation('raw-token', 'user-9')).rejects.toMatchObject({
        code: 'INVITATION_EMAIL_MISMATCH',
      });
      expect(memberRepo.addMember).not.toHaveBeenCalled();
      expect(invitationRepo.updateStatus).not.toHaveBeenCalled();
    });

    /**
     * The oid binding, and the attack it closes.
     *
     * `INVITATION_EMAIL_MISMATCH` compares the Entra token's `email` claim, and Microsoft states that
     * apps should never use that claim for authorization — the strip-unverified-email mitigation
     * EXEMPTS single-tenant apps, which this is. So a guest homed in a tenant they control can set
     * their own `mail` to any string. These three pin that a guest-provisioned invitation is bound to
     * the directory OBJECT instead, which the guest cannot edit.
     */
    it('REFUSES a spoofed address when the invitation names a guest object', async () => {
      // The whole attack in one setup: the email matches (they renamed themselves to the invitee's
      // address) and the oid does not. The address check would have admitted this.
      invitationRepo.findByTokenHash.mockResolvedValue(
        mockInvitation({ status: 'pending', entraGuestObjectId: 'oid-of-the-real-invitee' }),
      );
      memberRepo.findUserEmail.mockResolvedValue('bob@example.com');
      memberRepo.findSsoSubjects.mockResolvedValue(['oid-of-somebody-else']);

      await expect(service.acceptInvitation('raw-token', 'user-9')).rejects.toMatchObject({
        code: 'INVITATION_EMAIL_MISMATCH',
      });
      expect(memberRepo.addMember).not.toHaveBeenCalled();
      expect(invitationRepo.updateStatus).not.toHaveBeenCalled();
    });

    it('accepts on the oid, and does not consult the email at all', async () => {
      invitationRepo.findByTokenHash.mockResolvedValue(
        mockInvitation({ status: 'pending', entraGuestObjectId: 'oid-1' }),
      );
      // Deliberately a NON-matching address: the oid is authoritative, so this must not matter.
      memberRepo.findUserEmail.mockResolvedValue('renamed@elsewhere.test');
      memberRepo.findSsoSubjects.mockResolvedValue(['oid-other', 'oid-1']);
      memberRepo.findMember.mockResolvedValue(null);
      memberRepo.addMember.mockResolvedValue(mockMember());

      await service.acceptInvitation('raw-token', 'user-2');

      expect(invitationRepo.updateStatus).toHaveBeenCalled();
      // The weaker check is not even reached — otherwise it would have refused this accept.
      expect(memberRepo.findUserEmail).not.toHaveBeenCalled();
    });

    it('falls back to the address when no guest object was recorded', async () => {
      // The ordinary staff case: the relay writes no oid for someone already in the directory, and an
      // invitation predating the column has none either. Refusing those would break both.
      invitationRepo.findByTokenHash.mockResolvedValue(
        mockInvitation({ status: 'pending', entraGuestObjectId: null }),
      );
      memberRepo.findUserEmail.mockResolvedValue('bob@example.com');
      memberRepo.findMember.mockResolvedValue(null);
      memberRepo.addMember.mockResolvedValue(mockMember());

      await service.acceptInvitation('raw-token', 'user-2');

      expect(invitationRepo.updateStatus).toHaveBeenCalled();
      expect(memberRepo.findSsoSubjects).not.toHaveBeenCalled();
    });

    it('accepts a differently-cased address as the same mailbox', async () => {
      // An IdP may return a differently-cased local part than the address the admin typed.
      invitationRepo.findByTokenHash.mockResolvedValue(mockInvitation({ status: 'pending' }));
      memberRepo.findUserEmail.mockResolvedValue('BOB@Example.COM');
      memberRepo.findMember.mockResolvedValue(null);
      memberRepo.addMember.mockResolvedValue(mockMember());

      await service.acceptInvitation('raw-token', 'user-2');
      expect(memberRepo.addMember).toHaveBeenCalledOnce();
    });

    it('GRANTS the invited role where permissions are actually read from', async () => {
      /**
       * `workspace_members.role_id` is denormalised and authoritative for nothing — `AccessService`
       * resolves permissions from `user_role_assignments`. So the invited role used to be written to a
       * column nobody reads: a user invited as Project Admin landed with the default role and nobody
       * was told the grant had not happened.
       */
      invitationRepo.findByTokenHash.mockResolvedValue(
        mockInvitation({ status: 'pending', roleId: 'role-project-admin' }),
      );
      memberRepo.findMember.mockResolvedValue(null);
      memberRepo.addMember.mockResolvedValue(mockMember());

      await service.acceptInvitation('raw-token', 'user-2');

      expect(memberRepo.grantWorkspaceRole).toHaveBeenCalledWith(
        {
          workspaceId: 'ws-1',
          userId: 'user-2',
          roleId: 'role-project-admin',
          grantedBy: 'user-2',
        },
        // In the SAME transaction as the membership and the status flip.
        expect.anything(),
      );
    });

    /**
     * RBE-11 / Settings §6.4 — an invitation carries initial per-Project access.
     *
     * Before this, inviting someone and granting them access were two unrelated actions and only
     * the first was on the invite screen, so the common path produced a member who signs in and can
     * see nothing: `effectiveAssignments` synthesizes a project grant from `work.project_members`,
     * and with no row the new joiner is indistinguishable from No Access.
     */
    describe('initial per-Project access (§6.4)', () => {
      const pending = () => mockInvitation({ status: 'pending' });

      beforeEach(() => {
        invitationRepo.findByTokenHash.mockResolvedValue(pending());
        memberRepo.findMember.mockResolvedValue(null);
        memberRepo.addMember.mockResolvedValue(mockMember());
        invitationRepo.listProjectAccess.mockResolvedValue([
          { projectId: 'proj-1', accessLevel: 'editor' },
        ]);
      });

      it('applies the invited grant through the one grant writer', async () => {
        await service.acceptInvitation('raw-token', 'user-2');

        expect(access.grantProjectAccess).toHaveBeenCalledWith(
          {
            workspaceId: 'ws-1',
            projectId: 'proj-1',
            userId: 'user-2',
            accessLevel: 'editor',
            actorId: 'user-2',
            onWorkspaceAdmin: 'skip',
          },
          // The SAME transaction as the membership row: `grantProjectAccess`'s
          // active-workspace-member check has to see the `addMember` above, and `UnitOfWork.run` is
          // `db.transaction`, which does not nest.
          uow.tx,
        );
      });

      it('invalidates the permission cache after commit so the grant lands on the next request', async () => {
        await service.acceptInvitation('raw-token', 'user-2');
        expect(access.invalidateUser).toHaveBeenCalledWith('ws-1', 'user-2');
      });

      it('invalidates even when the invitation carried NO workspace role', async () => {
        // The invalidation used to be gated on `invitation.roleId` alone; a project-access-only
        // invitation would then have waited out the 5-minute cache TTL before the grant took effect.
        invitationRepo.findByTokenHash.mockResolvedValue(
          mockInvitation({ status: 'pending', roleId: null }),
        );
        await service.acceptInvitation('raw-token', 'user-2');
        expect(access.invalidateUser).toHaveBeenCalledWith('ws-1', 'user-2');
      });

      it('A FORWARDED LINK COLLECTS NOTHING — the email binding runs first', async () => {
        // The token used to be a bearer capability. With §6.4 a leaked link would buy per-project
        // Admin as well as workspace membership, so the ORDER is the security property: the
        // mismatch is thrown before the grants are even read, let alone applied.
        memberRepo.findUserEmail.mockResolvedValue('someone.else@example.com');

        await expect(service.acceptInvitation('raw-token', 'user-9')).rejects.toMatchObject({
          code: 'INVITATION_EMAIL_MISMATCH',
        });

        expect(access.grantProjectAccess).not.toHaveBeenCalled();
        expect(invitationRepo.listProjectAccess).not.toHaveBeenCalled();
        expect(memberRepo.addMember).not.toHaveBeenCalled();
      });

      it('applies nothing for an invitation created before §6.4', async () => {
        // The ABSENCE of a row IS the old behaviour, which is why migration 0119 owes no backfill.
        invitationRepo.listProjectAccess.mockResolvedValue([]);
        await service.acceptInvitation('raw-token', 'user-2');
        expect(access.grantProjectAccess).not.toHaveBeenCalled();
      });
    });

    it('grants nothing when the invitation carried no role', async () => {
      invitationRepo.findByTokenHash.mockResolvedValue(
        mockInvitation({ status: 'pending', roleId: null }),
      );
      memberRepo.findMember.mockResolvedValue(null);
      memberRepo.addMember.mockResolvedValue(mockMember());

      await service.acceptInvitation('raw-token', 'user-2');
      expect(memberRepo.grantWorkspaceRole).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when token not found', async () => {
      invitationRepo.findByTokenHash.mockResolvedValue(null);
      await expect(service.acceptInvitation('bad-token', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws when invitation already accepted', async () => {
      invitationRepo.findByTokenHash.mockResolvedValue(mockInvitation({ status: 'accepted' }));
      await expect(service.acceptInvitation('token', 'user-1')).rejects.toThrow();
    });

    it('throws when invitation expired', async () => {
      invitationRepo.findByTokenHash.mockResolvedValue(
        mockInvitation({ status: 'pending', expiresAt: new Date(Date.now() - 1000) }),
      );
      await expect(service.acceptInvitation('expired-token', 'user-1')).rejects.toThrow();
    });
  });

  // ── resendInvitation ─────────────────────────────────────────────────────────

  describe('resendInvitation', () => {
    const staleSent = () => new Date(Date.now() - 5 * 60_000); // outside the cooldown

    beforeEach(() => {
      workspaceRepo.findById.mockResolvedValue(mockWorkspace());
    });

    it('rotates the token and re-sends the email with a fresh idempotency key', async () => {
      invitationRepo.findById.mockResolvedValue(
        mockInvitation({ status: 'pending', lastSentAt: staleSent(), resendCount: 0 }),
      );
      invitationRepo.rotateForResend.mockResolvedValue(
        mockInvitation({ status: 'pending', resendCount: 1 }),
      );

      await service.resendInvitation('ws-1', 'inv-1', 'actor-1');

      expect(invitationRepo.rotateForResend).toHaveBeenCalledOnce();
      expect(emailScheduler.schedule).toHaveBeenCalledWith(
        expect.objectContaining({ template: 'workspace-invitation', idempotencyKey: 'inv-1:r1' }),
        expect.anything(),
      );
    });

    it('revives an expired invitation', async () => {
      invitationRepo.findById.mockResolvedValue(
        mockInvitation({ status: 'expired', lastSentAt: staleSent() }),
      );
      invitationRepo.rotateForResend.mockResolvedValue(
        mockInvitation({ status: 'pending', resendCount: 1 }),
      );

      await expect(service.resendInvitation('ws-1', 'inv-1', 'actor-1')).resolves.toBeDefined();
      expect(invitationRepo.rotateForResend).toHaveBeenCalledOnce();
    });

    it('rejects an accepted or cancelled invitation', async () => {
      invitationRepo.findById.mockResolvedValue(mockInvitation({ status: 'accepted' }));
      await expect(service.resendInvitation('ws-1', 'inv-1', 'actor-1')).rejects.toMatchObject({
        code: 'INVITATION_NOT_PENDING',
      });
      expect(invitationRepo.rotateForResend).not.toHaveBeenCalled();
    });

    it('enforces the per-invitation resend cooldown', async () => {
      invitationRepo.findById.mockResolvedValue(
        mockInvitation({ status: 'pending', lastSentAt: new Date() }),
      );
      await expect(service.resendInvitation('ws-1', 'inv-1', 'actor-1')).rejects.toMatchObject({
        code: 'INVITATION_RESEND_TOO_SOON',
      });
      expect(emailScheduler.schedule).not.toHaveBeenCalled();
    });

    it('404s an invitation belonging to another workspace', async () => {
      invitationRepo.findById.mockResolvedValue(
        mockInvitation({ workspaceId: 'other-ws', lastSentAt: staleSent() }),
      );
      await expect(service.resendInvitation('ws-1', 'inv-1', 'actor-1')).rejects.toMatchObject({
        code: 'INVITATION_NOT_FOUND',
      });
    });
  });
});
