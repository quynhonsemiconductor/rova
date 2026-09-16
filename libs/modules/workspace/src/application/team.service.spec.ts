import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import {
  ConflictException,
  NotFoundException,
  PreconditionFailedException,
  UnitOfWork,
  AuditProducer,
} from '@platform';
import { AccessService } from '@modules/access';
import { TeamService } from './team.service';
import { TEAM_REPOSITORY } from '../domain/ports/team.repository';
import { TEAM_MEMBER_REPOSITORY } from '../domain/ports/team-member.repository';
import { WORKSPACE_REPOSITORY } from '../domain/ports/workspace.repository';
import { WORKSPACE_MEMBER_REPOSITORY } from '../domain/ports/workspace-member.repository';

const mockTeam = (o: Record<string, unknown> = {}) => ({
  id: 'team-1',
  workspaceId: 'ws-1',
  name: 'Platform',
  key: 'PLT',
  description: null,
  leadId: null,
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...o,
});

const makeTeamRepo = () => ({
  findById: vi.fn().mockResolvedValue(mockTeam()),
  findByKey: vi.fn().mockResolvedValue(null),
  create: vi.fn().mockImplementation((input: { id: string }) => Promise.resolve(mockTeam(input))),
  update: vi.fn().mockResolvedValue(mockTeam()),
  countProjectsInWorkspace: vi
    .fn()
    .mockImplementation((_ws: string, ids: string[]) => Promise.resolve(ids.length)),
  setProjectLinks: vi.fn().mockResolvedValue(undefined),
  listByWorkspaceWithStats: vi.fn().mockResolvedValue([]),
  // The team's currently-linked projects — the scope a roster row's project grant covers, and the
  // set a READER must intersect with to reach the team at all (RBE-08).
  listActiveProjectIds: vi.fn().mockResolvedValue(['proj-1']),
  findBlockingCapacityPlans: vi.fn().mockResolvedValue([]),
  // Nothing references the team by default, so it is deletable; the guard's own cases say otherwise.
  countHistoryReferences: vi.fn().mockResolvedValue([]),
  deleteTeam: vi.fn().mockResolvedValue(undefined),
});

const makeTeamMemberRepo = () => ({
  findMember: vi.fn().mockResolvedValue(null),
  addMember: vi.fn().mockResolvedValue({ id: 'tm-1', teamId: 'team-1', userId: 'user-2' }),
  listByTeam: vi.fn().mockResolvedValue([]),
  setMembers: vi.fn().mockResolvedValue(undefined),
});

/**
 * The one per-Project grant writer. RBE-06 is that a team roster row implies project access, and
 * `TeamService` reaches it through here — so these mocks are what the RBE-06 tests assert on.
 * `getProjectAccessLevel` defaults to `null` = the user holds no level yet.
 */
const makeAccessService = () => ({
  getProjectAccessLevel: vi.fn().mockResolvedValue(null),
  grantProjectAccess: vi.fn().mockResolvedValue({ id: 'pm-1' }),
  invalidateUsers: vi.fn().mockResolvedValue(undefined),
  // The team READS' scope (RBE-08 / PRJ-07). `null` = UNRESTRICTED (a Workspace Admin) is the
  // default so the write tests above are unaffected; `[]` means NOTHING, and that these are two
  // different answers is what the read tests assert.
  listReadableProjectIds: vi.fn().mockResolvedValue(null),
  // Who holds the workspace grant, for the roster badge (BA feature 2026-08-20). Nobody by default,
  // so the tests about a Workspace Admin on a Team have to say so.
  listWorkspaceAdminIds: vi.fn().mockResolvedValue([]),
  isWorkspaceAdmin: vi.fn().mockResolvedValue(false),
});

const makeWorkspaceRepo = () => ({
  findById: vi.fn().mockResolvedValue({ id: 'ws-1' }),
});

const makeWorkspaceMemberRepo = () => ({
  isMember: vi.fn().mockResolvedValue(true),
});

