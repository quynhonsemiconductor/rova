/**
 * `TestCasesService` has one authorization rule (BR19): a Test Case is readable exactly when its
 * parent Work Item is. `WorkItemsService.getWorkItemForView` already asserts `work_item:view` +
 * team scope (`assertTeamScope`) on the parent — this module adds NO second team predicate (D7),
 * so what is pinned here is that `requireReadableWorkItem` runs BEFORE any repository read, on
 * every path, and that a refusal on the parent propagates rather than being swallowed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@platform';
import { WorkItemsService } from '@modules/work-items';
import { AccessService } from '@modules/access';
import { TestCasesService } from './test-cases.service';
import { TEST_CASE_REPOSITORY } from '../domain/ports/test-case.repository';
import type { TestCase } from '../domain/test-case.types';

const actor = { sub: 'user-1', workspaceId: 'ws-1' } as never;

const TEST_CASE: TestCase = {
  id: 'tc-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  teamId: 'team-1',
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
  };
  let workItems: { getWorkItemForView: ReturnType<typeof vi.fn> };
  let access: { resolveTeamScope: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    repo = {
      listByWorkItem: vi
        .fn()
        .mockResolvedValue({
          data: [TEST_CASE],
          pageInfo: { hasNextPage: false, limit: 50, nextCursor: null, total: 1 },
        }),
      countByWorkItem: vi.fn().mockResolvedValue(1),
      findById: vi.fn().mockResolvedValue(TEST_CASE),
      findByKey: vi.fn().mockResolvedValue(TEST_CASE),
    };
    workItems = {
      getWorkItemForView: vi.fn().mockResolvedValue({ id: 'wi-1', projectId: 'proj-1' }),
    };
    access = { resolveTeamScope: vi.fn().mockResolvedValue({ unrestricted: true }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TestCasesService,
        { provide: TEST_CASE_REPOSITORY, useValue: repo },
        { provide: WorkItemsService, useValue: workItems },
        { provide: AccessService, useValue: access },
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
  });
});
