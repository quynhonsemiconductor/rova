/**
 * `TestResultsService` has the SAME BR19/BR20 shape as `TestCasesService`: a Result is readable
 * exactly when its Test Case is, so `TestCasesService.getById` runs BEFORE any repository read or
 * write on every path. What is pinned here that is specific to Results: BR13's snapshot (the
 * `workItemId` passed to `create` is read off the JUST-LOADED Test Case, not stored or re-derived
 * elsewhere), BR8's tester eligibility gate, BR11's required fields (enforced by the zod schema at
 * the controller boundary — not re-asserted here), BR12's pure-append shape, and the key
 * retry-once-on-conflict loop mirroring `TestCasesService.create`'s.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, PreconditionFailedException, UnitOfWork } from '@platform';
import { ProjectsService } from '@modules/projects';
import { ActivityLogger } from '@modules/activity';
import { EntityAttachmentsService } from '@modules/attachments';
import { TestResultsService } from './test-results.service';
import { TestCasesService } from './test-cases.service';
import { TEST_RESULT_REPOSITORY } from '../domain/ports/test-result.repository';
import type { TestResult } from '../domain/test-result.types';
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

const TEST_RESULT: TestResult = {
  id: 'tr-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  testCaseId: 'tc-1',
  workItemId: 'wi-1',
  testResultKey: 'TR-1',
  build: 'build-1',
  runDate: '2026-09-01',
  verdict: 'pass',
  durationMinutes: 0,
  testerId: 'user-1',
  testerName: 'Admin',
  notes: null,
  createdBy: 'user-1',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

describe('TestResultsService', () => {
  let service: TestResultsService;
  let repo: {
    listByTestCase: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    nextKeyNumber: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    softDelete: ReturnType<typeof vi.fn>;
  };
  let testCases: { getById: ReturnType<typeof vi.fn> };
  let projects: { assertAssignable: ReturnType<typeof vi.fn> };
  let activity: {
    log: ReturnType<typeof vi.fn>;
    build: ReturnType<typeof vi.fn>;
    buildDiff: ReturnType<typeof vi.fn>;
    listFor: ReturnType<typeof vi.fn>;
  };
  let attachments: {
    presign: ReturnType<typeof vi.fn>;
    confirm: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    downloadUrl: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    repo = {
      listByTestCase: vi.fn().mockResolvedValue([TEST_RESULT]),
      findById: vi.fn().mockResolvedValue(TEST_RESULT),
      nextKeyNumber: vi.fn().mockResolvedValue(1),
      create: vi.fn().mockResolvedValue(TEST_RESULT),
      update: vi.fn().mockResolvedValue(TEST_RESULT),
      softDelete: vi.fn().mockResolvedValue(undefined),
    };
    testCases = { getById: vi.fn().mockResolvedValue(TEST_CASE) };
    projects = { assertAssignable: vi.fn().mockResolvedValue(undefined) };
    activity = {
      log: vi.fn().mockResolvedValue(undefined),
      build: vi.fn().mockReturnValue({}),
      buildDiff: vi.fn().mockReturnValue([]),
      listFor: vi.fn().mockResolvedValue({ data: [], total: 0 }),
    };
    attachments = {
      presign: vi
        .fn()
        .mockResolvedValue({ attachmentId: 'a-1', uploadUrl: 'u', requiredHeaders: {} }),
      confirm: vi.fn().mockResolvedValue({ id: 'a-1' }),
      list: vi.fn().mockResolvedValue([]),
      downloadUrl: vi.fn().mockResolvedValue({ downloadUrl: 'u' }),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TestResultsService,
        { provide: TEST_RESULT_REPOSITORY, useValue: repo },
        { provide: TestCasesService, useValue: testCases },
        { provide: ProjectsService, useValue: projects },
        { provide: ActivityLogger, useValue: activity },
        { provide: EntityAttachmentsService, useValue: attachments },
        // The repository is mocked, so a real transaction adds nothing here — the retry-once
        // loop and the executor threading are proven in e2e against a real database.
        { provide: UnitOfWork, useValue: { run: (fn: (tx: unknown) => unknown) => fn({}) } },
      ],
    }).compile();

    service = module.get(TestResultsService);
  });

  describe('list', () => {
    it('authorises the Test Case BEFORE reading any Result (BR19/BR20)', async () => {
      await service.list(actor, 'tc-1');

      expect(testCases.getById).toHaveBeenCalledWith(actor, 'tc-1');
      expect(repo.listByTestCase).toHaveBeenCalledWith('tc-1', 'ws-1');
    });

    it('propagates a refusal on the Test Case without touching the repository', async () => {
      testCases.getById.mockRejectedValue(
        new NotFoundException('TEST_CASE_NOT_FOUND', 'no such case'),
      );

      await expect(service.list(actor, 'tc-1')).rejects.toThrow('no such case');
      expect(repo.listByTestCase).not.toHaveBeenCalled();
    });
  });

  describe('getById', () => {
    it('404s when the Result itself does not exist', async () => {
      repo.findById.mockResolvedValue(null);

      await expect(service.getById(actor, 'tr-404')).rejects.toThrow('Test result not found');
      expect(testCases.getById).not.toHaveBeenCalled();
    });

    it("authorises the Result's OWN Test Case (BR20) — a Result's scope is its Test Case's", async () => {
      await service.getById(actor, 'tr-1');

      expect(testCases.getById).toHaveBeenCalledWith(actor, 'tc-1');
    });
  });

  describe('create', () => {
    const COMMAND = {
      build: 'build-1',
      runDate: '2026-09-01',
      verdict: 'pass' as const,
      testerId: 'user-1',
    };

    it('BR19/BR20: authorises the Test Case before validating or writing anything', async () => {
      await service.create(actor, 'tc-1', COMMAND);

      expect(testCases.getById).toHaveBeenCalledWith(actor, 'tc-1');
    });

    it('BR13: snapshots workItemId from the JUST-LOADED Test Case, verbatim', async () => {
      testCases.getById.mockResolvedValue({ ...TEST_CASE, workItemId: 'wi-different' });

      await service.create(actor, 'tc-1', COMMAND);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ workItemId: 'wi-different', testCaseId: 'tc-1' }),
        expect.anything(),
      );
    });

    it('BR13: a NULL Work Item on the Test Case snapshots as null, not skipped or defaulted', async () => {
      testCases.getById.mockResolvedValue({ ...TEST_CASE, workItemId: null });

      await service.create(actor, 'tc-1', COMMAND);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ workItemId: null }),
        expect.anything(),
      );
    });

    it('BR8/BR11: gates testerId through the SAME assertAssignable rule as Owner/Assigned To', async () => {
      await service.create(actor, 'tc-1', COMMAND);

      expect(projects.assertAssignable).toHaveBeenCalledWith('ws-1', 'proj-1', 'team-1', 'user-1');
    });

    it('BR8: an ineligible tester is refused before any write', async () => {
      projects.assertAssignable.mockRejectedValue(
        new PreconditionFailedException('WORK_ITEM_ASSIGNEE_NOT_ELIGIBLE', 'not eligible'),
      );

      await expect(service.create(actor, 'tc-1', COMMAND)).rejects.toThrow('not eligible');
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('BR11: durationMinutes defaults to 0 when omitted', async () => {
      await service.create(actor, 'tc-1', COMMAND);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ durationMinutes: 0 }),
        expect.anything(),
      );
    });

    it('mints the key as TR-<nextKeyNumber>', async () => {
      repo.nextKeyNumber.mockResolvedValue(7);

      await service.create(actor, 'tc-1', COMMAND);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ testResultKey: 'TR-7' }),
        expect.anything(),
      );
    });

    it('retries ONCE on a duplicate key conflict, then succeeds', async () => {
      const dupErr = Object.assign(new Error('duplicate'), { code: '23505' });
      repo.create.mockRejectedValueOnce(dupErr).mockResolvedValueOnce(TEST_RESULT);

      const result = await service.create(actor, 'tc-1', COMMAND);

      expect(repo.create).toHaveBeenCalledTimes(2);
      expect(result).toEqual(TEST_RESULT);
    });

    it('does NOT retry a non-duplicate error', async () => {
      repo.create.mockRejectedValue(new Error('some other db error'));

      await expect(service.create(actor, 'tc-1', COMMAND)).rejects.toThrow('some other db error');
      expect(repo.create).toHaveBeenCalledTimes(1);
    });

    it('BR12: never reads or touches any OTHER Result — create is pure append', async () => {
      await service.create(actor, 'tc-1', COMMAND);

      // Phase E added `update`/`softDelete` to the port for its OWN entry points
      // (`TestResultsService.update`/`delete`) — `create` itself must never reach either, or an
      // "append" would silently become an edit of some other row.
      expect(repo.update).not.toHaveBeenCalled();
      expect(repo.softDelete).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    const PATCH = { verdict: 'fail' as const };

    it('404s when the Result itself does not exist', async () => {
      repo.findById.mockResolvedValue(null);

      await expect(service.update(actor, 'tr-404', PATCH)).rejects.toThrow('Test result not found');
      expect(testCases.getById).not.toHaveBeenCalled();
    });

    it("BR19/BR20: authorises the Result's OWN Test Case before writing anything", async () => {
      await service.update(actor, 'tr-1', PATCH);

      expect(testCases.getById).toHaveBeenCalledWith(actor, 'tc-1');
      expect(repo.update).toHaveBeenCalledWith('tr-1', PATCH, 'ws-1', expect.anything());
    });

    it('BR8: re-gates testerId through assertAssignable only when it is ACTUALLY CHANGING', async () => {
      await service.update(actor, 'tr-1', { testerId: TEST_RESULT.testerId });

      expect(projects.assertAssignable).not.toHaveBeenCalled();
    });

    it('BR8: gates a CHANGED testerId through the same assertAssignable rule as create', async () => {
      await service.update(actor, 'tr-1', { testerId: 'user-2' });

      expect(projects.assertAssignable).toHaveBeenCalledWith('ws-1', 'proj-1', 'team-1', 'user-2');
    });

    it('BR8: an ineligible new tester is refused before any write', async () => {
      projects.assertAssignable.mockRejectedValue(
        new PreconditionFailedException('WORK_ITEM_ASSIGNEE_NOT_ELIGIBLE', 'not eligible'),
      );

      await expect(service.update(actor, 'tr-1', { testerId: 'user-2' })).rejects.toThrow(
        'not eligible',
      );
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('logs a scalar-only diff, contextId = the Test Case id', async () => {
      await service.update(actor, 'tr-1', PATCH);

      expect(activity.buildDiff).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'test_result', entityId: 'tr-1', contextId: 'tc-1' }),
        'user-1',
        TEST_RESULT,
        PATCH,
        expect.anything(),
        'test_result.updated',
      );
      expect(activity.log).toHaveBeenCalled();
    });

    it('BR13: never touches testCaseId/workItemId even if handed them', async () => {
      await service.update(actor, 'tr-1', { ...PATCH });

      const [, sentInput] = repo.update.mock.calls[0];
      expect(sentInput).not.toHaveProperty('testCaseId');
      expect(sentInput).not.toHaveProperty('workItemId');
    });
  });

  describe('delete', () => {
    it('404s when the Result itself does not exist', async () => {
      repo.findById.mockResolvedValue(null);

      await expect(service.delete(actor, 'tr-404')).rejects.toThrow('Test result not found');
      expect(testCases.getById).not.toHaveBeenCalled();
    });

    it('BR19/BR20: authorises the Test Case, then soft-deletes and logs', async () => {
      await service.delete(actor, 'tr-1');

      expect(testCases.getById).toHaveBeenCalledWith(actor, 'tc-1');
      expect(repo.softDelete).toHaveBeenCalledWith('tr-1', 'ws-1', expect.anything());
      expect(activity.log).toHaveBeenCalledWith(
        [expect.anything()],
        expect.objectContaining({ tx: expect.anything() }),
      );
    });
  });

  describe('getActivity', () => {
    it("BR20: authorises via getById (the record's own scoped read) before listing", async () => {
      await service.getActivity(actor, 'tr-1', { limit: 50, offset: 0 });

      expect(testCases.getById).toHaveBeenCalledWith(actor, 'tc-1');
      expect(activity.listFor).toHaveBeenCalledWith('tr-1', 'ws-1', 1, 50);
    });
  });

  describe('attachments (E2)', () => {
    it('every attachment method authorises the Result via getById FIRST (BR20)', async () => {
      await service.presignAttachment(actor, 'tr-1', {
        filename: 'f.png',
        mimeType: 'image/png',
        sizeBytes: 10,
        checksumSha256: 'x',
      });
      await service.listAttachments(actor, 'tr-1');
      await service.getAttachmentDownloadUrl(actor, 'tr-1', 'a-1');

      // Each call above triggers its own `getById`/`repo.findById` round trip.
      expect(repo.findById).toHaveBeenCalledTimes(3);
      expect(attachments.presign).toHaveBeenCalled();
      expect(attachments.list).toHaveBeenCalled();
      expect(attachments.downloadUrl).toHaveBeenCalled();
    });
  });
});
