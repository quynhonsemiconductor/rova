import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { ConflictException, NotFoundException, UnitOfWork } from '@platform';
import {
  ITestCaseTypeRepository,
  TEST_CASE_TYPE_REPOSITORY,
  TestCaseType,
} from '../domain/ports/test-case-type.repository';
import { ProjectsService } from '@modules/projects';

/**
 * The per-project Type catalog (SRS §3, Phase G). Modelled on `ProjectsService`'s own Label CRUD
 * (`createLabel`/`updateLabel`/`deleteLabel`) — same "resolve the project, then write" shape —
 * with one addition Labels never needed: BR16's case-insensitive uniqueness pre-check, so a
 * caller gets `TEST_CASE_TYPE_NAME_TAKEN` instead of a raw `uq_test_case_types_name` violation.
 *
 * `POST`/`DELETE` are gated `workspace:edit` at the ROUTE (workspace-tier, Workspace-Admin-only —
 * CLAUDE.md: "A per-Project Admin has NO structural authority"), so this service does not
 * re-check the actor's role; it only re-scopes the project id to the caller's own workspace,
 * exactly like `ProjectsService.updateEstimationSettings`.
 */
@Injectable()
export class TestCaseTypesService {
  constructor(
    @Inject(TEST_CASE_TYPE_REPOSITORY) private readonly typeRepo: ITestCaseTypeRepository,
    private readonly projectsService: ProjectsService,
    private readonly uow: UnitOfWork,
  ) {}

  /**
   * `GET /projects/:id/test-case-types` — `test_case:view`-gated at the route, no resource key.
   * ONE feed for both the Create modal's dropdown (Phase B) and Settings' chip list (G4) — see
   * `ITestCaseTypeRepository`'s own docblock for why there is no second "management" read.
   */
  async listSelectable(
    workspaceId: string,
    projectId: string,
  ): Promise<Awaited<ReturnType<ITestCaseTypeRepository['listSelectable']>>> {
    await this.projectsService.getProject(workspaceId, projectId);
    return this.typeRepo.listSelectable(projectId, workspaceId);
  }

  /**
   * BR16: name required, trimmed, ≤60 chars (enforced by the request schema before this method
   * runs), case-insensitively unique per project. The pre-check reads through the SAME
   * `findByName` the constraint itself would refuse on, so a caller never sees a raw 500 from
   * `uq_test_case_types_name` — it sees this exception first.
   */
  async create(workspaceId: string, projectId: string, name: string): Promise<TestCaseType> {
    await this.projectsService.getProject(workspaceId, projectId);

    const trimmed = name.trim();
    const existing = await this.typeRepo.findByName(projectId, workspaceId, trimmed);
    if (existing) {
      throw new ConflictException(
        'TEST_CASE_TYPE_NAME_TAKEN',
        `"${trimmed}" already exists as a Test Case Type in this project`,
      );
    }

    return this.uow.run(async (tx) => {
      const position = await this.typeRepo.nextPosition(projectId, workspaceId, tx);
      return this.typeRepo.create(
        { id: uuidv7(), workspaceId, projectId, name: trimmed, position },
        tx,
      );
    });
  }

  /**
   * Soft-hide (`archived_at`), never a hard delete — BR17/AC17: a Test Case keeps rendering its
   * removed Type from its own text snapshot (D8), so nothing here needs to cascade or refuse on
   * account of existing Test Cases using this Type.
   */
  async archive(workspaceId: string, projectId: string, typeId: string): Promise<void> {
    await this.projectsService.getProject(workspaceId, projectId);
    const archived = await this.typeRepo.archive(typeId, projectId, workspaceId);
    if (!archived) {
      throw new NotFoundException('TEST_CASE_TYPE_NOT_FOUND', 'Test Case Type not found');
    }
  }
}