/** Exposes the tx so a test can prove the grant enlisted on the SAME transaction as the roster row. */
const makeUow = () => {
  const tx = { __tx: 'uow', execute: vi.fn().mockResolvedValue({ rowCount: 0 }) };
  return { run: vi.fn((fn: (tx: unknown) => unknown) => fn(tx)), tx };
};

describe('TeamService — team membership and its project access', () => {
  let service: TeamService;
  let teamRepo: ReturnType<typeof makeTeamRepo>;
  let teamMemberRepo: ReturnType<typeof makeTeamMemberRepo>;
  let workspaceMemberRepo: ReturnType<typeof makeWorkspaceMemberRepo>;
  let access: ReturnType<typeof makeAccessService>;
  let uow: ReturnType<typeof makeUow>;

  beforeEach(async () => {
    teamRepo = makeTeamRepo();
    teamMemberRepo = makeTeamMemberRepo();
    workspaceMemberRepo = makeWorkspaceMemberRepo();
    access = makeAccessService();
    uow = makeUow();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TeamService,
        { provide: TEAM_REPOSITORY, useValue: teamRepo },
        { provide: TEAM_MEMBER_REPOSITORY, useValue: teamMemberRepo },
        { provide: WORKSPACE_REPOSITORY, useValue: makeWorkspaceRepo() },
        { provide: WORKSPACE_MEMBER_REPOSITORY, useValue: workspaceMemberRepo },
        { provide: UnitOfWork, useValue: uow },
        { provide: AuditProducer, useValue: { emit: vi.fn().mockResolvedValue(undefined) } },
        { provide: AccessService, useValue: access },
      ],
    }).compile();

    service = module.get(TeamService);
  });

  it('adds a member who is an active workspace member AND belongs to the project', async () => {
    // Both halves are preconditions since 2026-08-21: the workspace one is the tenant boundary, the
    // project one is the BA's ("reject adding a user who does not belong to the Project").
    access.getProjectAccessLevel.mockResolvedValue('editor');

    await service.addTeamMember('team-1', 'user-2', 'ws-1', 'actor-1');

    expect(workspaceMemberRepo.isMember).toHaveBeenCalledWith('ws-1', 'user-2');
    expect(teamMemberRepo.addMember).toHaveBeenCalled();
  });

  it("rejects a workspace member who belongs to none of the team's projects", async () => {
    // The default fixture is exactly this candidate: an active workspace member holding no level.
    await expect(service.addTeamMember('team-1', 'outsider', 'ws-1', 'actor-1')).rejects.toThrow(
      PreconditionFailedException,
    );
    expect(teamMemberRepo.addMember).not.toHaveBeenCalled();
  });

  it('admits a WORKSPACE ADMIN, who holds no project level by design', async () => {
    // §2.1 keeps them off `work.project_members`, so a project-membership test would exclude exactly
    // the principals the 2026-08-20 Workspace-Admin-on-a-Team feature exists for.
    access.isWorkspaceAdmin.mockResolvedValue(true);

    await service.addTeamMember('team-1', 'wa-1', 'ws-1', 'actor-1');

    expect(teamMemberRepo.addMember).toHaveBeenCalled();
    // And no project access is written for them either — `PM-FR-021` retired the roster grant, so
    // §2.1's "no project_members row" now holds because nothing writes one at all.
    expect(access.grantProjectAccess).not.toHaveBeenCalled();
  });

  it('admits anyone when the team has NO active project link', async () => {
    // There is no project to be outside of, and refusing would make such a team unstaffable.
    teamRepo.listActiveProjectIds.mockResolvedValue([]);

    await service.addTeamMember('team-1', 'user-2', 'ws-1', 'actor-1');

    expect(teamMemberRepo.addMember).toHaveBeenCalled();
  });

  it('rejects a user who is not an active workspace member', async () => {
    workspaceMemberRepo.isMember.mockResolvedValue(false);
    await expect(service.addTeamMember('team-1', 'outsider', 'ws-1', 'actor-1')).rejects.toThrow(
      PreconditionFailedException,
    );
    expect(teamMemberRepo.addMember).not.toHaveBeenCalled();
  });

  it('rejects when the team is not in the workspace (404) before member checks', async () => {
    teamRepo.findById.mockResolvedValue(null);
    await expect(
      service.addTeamMember('foreign-team', 'user-2', 'ws-1', 'actor-1'),
    ).rejects.toThrow(NotFoundException);
    expect(workspaceMemberRepo.isMember).not.toHaveBeenCalled();
    expect(teamMemberRepo.addMember).not.toHaveBeenCalled();
  });

  /**
   * RBE-06. §5's closing sentence (AC-9): all three journeys update the same source. This service
   * wrote `work.team_members` with NO project grant, and the SPA compensated by following its
   * `POST /v1/teams` with a `POST /projects/{id}/members` per member — so the rule held for exactly
   * one caller, and any other caller of `POST /v1/teams` produced a team member of a project they
   * could not open.
   */
  /**
   * RBE-06 IS RETIRED — a team roster row grants NOTHING (`PM-FR-021`, BA 2026-08-22).
   *
   * "Adding or removing a Team member never creates or changes Project Access." This block used to
   * assert the opposite rule on all three writes (create, edit, add-member), each granting `editor`
   * from a roster row and never demoting an existing Admin. The same commit makes Team candidates
   * users who ALREADY hold Admin or Editor on the project, so a grant here would hand access to
   * exactly the users the candidate rule says must arrive with it — and it finishes reversing
   * Phase 1 §2A, whose other half `addTeamMember` had already reversed.
   *
   * The cases are inverted rather than deleted: what mattered was that a roster write DID something to
   * project access, so the assertion that it does nothing belongs in the same place.
   */
  describe('a team roster row grants NO project access (PM-FR-021)', () => {
    it('writes no grant when a team is created with members', async () => {
      await service.createTeam(
        'ws-1',
        { name: 'Platform', key: 'PLT', projectIds: ['proj-1'], memberUserIds: ['user-2'] },
        'actor-1',
      );

      expect(access.grantProjectAccess).not.toHaveBeenCalled();
    });

    it('writes no grant when a member is added to an existing team', async () => {
      access.getProjectAccessLevel.mockResolvedValue('editor');

      await service.addTeamMember('team-1', 'user-2', 'ws-1', 'actor-1');

      expect(access.grantProjectAccess).not.toHaveBeenCalled();
    });

    it('writes no grant when an edit adds a project link or a member', async () => {
      teamRepo.listActiveProjectIds.mockResolvedValue(['proj-1', 'proj-2']);

      await service.updateTeam('team-1', { memberUserIds: ['user-2'] }, 'ws-1', 'actor-1');

      expect(access.grantProjectAccess).not.toHaveBeenCalled();
    });

    it('does not touch the permission cache at all', async () => {
      // It used to invalidate the users it had just granted. With no grant there is nothing stale:
      // the assignment cache is keyed on `project_members`, which this write never reaches, and team
      // SCOPE is read live from `team_members` (`AccessService.listScopedTeamIds`).
      access.getProjectAccessLevel.mockResolvedValue('editor');

      await service.addTeamMember('team-1', 'user-2', 'ws-1', 'actor-1');

      expect(access.invalidateUsers).not.toHaveBeenCalled();
    });
  });
});

