import { Inject, Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import {
  NotFoundException,
  PreconditionFailedException,
  UnitOfWork,
  between,
  isDuplicateKeyError,
} from '@platform';
import type { JwtPayload, CursorPayload, PagedResult } from '@platform';
import { WorkItemsService } from '@modules/work-items';
import { AccessService } from '@modules/access';
import { ProjectsService } from '@modules/projects';
import { ActivityLogger } from '@modules/activity';
import {
  ITestCaseRepository,
  TEST_CASE_REPOSITORY,
  TestCaseTypeOption,
} from '../domain/ports/test-case.repository';
import type { TestCase } from '../domain/test-case.types';

export interface CreateTestCaseCommand {
  name: string;
  type?: string;
  method?: 'manual' | 'automated';
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  ownerId?: string;
  assigneeId?: string;
}

@Injectable()
export class TestCasesService {
  private readonly logger = new Logger(TestCasesService.name);

  constructor(
    @Inject(TEST_CASE_REPOSITORY) private readonly testCaseRepo: ITestCaseRepository,
    private readonly workItemsService: WorkItemsService,
    private readonly accessService: AccessService,
    private readonly projectsService: ProjectsService,
    private readonly activityLogger: ActivityLogger,
    private readonly uow: UnitOfWork,
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

  /** Live Types for the Create modal's dropdown, and BR2's "first selectable" source. */
  async listSelectableTypes(actor: JwtPayload, projectId: string): Promise<TestCaseTypeOption[]> {
    return this.testCaseRepo.listSelectableTypes(projectId, actor.workspaceId);
  }

  /**
   * Create a Test Case under a Work Item (SRS §5, Phase B).
   *
   * Authorization is `test_case:create` on the route (`@RequirePermission`, scoped to the Work Item
   * param) — this method still calls `getWorkItemForView` first because it needs the parent's
   * `projectId`/`teamId` to inherit (BR5) and its own read/team-scope check (BR19) before writing
   * anything under it.
   */
  async create(
    actor: JwtPayload,
    workItemId: string,
    input: CreateTestCaseCommand,
  ): Promise<TestCase> {
    const workItem = await this.requireReadableWorkItem(actor, workItemId);

    // BR2: an explicit Type must be one of the project's own live Types (it is stored as a text
    // SNAPSHOT, D8, so nothing re-validates it after this) — otherwise default to the first
    // selectable one. No live Types at all (a fresh project ahead of Phase G's create-hook backfill,
    // per Phase A's A16 note) means no default and no explicit value can be honoured either.
    const selectableTypes = await this.testCaseRepo.listSelectableTypes(
      workItem.projectId,
      actor.workspaceId,
    );
    let type: string;
    if (input.type !== undefined) {
      const match = selectableTypes.find((t) => t.name === input.type);
      if (!match) {
        throw new PreconditionFailedException(
          'TEST_CASE_TYPE_NOT_SELECTABLE',
          `"${input.type}" is not a selectable Type for this project`,
        );
      }
      type = match.name;
    } else {
      if (selectableTypes.length === 0) {
        throw new PreconditionFailedException(
          'TEST_CASE_TYPE_NOT_SELECTABLE',
          'This project has no selectable Test Case Types',
        );
      }
      type = selectableTypes[0].name;
    }

    // BR4/BR8: Owner is gated by the SAME rule the picker feed offers (ProjectsService's ONE
    // assignment-eligibility rule) — never a second candidate query. Assigned To has no such gate
    // (BR6/BR8: "Assigned To" options are project members too, but SRS names no eligibility refusal
    // for it beyond BR8's picker/write agreement, which `assertAssignable` also covers).
    if (input.ownerId) {
      await this.projectsService.assertAssignable(
        actor.workspaceId,
        workItem.projectId,
        workItem.teamId ?? null,
        input.ownerId,
      );
    }
    if (input.assigneeId) {
      await this.projectsService.assertAssignable(
        actor.workspaceId,
        workItem.projectId,
        workItem.teamId ?? null,
        input.assigneeId,
      );
    }

    const MAX_KEY_RETRIES = 2;
    let created: TestCase | undefined;
    let lastErr: unknown;

    for (let attempt = 0; attempt < MAX_KEY_RETRIES; attempt++) {
      try {
        created = await this.uow.run(async (tx) => {
          // BR7: ranks AFTER existing Test Cases of the SAME Work Item. Lock, then read the max, then
          // insert — all on `tx` — or two concurrent creates read the same max and derive the same
          // rank (CLAUDE.md: this already happened to work items in 22 scopes).
          await this.testCaseRepo.lockRankScope(workItemId, tx);
          const maxRank = await this.testCaseRepo.findMaxRank(workItemId, actor.workspaceId, tx);
          const rank = between(maxRank, null);
          const keyNumber = await this.testCaseRepo.nextKeyNumber(actor.workspaceId, tx);

          const row = await this.testCaseRepo.create(
            {
              id: uuidv7(),
              workspaceId: actor.workspaceId,
              projectId: workItem.projectId,
              teamId: workItem.teamId ?? null,
              workItemId,
              testCaseKey: `TC-${keyNumber}`,
              name: input.name,
              type,
              method: input.method ?? 'manual',
              priority: input.priority ?? 'normal',
              ownerId: input.ownerId ?? null,
              assigneeId: input.assigneeId ?? null,
              rank,
              createdBy: actor.sub,
            },
            tx,
          );

          // contextId = the parent Work Item's id, so the Story's own Revision History includes
          // this row — the entire reason `context_id` exists on `activity_logs` (CLAUDE.md).
          await this.activityLogger.log(
            [
              this.activityLogger.build(
                {
                  workspaceId: actor.workspaceId,
                  projectId: workItem.projectId,
                  entityType: 'test_case',
                  entityId: row.id,
                  contextId: workItemId,
                },
                actor.sub,
                'test_case.created',
                null,
                { name: row.name, testCaseKey: row.testCaseKey },
              ),
            ],
            { tx },
          );

          return row;
        });
        break;
      } catch (err) {
        lastErr = err;
        if (isDuplicateKeyError(err) && attempt < MAX_KEY_RETRIES - 1) {
          this.logger.warn(
            { workItemId, attempt: attempt + 1 },
            'Duplicate test case key on create — retrying with next key',
          );
          continue;
        }
        throw err;
      }
    }

    if (!created) throw lastErr;
    return created;
  }
}
