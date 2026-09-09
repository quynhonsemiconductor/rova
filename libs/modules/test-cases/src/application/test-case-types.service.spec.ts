/**
 * `TestCaseTypesService` — the Type catalog CRUD (SRS §3, Phase G). `POST`/`DELETE` are
 * `workspace:edit`-gated at the ROUTE (Workspace-Admin-only), so this service's own job is just
 * BR16's case-insensitive uniqueness pre-check and BR17's soft-hide — never an authorization
 * decision of its own beyond re-scoping the project id to the caller's workspace.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException, UnitOfWork } from '@platform';
import { ProjectsService } from '@modules/projects';
import { TestCaseTypesService } from './test-case-types.service';
import { TEST_CASE_TYPE_REPOSITORY } from '../domain/ports/test-case-type.repository';

describe('TestCaseTypesService', () => {
  let service: TestCaseTypesService;
  let typeRepo: {
    listSelectable: ReturnType<typeof vi.fn>;
    findByName: ReturnType<typeof vi.fn>;
    nextPosition: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    archive: ReturnType<typeof vi.fn>;
  };
  let projects: { getProject: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    typeRepo = {
      listSelectable: vi
        .fn()
        .mockResolvedValue([{ id: 'type-1', name: 'Acceptance', position: 0 }]),
      findByName: vi.fn().mockResolvedValue(null),
      nextPosition: vi.fn().mockResolvedValue(1),
      create: vi
        .fn()
        .mockResolvedValue({
          id: 'type-2',
          workspaceId: 'ws-1',
          projectId: 'proj-1',
          name: 'Smoke',
          position: 1,
          archivedAt: null,
        }),
      archive: vi.fn().mockResolvedValue({
        id: 'type-1',
        workspaceId: 'ws-1',
        projectId: 'proj-1',
        name: 'Acceptance',
        position: 0,
        archivedAt: '2026-09-09T00:00:00.000Z',
      }),
    };
    projects = { getProject: vi.fn().mockResolvedValue({ id: 'proj-1' }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TestCaseTypesService,
        { provide: TEST_CASE_TYPE_REPOSITORY, useValue: typeRepo },
        { provide: ProjectsService, useValue: projects },
        { provide: UnitOfWork, useValue: { run: (fn: (tx: unknown) => unknown) => fn({}) } },
      ],
    }).compile();

    service = module.get(TestCaseTypesService);
  });

  describe('listSelectable', () => {
    it('re-scopes the project to the caller workspace before reading the catalog', async () => {
      await service.listSelectable('ws-1', 'proj-1');

      expect(projects.getProject).toHaveBeenCalledWith('ws-1', 'proj-1');
      expect(typeRepo.listSelectable).toHaveBeenCalledWith('proj-1', 'ws-1');
    });
  });

  describe('create (BR16)', () => {
    it('trims the name before the duplicate check and the insert', async () => {
      await service.create('ws-1', 'proj-1', '  Smoke  ');

      expect(typeRepo.findByName).toHaveBeenCalledWith('proj-1', 'ws-1', 'Smoke');
      expect(typeRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Smoke' }),
        expect.anything(),
      );
    });

    it('refuses a case-insensitive duplicate with TEST_CASE_TYPE_NAME_TAKEN, and never inserts', async () => {
      typeRepo.findByName.mockResolvedValue({
        id: 'type-1',
        workspaceId: 'ws-1',
        projectId: 'proj-1',
        name: 'Acceptance',
        position: 0,
        archivedAt: null,
      });

      await expect(service.create('ws-1', 'proj-1', 'acceptance')).rejects.toThrow(
        ConflictException,
      );
      expect(typeRepo.create).not.toHaveBeenCalled();
    });

    it('appends at the next position, resolved on the SAME transaction as the insert', async () => {
      await service.create('ws-1', 'proj-1', 'Smoke');

      expect(typeRepo.nextPosition).toHaveBeenCalledWith('proj-1', 'ws-1', expect.anything());
      const [input, executor] = typeRepo.create.mock.calls[0] as [{ position: number }, unknown];
      expect(input.position).toBe(1);
      expect(executor).toBeDefined();
    });
  });

  describe('archive (BR17)', () => {
    it('re-scopes the project before archiving, and scopes the write to (id, project, workspace)', async () => {
      await service.archive('ws-1', 'proj-1', 'type-1');

      expect(projects.getProject).toHaveBeenCalledWith('ws-1', 'proj-1');
      expect(typeRepo.archive).toHaveBeenCalledWith('type-1', 'proj-1', 'ws-1');
    });

    it('throws TEST_CASE_TYPE_NOT_FOUND when the row is missing, wrong project, or already archived', async () => {
      typeRepo.archive.mockResolvedValue(null);

      await expect(service.archive('ws-1', 'proj-1', 'missing')).rejects.toThrow(NotFoundException);
    });
  });
});