describe('TeamService — team reads are scoped to readable projects', () => {
  let service: TeamService;
  let teamRepo: ReturnType<typeof makeTeamRepo>;
  let teamMemberRepo: ReturnType<typeof makeTeamMemberRepo>;
  let access: ReturnType<typeof makeAccessService>;

  const alpha = {
    ...mockTeam({ id: 'team-alpha', key: 'ALP' }),
    memberCount: 2,
    projects: [
      { projectId: 'proj-1', key: 'NXP', name: 'NextGen Platform' },
      { projectId: 'proj-2', key: 'PAY', name: 'Payments' },
    ],
  };
  const beta = {
    ...mockTeam({ id: 'team-beta', key: 'BET' }),
    memberCount: 1,
    projects: [{ projectId: 'proj-2', key: 'PAY', name: 'Payments' }],
  };
  /** The domain permits an unlinked team; only an unrestricted reader has a path to one. */
  const orphan = { ...mockTeam({ id: 'team-orphan', key: 'ORP' }), memberCount: 0, projects: [] };

  beforeEach(async () => {
    teamRepo = makeTeamRepo();
    teamMemberRepo = makeTeamMemberRepo();
    access = makeAccessService();
    teamRepo.listByWorkspaceWithStats.mockResolvedValue([alpha, beta, orphan]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TeamService,
        { provide: TEAM_REPOSITORY, useValue: teamRepo },
        { provide: TEAM_MEMBER_REPOSITORY, useValue: teamMemberRepo },
        { provide: WORKSPACE_REPOSITORY, useValue: makeWorkspaceRepo() },
        { provide: WORKSPACE_MEMBER_REPOSITORY, useValue: makeWorkspaceMemberRepo() },
        { provide: UnitOfWork, useValue: makeUow() },
        { provide: AuditProducer, useValue: { emit: vi.fn().mockResolvedValue(undefined) } },
        { provide: AccessService, useValue: access },
      ],
    }).compile();

    service = module.get(TeamService);
  });

  // ── the list ───────────────────────────────────────────────────────────────

  it('gives a Workspace Admin every team, the unlinked one included (null = UNRESTRICTED)', async () => {
    access.listReadableProjectIds.mockResolvedValue(null);

    const teams = await service.listTeamsForReader('ws-1', 'wa-1');

    expect(teams.map((t) => t.id)).toEqual(['team-alpha', 'team-beta', 'team-orphan']);
  });

  it('gives an Editor the teams linked to a project they can read', async () => {
    // The direction that would break if this were over-restricted: the Team picker on Portfolio,
    // the project detail page and every Team column read this list.
    access.listReadableProjectIds.mockResolvedValue(['proj-1']);

    const teams = await service.listTeamsForReader('ws-1', 'editor-1');

    expect(teams.map((t) => t.id)).toEqual(['team-alpha']);
  });

  it('narrows the per-team projects array too, so an unreadable project’s key does not leak', async () => {
    access.listReadableProjectIds.mockResolvedValue(['proj-1']);

    const [team] = await service.listTeamsForReader('ws-1', 'editor-1');

    expect(team.projects).toEqual([{ projectId: 'proj-1', key: 'NXP', name: 'NextGen Platform' }]);
  });

  it('gives a No Access principal NO team, without querying ([] = nothing)', async () => {
    access.listReadableProjectIds.mockResolvedValue([]);

    await expect(service.listTeamsForReader('ws-1', 'nobody')).resolves.toEqual([]);
    // Never build a predicate from an empty set: `inArray(col, [])` is not portable as "match
    // nothing", which is why the empty case short-circuits instead of reaching the repository.
    expect(teamRepo.listByWorkspaceWithStats).not.toHaveBeenCalled();
  });

  it('asks for project:view, the read code every level holds', async () => {
    access.listReadableProjectIds.mockResolvedValue(null);

    await service.listTeamsForReader('ws-1', 'wa-1');

    expect(access.listReadableProjectIds).toHaveBeenCalledWith('ws-1', 'wa-1', 'project:view');
  });

  // ── the detail and the roster ───────────────────────────────────────────────

  it('serves a team detail the reader can reach through a project link', async () => {
    access.listReadableProjectIds.mockResolvedValue(['proj-1']);
    teamRepo.listActiveProjectIds.mockResolvedValue(['proj-1', 'proj-2']);

    await expect(service.getTeamForReader('team-alpha', 'ws-1', 'editor-1')).resolves.toMatchObject(
      {
        id: 'team-1',
      },
    );
  });

  it('404s a team detail whose every link is unreadable — not 403, so the list cannot be probed', async () => {
    access.listReadableProjectIds.mockResolvedValue(['proj-1']);
    teamRepo.listActiveProjectIds.mockResolvedValue(['proj-2']);

    await expect(service.getTeamForReader('team-beta', 'ws-1', 'editor-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('404s an unlinked team for a scoped reader, and serves it to a Workspace Admin', async () => {
    teamRepo.listActiveProjectIds.mockResolvedValue([]);

    access.listReadableProjectIds.mockResolvedValue(['proj-1']);
    await expect(service.getTeamForReader('team-orphan', 'ws-1', 'editor-1')).rejects.toThrow(
      NotFoundException,
    );

    access.listReadableProjectIds.mockResolvedValue(null);
    await expect(service.getTeamForReader('team-orphan', 'ws-1', 'wa-1')).resolves.toBeTruthy();
  });

  it('serves the roster of a reachable team and refuses an unreachable one', async () => {
    teamMemberRepo.listByTeam.mockResolvedValue([
      { userId: 'user-1', email: 'ada@example.com', displayName: 'Ada' },
    ]);
    access.listReadableProjectIds.mockResolvedValue(['proj-1']);

    teamRepo.listActiveProjectIds.mockResolvedValue(['proj-1']);
    await expect(
      service.listTeamMembersForReader('team-alpha', 'ws-1', 'editor-1'),
    ).resolves.toHaveLength(1);

    teamRepo.listActiveProjectIds.mockResolvedValue(['proj-2']);
    await expect(service.listTeamMembersForReader('team-beta', 'ws-1', 'editor-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  /**
   * A WORKSPACE ADMIN MAY BE A TEAM MEMBER (BA feature, 2026-08-20).
   *
   * This reverses half of §2.1. Team membership is OPERATIONAL scope: it must not create or require a
   * project-access assignment, and it must not change what the admin may do. The other half stands —
   * a Workspace Admin still holds no `work.project_members` row — which is exactly why their roster
   * row has no access level and has to be badged instead.
   */
  describe('a Workspace Admin on a Team', () => {
    beforeEach(() => {
      access.listWorkspaceAdminIds.mockResolvedValue(['wa-1']);
      access.isWorkspaceAdmin.mockResolvedValue(true);
    });

    it('badges the roster row rather than leaving a blank level to guess at (AC1)', async () => {
      teamMemberRepo.listByTeam.mockResolvedValue([
        { id: 'tm-1', userId: 'wa-1', teamId: 'team-1', status: 'active' },
        { id: 'tm-2', userId: 'user-2', teamId: 'team-1', status: 'active' },
      ]);

      const roster = await service.listTeamMembersForReader('team-1', 'ws-1', 'actor-1');

      expect(roster.find((m) => m.userId === 'wa-1')?.isWorkspaceAdmin).toBe(true);
      // `false`, not absent: a client must not have to read "field missing" as "not an admin".
      expect(roster.find((m) => m.userId === 'user-2')?.isWorkspaceAdmin).toBe(false);
    });

    it('asks who the admins are ONCE, not once per row', async () => {
      teamMemberRepo.listByTeam.mockResolvedValue([
        { id: 'tm-1', userId: 'wa-1', teamId: 'team-1', status: 'active' },
        { id: 'tm-2', userId: 'user-2', teamId: 'team-1', status: 'active' },
        { id: 'tm-3', userId: 'user-3', teamId: 'team-1', status: 'active' },
      ]);

      await service.listTeamMembersForReader('team-1', 'ws-1', 'actor-1');

      expect(access.listWorkspaceAdminIds).toHaveBeenCalledTimes(1);
    });

    it('asks nothing at all for an empty roster', async () => {
      teamMemberRepo.listByTeam.mockResolvedValue([]);

      await service.listTeamMembersForReader('team-1', 'ws-1', 'actor-1');

      expect(access.listWorkspaceAdminIds).not.toHaveBeenCalled();
    });

    it('creates NO project-access assignment when adding them (AC1/AC4)', async () => {
      teamRepo.listActiveProjectIds.mockResolvedValue(['proj-1']);

      await service.addTeamMember('team-1', 'wa-1', 'ws-1', 'actor-1');

      expect(teamMemberRepo.addMember).toHaveBeenCalled();
      // Nothing is written at all now. This used to assert the grant writer was CALLED with
      // `onWorkspaceAdmin: 'skip'` — §2.1 enforced inside the grant. `PM-FR-021` removed the grant
      // itself, so the absence is total and no longer depends on that parameter.
      expect(access.grantProjectAccess).not.toHaveBeenCalled();
    });

    it('returns the new row already badged, so the screen and the next read agree (AC6)', async () => {
      const member = await service.addTeamMember('team-1', 'wa-1', 'ws-1', 'actor-1');

      expect(member.isWorkspaceAdmin).toBe(true);
    });

    it('adds nobody implicitly — a new Team gets only the members it names (AC2)', async () => {
      await service.createTeam(
        'ws-1',
        { name: 'Team Gamma', key: 'TG', projectIds: ['proj-1'], memberUserIds: [] },
        'actor-1',
      );

      expect(teamMemberRepo.setMembers).toHaveBeenCalledWith(
        'ws-1',
        expect.any(String),
        [],
        expect.anything(),
      );
    });
  });

  /**
   * DELETE, and the two things it refuses (workspace Archive surface).
   *
   * Until now a team could only be archived, and archiving was a one-way door: `GET /projects/:id/teams`
   * narrows to active teams by design, so an archived one was invisible everywhere and nothing could
   * remove a team created by mistake. Delete now exists, and it is deliberately narrow — DB design §488
   * ("Archive Team does not delete the linked Work Item/Sprint history") is kept by refusing whenever
   * there IS history, rather than by refusing always.
   *
   * The guard cannot be left to Postgres, which is why it is asserted here: `work_items.team_id`,
   * `tasks.team_id`, `iterations.team_id` and `portfolio_items.team_id` have no foreign key at all, and
   * `member_capacity` / `iteration_daily_snapshots` / the two baseline tables are ON DELETE CASCADE. The
   * database would accept this delete and take frozen report history with it.
   */
  /**
   * A team key could not be changed through any supported path, while the create form fills one in
   * from the name — so renaming a team left the old name's key behind. `OBSERVABIL`, the 10-character
   * truncation of `Observability`, stayed on a team called `DevOps` until it was fixed in the database
   * by hand. A team key never prefixed an item id, so nothing but display depended on it.
   */
  describe('correcting a team key after a rename', () => {
    it('changes the key when one is supplied, uppercased like create does', async () => {
      teamRepo.findById.mockResolvedValue(mockTeam({ key: 'OBSERVABIL' }));
      teamRepo.findByKey.mockResolvedValue(null);

      await service.updateTeam('team-1', { key: 'devops' }, 'ws-1', 'actor-1');

      expect(teamRepo.update).toHaveBeenCalledWith(
        'team-1',
        expect.objectContaining({ key: 'DEVOPS' }),
        expect.anything(),
      );
    });

    it('leaves the key alone when only the name changes', async () => {
      teamRepo.findById.mockResolvedValue(mockTeam({ key: 'MT' }));

      await service.updateTeam('team-1', { name: 'Maintainer' }, 'ws-1', 'actor-1');

      expect(teamRepo.findByKey).not.toHaveBeenCalled();
      expect(teamRepo.update).toHaveBeenCalledWith(
        'team-1',
        expect.not.objectContaining({ key: expect.anything() }),
        expect.anything(),
      );
    });

    it('refuses a key already held by another team in the workspace', async () => {
      teamRepo.findById.mockResolvedValue(mockTeam({ id: 'team-1', key: 'OBSERVABIL' }));
      teamRepo.findByKey.mockResolvedValue(mockTeam({ id: 'team-2', key: 'DEVOPS' }));

      await expect(
        service.updateTeam('team-1', { key: 'DEVOPS' }, 'ws-1', 'actor-1'),
      ).rejects.toThrow(ConflictException);
    });

    it('accepts the key the team already has', async () => {
      teamRepo.findById.mockResolvedValue(mockTeam({ id: 'team-1', key: 'AIP' }));

      await expect(
        service.updateTeam('team-1', { key: 'AIP', name: 'AI Platform' }, 'ws-1', 'actor-1'),
      ).resolves.toBeDefined();
      expect(teamRepo.findByKey).not.toHaveBeenCalled();
    });
  });

  describe('deleteTeam', () => {
    it('refuses an ACTIVE team — delete is an operation on the archive', async () => {
      teamRepo.findById.mockResolvedValue(mockTeam({ status: 'active' }));

      await expect(service.deleteTeam('team-1', 'ws-1', 'actor-1')).rejects.toMatchObject({
        code: 'TEAM_NOT_ARCHIVED',
      });
      expect(teamRepo.deleteTeam).not.toHaveBeenCalled();
      // Not even asked: the state check comes first, so a wrong-state request costs no query.
      expect(teamRepo.countHistoryReferences).not.toHaveBeenCalled();
    });

    it('refuses an archived team that still holds history, and NAMES what holds it', async () => {
      teamRepo.findById.mockResolvedValue(mockTeam({ status: 'archived' }));
      teamRepo.countHistoryReferences.mockResolvedValue([
        { source: 'work items', count: 3 },
        { source: 'iterations', count: 1 },
      ]);

      await expect(service.deleteTeam('team-1', 'ws-1', 'actor-1')).rejects.toMatchObject({
        code: 'TEAM_HAS_HISTORY',
        // The counts are the actionable part — "cannot delete" without them is a dead end.
        message: expect.stringContaining('3 work items, 1 iterations'),
      });
      expect(teamRepo.deleteTeam).not.toHaveBeenCalled();
    });

    it('deletes an archived team with no history', async () => {
      teamRepo.findById.mockResolvedValue(mockTeam({ status: 'archived' }));

      await service.deleteTeam('team-1', 'ws-1', 'actor-1');

      // The audit row is asserted over real HTTP instead: this file's `AuditProducer` is an inline
      // mock with no handle, and a destructive action's trail is worth proving against the real
      // emitter rather than a stub.
      expect(teamRepo.deleteTeam).toHaveBeenCalledWith('team-1', 'ws-1', expect.anything());
    });

    it('drops the permission cache of everyone who was on the roster', async () => {
      // RBE-06 grants project access FROM a roster row, so the members' cached assignments are stale
      // the moment the team stops existing. Read BEFORE the delete, or there is no roster left to read.
      teamRepo.findById.mockResolvedValue(mockTeam({ status: 'archived' }));
      teamMemberRepo.listByTeam.mockResolvedValue([{ userId: 'user-2' }, { userId: 'user-3' }]);

      await service.deleteTeam('team-1', 'ws-1', 'actor-1');

      expect(access.invalidateUsers).toHaveBeenCalledWith('ws-1', ['user-2', 'user-3']);
    });

    it('refuses a team from another workspace as NOT FOUND, before anything else', async () => {
      teamRepo.findById.mockResolvedValue(null);

      await expect(service.deleteTeam('foreign', 'ws-1', 'actor-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(teamRepo.deleteTeam).not.toHaveBeenCalled();
    });
  });

  it('leaves the unscoped listTeams alone — it is the internal validation helper', async () => {
    // `ProjectsService` calls it to validate team ids on a write it has already authorized. If a
    // future change routes an HTTP read through it, this test is the reminder that it is NOT scoped.
    await service.listTeams('ws-1');

    expect(access.listReadableProjectIds).not.toHaveBeenCalled();
  });
});
