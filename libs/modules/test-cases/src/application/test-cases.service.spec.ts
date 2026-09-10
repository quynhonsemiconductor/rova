/**
 * `TestCasesService` has one authorization rule (BR19): a Test Case is readable exactly when its
 * parent Work Item is. `WorkItemsService.getWorkItemForView` already asserts `work_item:view` +
 * team scope (`assertTeamScope`) on the parent — this module adds NO second team predicate (D7),
 * so what is pinned here is that `requireReadableWorkItem` runs BEFORE any repository read, on
 * every path, and that a refusal on the parent propagates rather than being swallowed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, PreconditionFailedException, UnitOfWork } from '@platform';
import { WorkItemsService } from '@modules/work-items';
import { AccessService } from '@modules/access';
import { ProjectsService } from '@modules/projects';
import { ActivityLogger } from '@modules/activity';
import { EntityAttachmentsService } from '@modules/attachments';
import { TestCasesService } from './test-cases.service';
import { TEST_CASE_REPOSITORY } from '../domain/ports/test-case.repository';
import { TEST_RESULT_REPOSITORY } from '../domain/ports/test-result.repository';
import { TEST_CASE_TYPE_REPOSITORY } from '../domain/ports/test-case-type.repository';
import type { TestCase } from '../domain/test-case.types';

const actor = { sub: 'user-1', workspaceId: 'ws-1' } as never;

const TEST_CASE: TestCase = {
  id: 'tc-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  teamId: 'team-1',
  teamName: 'Team Alpha',
  workItemId: 'wi-1',
  testCaseKey: 'TC-1',
  name: 'Login works',
  description: null,
  objective: null,
  preconditions: null,
  validationInput: null,
  validationExpectedResult: null,
  postconditions: null,
  notes: null,
  type: 'Functional',
  method: 'manual',
  priority: 'normal',
  ownerId: null,
  ownerName: null,
  assigneeId: null,
  assigneeName: null,
  rank: 'a0001',
  lastVerdict: null,
  lastRun: null,
  lastResultId: null,
  createdBy: 'user-1',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

describe('TestCasesService', () => {
  let service: TestCasesService;
  let repo: {
    listByWorkItem: ReturnType<typeof vi.fn>;
    countByWorkItem: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    findByKey: ReturnType<typeof vi.fn>;
    nextKeyNumber: ReturnType<typeof vi.fn>;
    lockRankScope: ReturnType<typeof vi.fn>;
    findMaxRank: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    softDelete: ReturnType<typeof vi.fn>;
    listLiveIdsByWorkItem: ReturnType<typeof vi.fn>;
    softDeleteByWorkItem: ReturnType<typeof vi.fn>;
    findRanksByIds: ReturnType<typeof vi.fn>;
    updateRank: ReturnType<typeof vi.fn>;
  };
  let testResultRepo: { softDeleteByTestCaseIds: ReturnType<typeof vi.fn> };
  let typeRepo: { listSelectable: ReturnType<typeof vi.fn> };
  let workItems: { getWorkItemForView: ReturnType<typeof vi.fn> };
  let access: { resolveTeamScope: ReturnType<typeof vi.fn> };
  let projects: { assertAssignable: ReturnType<typeof vi.fn> };
  let activity: {
    build: ReturnType<typeof vi.fn>;
    buildDiff: ReturnType<typeof vi.fn>;
    log: ReturnType<typeof vi.fn>;
    listFor: ReturnType<typeof vi.fn>;
  };
  let entityAttachments: {
    presign: ReturnType<typeof vi.fn>;
    confirm: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    downloadUrl: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };

  const SELECTABLE_TYPES = [
    { id: 'type-1', name: 'Acceptance', position: 0 },
    { id: 'type-2', name: 'Functional', position: 1 },
  ];

  beforeEach(async () => {
    repo = {
      listByWorkItem: vi.fn().mockResolvedValue({
        data: [TEST_CASE],
        pageInfo: { hasNextPage: false, limit: 50, nextCursor: null, total: 1 },
      }),
      countByWorkItem: vi.fn().mockResolvedValue(1),
      findById: vi.fn().mockResolvedValue(TEST_CASE),
      findByKey: vi.fn().mockResolvedValue(TEST_CASE),
      nextKeyNumber: vi.fn().mockResolvedValue(1),
      lockRankScope: vi.fn().mockResolvedValue(undefined),
      findMaxRank: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(TEST_CASE),
      update: vi.fn().mockResolvedValue(TEST_CASE),
      softDelete: vi.fn().mockResolvedValue(undefined),
      listLiveIdsByWorkItem: vi.fn().mockResolvedValue([]),
      softDeleteByWorkItem: vi.fn().mockResolvedValue(undefined),
      findRanksByIds: vi.fn().mockResolvedValue([]),
      updateRank: vi.fn().mockResolvedValue(undefined),
    };
    testResultRepo = { softDeleteByTestCaseIds: vi.fn().mockResolvedValue(undefined) };
    typeRepo = { listSelectable: vi.fn().mockResolvedValue(SELECTABLE_TYPES) };
    workItems = {
      getWorkItemForView: vi
        .fn()
        .mockResolvedValue({ id: 'wi-1', projectId: 'proj-1', teamId: 'team-1' }),
    };
    access = { resolveTeamScope: vi.fn().mockResolvedValue({ unrestricted: true }) };
    projects = { assertAssignable: vi.fn().mockResolvedValue(undefined) };
    activity = {
      build: vi.fn().mockReturnValue({}),
      buildDiff: vi.fn().mockReturnValue([]),
      log: vi.fn().mockResolvedValue(undefined),
      logSafe: vi.fn().mockResolvedValue(undefined),
      listFor: vi.fn().mockResolvedValue({ data: [], total: 0 }),
    };
    entityAttachments = {
      presign: vi
        .fn()
        .mockResolvedValue({ attachmentId: 'a-1', uploadUrl: '', requiredHeaders: {} }),
      confirm: vi.fn().mockResolvedValue({}),
      list: vi.fn().mockResolvedValue([]),
      downloadUrl: vi.fn().mockResolvedValue({ downloadUrl: 'https://example.test/x' }),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TestCasesService,
        { provide: TEST_CASE_REPOSITORY, useValue: repo },
        { provide: TEST_RESULT_REPOSITORY, useValue: testResultRepo },
        { provide: TEST_CASE_TYPE_REPOSITORY, useValue: typeRepo },
        { provide: WorkItemsService, useValue: workItems },
        { provide: AccessService, useValue: access },
        { provide: ProjectsService, useValue: projects },
        { provide: ActivityLogger, useValue: activity },
        { provide: EntityAttachmentsService, useValue: entityAttachments },
        // Runs the callback with a stub executor: these tests assert the SERVICE's ordering and
        // validation, and the repository is mocked, so a real transaction adds nothing. The
        // advisory-lock/rank behaviour is proven in e2e against a real database.
        { provide: UnitOfWork, useValue: { run: (fn: (tx: unknown) => unknown) => fn({}) } },
      ],
    }).compile();

    service = module.get(TestCasesService);
  });

  describe('list', () => {
    it('authorises the parent Work Item BEFORE reading any Test Case (BR19)', async () => {
      await service.list(actor, 'wi-1', { limit: 50, cursor: null });

      expect(workItems.getWorkItemForView).toHaveBeenCalledWith(actor, 'wi-1');
      expect(repo.listByWorkItem).toHaveBeenCalledWith(
        'wi-1',
        'ws-1',
        { limit: 50, cursor: null },
        {
          unrestricted: true,
        },
      );
    });

    it('propagates a refusal on the parent Work Item without touching the repository', async () => {
      workItems.getWorkItemForView.mockRejectedValue(new Error('WORK_ITEM_NOT_FOUND'));

      await expect(service.list(actor, 'wi-1', { limit: 50, cursor: null })).rejects.toThrow(
        'WORK_ITEM_NOT_FOUND',
      );
      expect(repo.listByWorkItem).not.toHaveBeenCalled();
    });

    it("resolves team scope against the PARENT Work Item's own project", async () => {
      workItems.getWorkItemForView.mockResolvedValue({ id: 'wi-1', projectId: 'proj-9' });

      await service.list(actor, 'wi-1', { limit: 50, cursor: null });

      expect(access.resolveTeamScope).toHaveBeenCalledWith('ws-1', 'user-1', 'proj-9');
    });

    it('forwards an UNRESTRICTED scope unchanged (structural param, never a predicate here)', async () => {
      await service.list(actor, 'wi-1', { limit: 50, cursor: null });

      expect(repo.listByWorkItem.mock.calls[0][3]).toEqual({ unrestricted: true });
    });

    it('forwards an EMPTY editor scope rather than flattening it to unrestricted', async () => {
      // `[]` is a real answer ("no delivery scope"); flattening it would fail closed the wrong
      // direction — the same `null`-versus-`[]` trap `listReadableProjectIds` documents.
      const scope = { unrestricted: false, teamIds: [] };
      access.resolveTeamScope.mockResolvedValue(scope);

      await service.list(actor, 'wi-1', { limit: 50, cursor: null });

      expect(repo.listByWorkItem.mock.calls[0][3]).toEqual({ unrestricted: false, teamIds: [] });
    });
  });

  describe('getById', () => {
    it('throws TEST_CASE_NOT_FOUND before ever consulting the parent Work Item', async () => {
      repo.findById.mockResolvedValue(null);

      await expect(service.getById(actor, 'missing')).rejects.toThrow(NotFoundException);
      expect(workItems.getWorkItemForView).not.toHaveBeenCalled();
    });

    it("authorises the loaded row's parent Work Item (BR19)", async () => {
      await service.getById(actor, 'tc-1');

      expect(workItems.getWorkItemForView).toHaveBeenCalledWith(actor, 'wi-1');
    });

    it('propagates a refusal on the parent Work Item', async () => {
      workItems.getWorkItemForView.mockRejectedValue(new Error('WORK_ITEM_NOT_FOUND'));

      await expect(service.getById(actor, 'tc-1')).rejects.toThrow('WORK_ITEM_NOT_FOUND');
    });
  });

  describe('getByKey', () => {
    it('resolves the row THEN checks — no permission decorator can express this (by-key)', async () => {
      await service.getByKey(actor, 'TC-1');

      expect(repo.findByKey).toHaveBeenCalledWith('TC-1', 'ws-1');
      expect(workItems.getWorkItemForView).toHaveBeenCalledWith(actor, 'wi-1');
    });

    it('names the key back on a miss (TEST_CASE_NOT_FOUND)', async () => {
      repo.findByKey.mockResolvedValue(null);

      await expect(service.getByKey(actor, 'TC-404')).rejects.toThrow(NotFoundException);
      await expect(service.getByKey(actor, 'TC-404')).rejects.toThrow('TC-404');
    });

    it('propagates a refusal on the parent Work Item', async () => {
      workItems.getWorkItemForView.mockRejectedValue(new Error('WORK_ITEM_NOT_FOUND'));

      await expect(service.getByKey(actor, 'TC-1')).rejects.toThrow('WORK_ITEM_NOT_FOUND');
    });

    it('AC-audit fix #1: passes the repository-resolved teamName through untouched, for a real Team', async () => {
      repo.findByKey.mockResolvedValue({
        ...TEST_CASE,
        teamId: 'team-1',
        teamName: 'Team Alpha',
      });

      const result = await service.getByKey(actor, 'TC-1');

      expect(result.teamName).toBe('Team Alpha');
    });

    it('AC-audit fix #1: a null teamId resolves teamName null too — the fallback is a DISPLAY rule, not a repository default', async () => {
      repo.findByKey.mockResolvedValue({ ...TEST_CASE, teamId: null, teamName: null });

      const result = await service.getByKey(actor, 'TC-1');

      expect(result.teamId).toBeNull();
      expect(result.teamName).toBeNull();
    });
  });

  describe('create', () => {
    it('authorises the parent Work Item BEFORE writing anything (BR19)', async () => {
      await service.create(actor, 'wi-1', { name: 'New case' });

      expect(workItems.getWorkItemForView).toHaveBeenCalledWith(actor, 'wi-1');
    });

    it('BR1: requires Name — the schema enforces this, service just forwards it verbatim', async () => {
      await service.create(actor, 'wi-1', { name: 'New case' });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'New case' }),
        expect.anything(),
      );
    });

    it("BR2: defaults Type to the project's FIRST selectable Type when none is given", async () => {
      await service.create(actor, 'wi-1', { name: 'New case' });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'Acceptance' }),
        expect.anything(),
      );
    });

    it('BR2: accepts an explicit Type that IS selectable, storing it as a snapshot', async () => {
      await service.create(actor, 'wi-1', { name: 'New case', type: 'Functional' });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'Functional' }),
        expect.anything(),
      );
    });

    it("refuses an explicit Type that is NOT in the project's selectable list", async () => {
      await expect(
        service.create(actor, 'wi-1', { name: 'New case', type: 'Nonexistent' }),
      ).rejects.toThrow(PreconditionFailedException);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('refuses to default a Type when the project has none selectable', async () => {
      typeRepo.listSelectable.mockResolvedValue([]);

      await expect(service.create(actor, 'wi-1', { name: 'New case' })).rejects.toThrow(
        PreconditionFailedException,
      );
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('BR3: defaults Method to manual and Priority to normal', async () => {
      await service.create(actor, 'wi-1', { name: 'New case' });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'manual', priority: 'normal' }),
        expect.anything(),
      );
    });

    it('BR3: forwards an explicit Method/Priority instead of the default', async () => {
      await service.create(actor, 'wi-1', {
        name: 'New case',
        method: 'automated',
        priority: 'urgent',
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'automated', priority: 'urgent' }),
        expect.anything(),
      );
    });

    it('BR5: inherits Project and Team from the PARENT Work Item, read-only', async () => {
      workItems.getWorkItemForView.mockResolvedValue({
        id: 'wi-1',
        projectId: 'proj-9',
        teamId: 'team-9',
      });

      await service.create(actor, 'wi-1', { name: 'New case' });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'proj-9', teamId: 'team-9', workItemId: 'wi-1' }),
        expect.anything(),
      );
    });

    it('BR5: a team-less (Project backlog) Work Item creates a team-less Test Case', async () => {
      workItems.getWorkItemForView.mockResolvedValue({
        id: 'wi-1',
        projectId: 'proj-1',
        teamId: null,
      });

      await service.create(actor, 'wi-1', { name: 'New case' });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ teamId: null }),
        expect.anything(),
      );
    });

    it('BR6: Assigned To starts Unassigned when omitted', async () => {
      await service.create(actor, 'wi-1', { name: 'New case' });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ assigneeId: null }),
        expect.anything(),
      );
    });

    it('BR4/BR8: gates an explicit Owner through the SAME assignment rule the picker uses', async () => {
      await service.create(actor, 'wi-1', { name: 'New case', ownerId: 'user-2' });

      expect(projects.assertAssignable).toHaveBeenCalledWith('ws-1', 'proj-1', 'team-1', 'user-2');
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'user-2' }),
        expect.anything(),
      );
    });

    it('BR8: gates an explicit Assigned To through the same rule as Owner', async () => {
      await service.create(actor, 'wi-1', { name: 'New case', assigneeId: 'user-3' });

      expect(projects.assertAssignable).toHaveBeenCalledWith('ws-1', 'proj-1', 'team-1', 'user-3');
    });

    it('refuses an ineligible Owner — the write must not accept what the picker would not offer', async () => {
      projects.assertAssignable.mockRejectedValue(
        new PreconditionFailedException(
          'WORK_ITEM_ASSIGNEE_NOT_ELIGIBLE',
          'The selected user is not eligible',
        ),
      );

      await expect(
        service.create(actor, 'wi-1', { name: 'New case', ownerId: 'user-2' }),
      ).rejects.toThrow(PreconditionFailedException);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('skips the eligibility check entirely when no Owner/Assignee is given (BR4/BR6 default)', async () => {
      await service.create(actor, 'wi-1', { name: 'New case' });

      expect(projects.assertAssignable).not.toHaveBeenCalled();
    });

    it('BR7: ranks under a lock, reading the max BEFORE inserting, on the same executor', async () => {
      const calls: string[] = [];
      repo.lockRankScope.mockImplementation(async () => {
        calls.push('lock');
      });
      repo.findMaxRank.mockImplementation(async () => {
        calls.push('findMax');
        return 'a0005';
      });
      repo.create.mockImplementation(async () => {
        calls.push('create');
        return TEST_CASE;
      });

      await service.create(actor, 'wi-1', { name: 'New case' });

      expect(calls).toEqual(['lock', 'findMax', 'create']);
      expect(repo.lockRankScope).toHaveBeenCalledWith('wi-1', expect.anything());
      expect(repo.findMaxRank).toHaveBeenCalledWith('wi-1', 'ws-1', expect.anything());
    });

    it('B2/TX1: logs test_case.created with contextId = the parent Work Item id, via logSafe outside the tx', async () => {
      await service.create(actor, 'wi-1', { name: 'New case' });

      expect(activity.build).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'test_case',
          contextId: 'wi-1',
        }),
        'user-1',
        'test_case.created',
        null,
        expect.anything(),
      );
      expect(activity.logSafe).toHaveBeenCalledWith(expect.anything());
    });

    it('D4: retries ONCE on a duplicate-key race and succeeds on the second attempt', async () => {
      const dupErr = Object.assign(new Error('duplicate'), { code: '23505' });
      repo.create.mockRejectedValueOnce(dupErr).mockResolvedValueOnce(TEST_CASE);

      const result = await service.create(actor, 'wi-1', { name: 'New case' });

      expect(result).toBe(TEST_CASE);
      expect(repo.create).toHaveBeenCalledTimes(2);
    });

    it('D4: does NOT retry a non-duplicate-key error', async () => {
      repo.create.mockRejectedValue(new Error('some other db error'));

      await expect(service.create(actor, 'wi-1', { name: 'New case' })).rejects.toThrow(
        'some other db error',
      );
      expect(repo.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('update (Phase C, SRS §6.3)', () => {
    it('authorises the parent Work Item BEFORE writing anything (BR19)', async () => {
      await service.update(actor, 'tc-1', { name: 'Renamed' });

      expect(workItems.getWorkItemForView).toHaveBeenCalledWith(actor, 'wi-1');
    });

    it('throws TEST_CASE_NOT_FOUND before touching the parent Work Item', async () => {
      repo.findById.mockResolvedValue(null);

      await expect(service.update(actor, 'missing', { name: 'x' })).rejects.toThrow(
        NotFoundException,
      );
      expect(workItems.getWorkItemForView).not.toHaveBeenCalled();
    });

    it('forwards the patch to the repository verbatim, on the transaction executor', async () => {
      await service.update(actor, 'tc-1', { name: 'Renamed' });

      expect(repo.update).toHaveBeenCalledWith(
        'tc-1',
        { name: 'Renamed' },
        'ws-1',
        expect.anything(),
      );
    });

    it('BR5: the schema never carries projectId/teamId/workItemId, so update() has no such input to forward', async () => {
      // The type-level guarantee is `UpdateTestCaseInput` itself (no such fields); this proves the
      // service does not somehow synthesize them into the repository call either.
      await service.update(actor, 'tc-1', { name: 'Renamed' });

      const [, patchArg] = repo.update.mock.calls[0] as [string, Record<string, unknown>];
      expect(patchArg).not.toHaveProperty('projectId');
      expect(patchArg).not.toHaveProperty('teamId');
      expect(patchArg).not.toHaveProperty('workItemId');
    });

    it('BR9: the repository patch never carries lastVerdict/lastRun/lastResultId', async () => {
      await service.update(actor, 'tc-1', { name: 'Renamed' });

      const [, patchArg] = repo.update.mock.calls[0] as [string, Record<string, unknown>];
      expect(patchArg).not.toHaveProperty('lastVerdict');
      expect(patchArg).not.toHaveProperty('lastRun');
      expect(patchArg).not.toHaveProperty('lastResultId');
    });

    it('BR17: re-supplying the SAME Type is always a no-op, even one no longer selectable', async () => {
      // TEST_CASE.type is 'Functional', which IS selectable here — assert the archived case too.
      typeRepo.listSelectable.mockResolvedValue([
        { id: 'type-1', name: 'Acceptance', position: 0 },
      ]);

      await service.update(actor, 'tc-1', { type: 'Functional' });

      expect(repo.update).toHaveBeenCalledWith(
        'tc-1',
        { type: 'Functional' },
        'ws-1',
        expect.anything(),
      );
    });

    it('BR17/BR2: a DIFFERENT Type must be one of the project’s current selectable Types', async () => {
      await expect(service.update(actor, 'tc-1', { type: 'Nonexistent' })).rejects.toThrow(
        'is not a selectable Type',
      );
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('BR8: gates a CHANGED Owner through the same assignment rule as create', async () => {
      await service.update(actor, 'tc-1', { ownerId: 'user-9' });

      expect(projects.assertAssignable).toHaveBeenCalledWith('ws-1', 'proj-1', 'team-1', 'user-9');
    });

    it('BR8: gates a CHANGED Assigned To through the SAME call shape as Owner', async () => {
      await service.update(actor, 'tc-1', { assigneeId: 'user-9' });

      expect(projects.assertAssignable).toHaveBeenCalledWith('ws-1', 'proj-1', 'team-1', 'user-9');
    });

    it('refuses an ineligible Owner — the write must not accept what the picker would not offer', async () => {
      projects.assertAssignable.mockRejectedValue(new Error('WORK_ITEM_ASSIGNEE_NOT_ELIGIBLE'));

      await expect(service.update(actor, 'tc-1', { ownerId: 'user-9' })).rejects.toThrow(
        'WORK_ITEM_ASSIGNEE_NOT_ELIGIBLE',
      );
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('re-saving the SAME Owner is a no-op — must not re-check eligibility (BR8)', async () => {
      // TEST_CASE has no ownerId (null); re-sending null must not be treated as a "change".
      await service.update(actor, 'tc-1', { ownerId: null });

      expect(projects.assertAssignable).not.toHaveBeenCalled();
    });

    it('C3/TX1: logs a scalar-only diff via buildDiff, contextId = the parent Work Item id, via logSafe outside the tx', async () => {
      await service.update(actor, 'tc-1', { name: 'Renamed' });

      expect(activity.buildDiff).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'test_case', entityId: 'tc-1', contextId: 'wi-1' }),
        'user-1',
        expect.anything(),
        { name: 'Renamed' },
        expect.anything(),
        'test_case.updated',
      );
      expect(activity.logSafe).toHaveBeenCalledWith(expect.anything());
    });
  });

  describe('getActivity (C6, BR20)', () => {
    it('goes through the SAME scoped read as the record itself before listing', async () => {
      await service.getActivity(actor, 'tc-1', { limit: 50, offset: 0 });

      expect(repo.findById).toHaveBeenCalledWith('tc-1', 'ws-1');
      expect(workItems.getWorkItemForView).toHaveBeenCalledWith(actor, 'wi-1');
      expect(activity.listFor).toHaveBeenCalledWith('tc-1', 'ws-1', 1, 50);
    });

    it('propagates a refusal on the parent Work Item without ever listing', async () => {
      workItems.getWorkItemForView.mockRejectedValue(new Error('WORK_ITEM_NOT_FOUND'));

      await expect(service.getActivity(actor, 'tc-1', { limit: 50, offset: 0 })).rejects.toThrow(
        'WORK_ITEM_NOT_FOUND',
      );
      expect(activity.listFor).not.toHaveBeenCalled();
    });
  });

  describe('delete (F1/F2)', () => {
    it('goes through the SAME scoped read as every other write before deleting', async () => {
      await service.delete(actor, 'tc-1');

      expect(repo.findById).toHaveBeenCalledWith('tc-1', 'ws-1');
      expect(workItems.getWorkItemForView).toHaveBeenCalledWith(actor, 'wi-1');
    });

    it('propagates a refusal on the parent Work Item without ever deleting', async () => {
      workItems.getWorkItemForView.mockRejectedValue(new Error('WORK_ITEM_NOT_FOUND'));

      await expect(service.delete(actor, 'tc-1')).rejects.toThrow('WORK_ITEM_NOT_FOUND');
      expect(repo.softDelete).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for an unknown id', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.delete(actor, 'missing')).rejects.toThrow(NotFoundException);
    });

    it('soft-deletes its own Results FIRST, then itself, in the SAME transaction', async () => {
      await service.delete(actor, 'tc-1');

      expect(testResultRepo.softDeleteByTestCaseIds).toHaveBeenCalledWith(
        ['tc-1'],
        'ws-1',
        expect.anything(),
      );
      expect(repo.softDelete).toHaveBeenCalledWith('tc-1', 'ws-1', expect.anything());
      const resultsOrder = testResultRepo.softDeleteByTestCaseIds.mock.invocationCallOrder[0];
      const caseOrder = repo.softDelete.mock.invocationCallOrder[0];
      expect(resultsOrder).toBeLessThan(caseOrder);
    });

    it('logs test_case.deleted with contextId = the parent Work Item id, via logSafe outside the tx (TX1)', async () => {
      await service.delete(actor, 'tc-1');

      expect(activity.build).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'test_case', entityId: 'tc-1', contextId: 'wi-1' }),
        'user-1',
        'test_case.deleted',
        null,
        expect.objectContaining({ testCaseKey: 'TC-1' }),
      );
      expect(activity.logSafe).toHaveBeenCalledWith(expect.anything());
    });
  });

  describe('reorder (F3) — neighbour-based, mirrors rankWorkItem', () => {
    beforeEach(() => {
      repo.findRanksByIds.mockResolvedValue([
        { id: 'tc-before', workItemId: 'wi-1', rank: 'a0001' },
        { id: 'tc-after', workItemId: 'wi-1', rank: 'a0009' },
      ]);
    });

    it('goes through the SAME scoped read as every other write before reordering', async () => {
      await service.reorder(actor, 'tc-1', { workItemId: 'wi-1' });
      expect(workItems.getWorkItemForView).toHaveBeenCalledWith(actor, 'wi-1');
    });

    it('computes a rank strictly between the two neighbours and persists it', async () => {
      const result = await service.reorder(actor, 'tc-1', {
        workItemId: 'wi-1',
        beforeId: 'tc-before',
        afterId: 'tc-after',
      });

      expect(repo.updateRank).toHaveBeenCalledWith(
        'tc-1',
        expect.any(String),
        'ws-1',
        expect.anything(),
      );
      const newRank = repo.updateRank.mock.calls[0][1] as string;
      expect(newRank > 'a0001' && newRank < 'a0009').toBe(true);
      expect(result.rank).toBe(newRank);
    });

    it('appends to the end when afterId is null (no upper neighbour)', async () => {
      await service.reorder(actor, 'tc-1', { workItemId: 'wi-1', beforeId: 'tc-before' });
      const newRank = repo.updateRank.mock.calls[0][1] as string;
      expect(newRank > 'a0001').toBe(true);
    });

    it('refuses when the Test Case does not belong to the given Work Item', async () => {
      await expect(service.reorder(actor, 'tc-1', { workItemId: 'wi-DIFFERENT' })).rejects.toThrow(
        PreconditionFailedException,
      );
      expect(repo.updateRank).not.toHaveBeenCalled();
    });

    it('refuses a neighbour from a different Work Item', async () => {
      repo.findRanksByIds.mockResolvedValue([
        { id: 'tc-before', workItemId: 'wi-OTHER', rank: 'a0001' },
      ]);
      await expect(
        service.reorder(actor, 'tc-1', { workItemId: 'wi-1', beforeId: 'tc-before' }),
      ).rejects.toThrow(PreconditionFailedException);
      expect(repo.updateRank).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for an unknown id', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.reorder(actor, 'missing', { workItemId: 'wi-1' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('attachments (C4, BR20)', () => {
    const attachmentInput = {
      filename: 'a.png',
      mimeType: 'image/png',
      sizeBytes: 10,
      checksumSha256: 'x',
    };

    it('presign goes through the SAME scoped read as the record before delegating', async () => {
      await service.presignAttachment(actor, 'tc-1', attachmentInput);

      expect(workItems.getWorkItemForView).toHaveBeenCalledWith(actor, 'wi-1');
      expect(entityAttachments.presign).toHaveBeenCalledWith(
        actor,
        { entityType: 'test_case', entityId: 'tc-1' },
        attachmentInput,
        expect.objectContaining({ surface: 'test-case-attachment' }),
      );
    });

    it('confirm passes the loaded row’s own projectId to the activity log', async () => {
      await service.confirmAttachment(actor, 'tc-1', 'att-1');

      expect(entityAttachments.confirm).toHaveBeenCalledWith(
        actor,
        { entityType: 'test_case', entityId: 'tc-1' },
        'att-1',
        'proj-1',
        expect.objectContaining({ surface: 'test-case-attachment' }),
      );
    });

    it('list refuses when the parent Work Item is out of scope, before ever listing', async () => {
      workItems.getWorkItemForView.mockRejectedValue(new Error('WORK_ITEM_NOT_FOUND'));

      await expect(service.listAttachments(actor, 'tc-1')).rejects.toThrow('WORK_ITEM_NOT_FOUND');
      expect(entityAttachments.list).not.toHaveBeenCalled();
    });

    it('downloadUrl is scoped exactly like every other read — the signed-URL case CLAUDE.md warns about', async () => {
      workItems.getWorkItemForView.mockRejectedValue(new Error('WORK_ITEM_NOT_FOUND'));

      await expect(service.getAttachmentDownloadUrl(actor, 'tc-1', 'att-1')).rejects.toThrow(
        'WORK_ITEM_NOT_FOUND',
      );
      expect(entityAttachments.downloadUrl).not.toHaveBeenCalled();
    });

    it('delete passes the loaded row’s own projectId, after the same scoped read', async () => {
      await service.deleteAttachment(actor, 'tc-1', 'att-1');

      expect(workItems.getWorkItemForView).toHaveBeenCalledWith(actor, 'wi-1');
      expect(entityAttachments.delete).toHaveBeenCalledWith(
        actor,
        { entityType: 'test_case', entityId: 'tc-1' },
        'att-1',
        'proj-1',
      );
    });
  });
});
