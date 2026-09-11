import { Inject, Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { NotFoundException, UnitOfWork, isDuplicateKeyError } from '@platform';
import type { JwtPayload } from '@platform';
import { ProjectsService } from '@modules/projects';
import { TestCasesService } from './test-cases.service';
import {
  ITestResultRepository,
  TEST_RESULT_REPOSITORY,
} from '../domain/ports/test-result.repository';
import type { TestResult } from '../domain/test-result.types';

export interface CreateTestResultCommand {
  build: string;
  runDate: string;
  verdict: 'pass' | 'fail' | 'blocked' | 'error' | 'inconclusive';
  durationMinutes?: number;
  testerId: string;
  notes?: string;
}

@Injectable()
export class TestResultsService {
  private readonly logger = new Logger(TestResultsService.name);

  constructor(
    @Inject(TEST_RESULT_REPOSITORY) private readonly testResultRepo: ITestResultRepository,
    private readonly testCasesService: TestCasesService,
    private readonly projectsService: ProjectsService,
    private readonly uow: UnitOfWork,
  ) {}

  /**
   * BR19/BR20, same rule as every Test Case sub-resource: a Result is readable exactly when its
   * own Test Case is, and `TestCasesService.getById` is the SAME scoped read the record route
   * itself uses (BR19's `requireReadableWorkItem` underneath).
   */
  async list(actor: JwtPayload, testCaseId: string): Promise<TestResult[]> {
    await this.testCasesService.getById(actor, testCaseId);
    return this.testResultRepo.listByTestCase(testCaseId, actor.workspaceId);
  }

  async getById(actor: JwtPayload, id: string): Promise<TestResult> {
    const result = await this.testResultRepo.findById(id, actor.workspaceId);
    if (!result) {
      throw new NotFoundException('TEST_RESULT_NOT_FOUND', 'Test result not found');
    }
    // BR20: the SAME scoped read as the record itself — a Result's own project/team scope is its
    // Test Case's, so authorising the Test Case is authorising the Result.
    await this.testCasesService.getById(actor, result.testCaseId);
    return result;
  }

  /**
   * Add a Test Result (SRS §8, Phase D). BR12: pure append — never touches an earlier Result.
   * BR13: `workItemId` is a SNAPSHOT of the Test Case's Work Product taken HERE, at create time —
   * a plain field copy, never a live join and never re-read from the Test Case afterward. BR9's
   * `last_verdict`/`last_run`/`last_result_id` on the parent Test Case are recomputed by
   * `trg_test_case_last_result` (D6) — this method never touches those three columns.
   */
  async create(
    actor: JwtPayload,
    testCaseId: string,
    input: CreateTestResultCommand,
  ): Promise<TestResult> {
    const testCase = await this.testCasesService.getById(actor, testCaseId);

    // BR11/BR8: Tester is required and gated by the SAME assignment-eligibility rule as Owner /
    // Assigned To (`ProjectsService.assertAssignable`) — never a second candidate query.
    await this.projectsService.assertAssignable(
      actor.workspaceId,
      testCase.projectId,
      testCase.teamId,
      input.testerId,
    );

    const MAX_KEY_RETRIES = 2;
    let created: TestResult | undefined;
    let lastErr: unknown;

    for (let attempt = 0; attempt < MAX_KEY_RETRIES; attempt++) {
      try {
        created = await this.uow.run(async (tx) => {
          const keyNumber = await this.testResultRepo.nextKeyNumber(actor.workspaceId, tx);
          return this.testResultRepo.create(
            {
              id: uuidv7(),
              workspaceId: actor.workspaceId,
              projectId: testCase.projectId,
              testCaseId,
              // BR13: the SNAPSHOT, taken now from the Test Case just loaded above — not stored
              // anywhere else, and never re-read from the Test Case on a later write.
              workItemId: testCase.workItemId,
              testResultKey: `TR-${keyNumber}`,
              build: input.build,
              runDate: input.runDate,
              verdict: input.verdict,
              durationMinutes: input.durationMinutes ?? 0,
              testerId: input.testerId,
              notes: input.notes ?? null,
              createdBy: actor.sub,
            },
            tx,
          );
        });
        break;
      } catch (err) {
        lastErr = err;
        if (isDuplicateKeyError(err) && attempt < MAX_KEY_RETRIES - 1) {
          this.logger.warn(
            { testCaseId, attempt: attempt + 1 },
            'Duplicate test result key on create — retrying with next key',
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
