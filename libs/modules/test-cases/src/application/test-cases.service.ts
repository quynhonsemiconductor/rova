import { Inject, Injectable } from '@nestjs/common';
import { NotFoundException } from '@platform';
import type { JwtPayload, CursorPayload, PagedResult } from '@platform';
import { WorkItemsService } from '@modules/work-items';
import { AccessService } from '@modules/access';
import { ITestCaseRepository, TEST_CASE_REPOSITORY } from '../domain/ports/test-case.repository';
import type { TestCase } from '../domain/test-case.types';

@Injectable()
export class TestCasesService {
  constructor(
    @Inject(TEST_CASE_REPOSITORY) private readonly testCaseRepo: ITestCaseRepository,
    private readonly workItemsService: WorkItemsService,
    private readonly accessService: AccessService,
  ) {}

  /**
   * A Test Case is readable exactly when its parent Work Item is (BR19) — `getWorkItemForView`
   * already authorises `work_item:view` on the item's own project AND its Team scope
   * (`assertTeamScope`), which is the ONE team check this module needs (D7: no second team
   * predicate on `test_cases`). Every read below calls this before touching the repository.
   */
  private async requireReadableWorkItem(actor: JwtPayload, workItemId: string) {
    return this.workItemsService.getWorkItemForView(actor, workItemId);
  }

  async list(
    actor: JwtPayload,
    workItemId: string,
    args: { limit: number; cursor: CursorPayload | null },
  ): Promise<PagedResult<TestCase>> {
    const workItem = await this.requireReadableWorkItem(actor, workItemId);
    const scope = await this.accessService.resolveTeamScope(
      actor.workspaceId,
      actor.sub,
      workItem.projectId,
    );
    return this.testCaseRepo.listByWorkItem(workItemId, actor.workspaceId, args, scope);
  }

  async getById(actor: JwtPayload, id: string): Promise<TestCase> {
    const testCase = await this.testCaseRepo.findById(id, actor.workspaceId);
    if (!testCase) {
      throw new NotFoundException('TEST_CASE_NOT_FOUND', 'Test case not found');
    }
    // BR19: readable exactly when its parent Work Item is. A Test Case in Phase A always has one
    // (D2's nullable column has no work-item-less write path yet), so this is never skipped here.
    if (testCase.workItemId) {
      await this.requireReadableWorkItem(actor, testCase.workItemId);
    }
    return testCase;
  }

  /**
   * `GET /test-cases/by-key/:key` deliberately carries no `@RequirePermission` (keys are
   * workspace-unique, so the owning project is unknown until the row loads) — the same shape as
   * `WorkItemsService.getWorkItemByKey`. This method IS the authorization: resolve, then check.
   */
  async getByKey(actor: JwtPayload, testCaseKey: string): Promise<TestCase> {
    const testCase = await this.testCaseRepo.findByKey(testCaseKey, actor.workspaceId);
    if (!testCase) {
      throw new NotFoundException('TEST_CASE_NOT_FOUND', `Test case ${testCaseKey} not found`);
    }
    if (testCase.workItemId) {
      await this.requireReadableWorkItem(actor, testCase.workItemId);
    }
    return testCase;
  }
}
