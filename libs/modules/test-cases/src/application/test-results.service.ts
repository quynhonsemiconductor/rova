import { Inject, Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { NotFoundException, UnitOfWork, isDuplicateKeyError } from '@platform';
import type { JwtPayload } from '@platform';
import { ProjectsService } from '@modules/projects';
import { ActivityLogger } from '@modules/activity';
import type { ActivityLog } from '@modules/activity';
import { EntityAttachmentsService, TEST_RESULT_ATTACHMENT_POLICY } from '@modules/attachments';
import type { AttachmentRef, EntityAttachment } from '@modules/attachments';
import { TestCasesService } from './test-cases.service';
import {
  ITestResultRepository,
  TEST_RESULT_REPOSITORY,
  UpdateTestResultInput,
} from '../domain/ports/test-result.repository';
import type { TestResult, TestResultVerdict } from '../domain/test-result.types';
import { TEST_RESULT_ACTIVITY_CONFIG } from './test-result-activity-diff';

export interface CreateTestResultCommand {
  build: string;
  runDate: string;
  verdict: TestResultVerdict;
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
    private readonly activityLogger: ActivityLogger,
    private readonly entityAttachments: EntityAttachmentsService,
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

  /**
   * Edit a Test Result (SRS §9, Phase E's E2). `test_result:edit` is checked by the route's own
   * `@RequirePermission`; this method still authorises the Result's own Test Case first (BR19/BR20,
   * same shape every method on this service already uses) — BR11's `duration_minutes >= 0` is
   * enforced by the zod schema at the controller boundary (same as create) and by the DB's own
   * CHECK constraint, not re-asserted here.
   *
   * BR9/E5: changing `runDate` or `verdict` moves the parent Test Case's `last_verdict`/`last_run`
   * via `trg_test_case_last_result`'s UPDATE branch (D6) — this method never touches those columns
   * itself, exactly like `create` never does.
   */
  async update(actor: JwtPayload, id: string, input: UpdateTestResultInput): Promise<TestResult> {
    const existing = await this.testResultRepo.findById(id, actor.workspaceId);
    if (!existing) {
      throw new NotFoundException('TEST_RESULT_NOT_FOUND', 'Test result not found');
    }
    // BR20: the SAME scoped read as the record itself.
    const testCase = await this.testCasesService.getById(actor, existing.testCaseId);

    // BR8: Tester re-gated by the SAME assignment-eligibility rule as create — only when it is
    // ACTUALLY CHANGING, matching `TestCasesService.update`'s `assignableFields` loop (re-saving
    // an existing, possibly since-ineligible value must not be refused).
    if (input.testerId && input.testerId !== existing.testerId) {
      await this.projectsService.assertAssignable(
        actor.workspaceId,
        testCase.projectId,
        testCase.teamId,
        input.testerId,
      );
    }

    const updated = await this.uow.run((tx) =>
      this.testResultRepo.update(id, input, actor.workspaceId, tx),
    );

    // TX1: outside the transaction, `logSafe` — matching releases/projects (`TestCasesService`'s
    // identical reasoning): a revision-log failure must never fail the mutation. Scalar-only diff
    // rows, never a rich-text body (TEST_RESULT_ACTIVITY_CONFIG.richText). `contextId` = the Test
    // Case's own id, matching Test Case activity's own `contextId` (the parent Work Item) one
    // level up — a Result's Revision History belongs to its Result, and its Test Case's history is
    // a SEPARATE feed (C6), not this one.
    await this.activityLogger.logSafe(
      this.activityLogger.buildDiff(
        {
          workspaceId: actor.workspaceId,
          projectId: existing.projectId,
          entityType: 'test_result',
          entityId: id,
          contextId: existing.testCaseId,
        },
        actor.sub,
        existing as unknown as Record<string, unknown>,
        input as Partial<Record<string, unknown>>,
        TEST_RESULT_ACTIVITY_CONFIG,
        'test_result.updated',
      ),
    );

    return updated;
  }

  /** Soft delete (Phase E's E2). Fires the trigger's UPDATE branch (D6) exactly like a raw `deleted_at` write. */
  async delete(actor: JwtPayload, id: string): Promise<void> {
    const existing = await this.testResultRepo.findById(id, actor.workspaceId);
    if (!existing) {
      throw new NotFoundException('TEST_RESULT_NOT_FOUND', 'Test result not found');
    }
    await this.testCasesService.getById(actor, existing.testCaseId);

    await this.uow.run((tx) => this.testResultRepo.softDelete(id, actor.workspaceId, tx));

    // TX1: outside the transaction, `logSafe` — see `update`'s identical reasoning.
    await this.activityLogger.logSafe([
      this.activityLogger.build(
        {
          workspaceId: actor.workspaceId,
          projectId: existing.projectId,
          entityType: 'test_result',
          entityId: id,
          contextId: existing.testCaseId,
        },
        actor.sub,
        'test_result.deleted',
        null,
        { testResultKey: existing.testResultKey },
      ),
    ]);
  }

  /**
   * Revision History for a Test Result (E3's second tab). BR20: the SAME scoped read as the
   * record itself — mirrors `TestCasesService.getActivity` exactly.
   */
  async getActivity(
    actor: JwtPayload,
    id: string,
    args: { limit: number; offset: number },
  ): Promise<{ items: ActivityLog[]; total: number }> {
    await this.getById(actor, id);
    const page = Math.floor(args.offset / args.limit) + 1;
    const res = await this.activityLogger.listFor(id, actor.workspaceId, page, args.limit);
    return { items: res.data, total: res.total };
  }

  // ── Attachments (E2) ─────────────────────────────────────────────────────────
  //
  // Thin delegations to `EntityAttachmentsService` — same shape as `TestCasesService`'s own
  // attachment methods (C4). BR20: every one of these calls the scoped read FIRST, including the
  // download route, where a signed URL outliving the request makes a missing scope check the
  // worst of the group.

  private static attachmentRef(testResultId: string): AttachmentRef {
    return { entityType: 'test_result', entityId: testResultId };
  }

  async presignAttachment(
    actor: JwtPayload,
    testResultId: string,
    input: { filename: string; mimeType: string; sizeBytes: number; checksumSha256: string },
  ): Promise<{ attachmentId: string; uploadUrl: string; requiredHeaders: Record<string, string> }> {
    await this.getById(actor, testResultId);
    return this.entityAttachments.presign(
      actor,
      TestResultsService.attachmentRef(testResultId),
      input,
      TEST_RESULT_ATTACHMENT_POLICY,
    );
  }

  async confirmAttachment(
    actor: JwtPayload,
    testResultId: string,
    attachmentId: string,
  ): Promise<EntityAttachment> {
    const result = await this.getById(actor, testResultId);
    return this.entityAttachments.confirm(
      actor,
      TestResultsService.attachmentRef(testResultId),
      attachmentId,
      result.projectId,
      TEST_RESULT_ATTACHMENT_POLICY,
    );
  }

  async listAttachments(actor: JwtPayload, testResultId: string): Promise<EntityAttachment[]> {
    await this.getById(actor, testResultId);
    return this.entityAttachments.list(actor, TestResultsService.attachmentRef(testResultId));
  }

  async getAttachmentDownloadUrl(
    actor: JwtPayload,
    testResultId: string,
    attachmentId: string,
  ): Promise<{ downloadUrl: string }> {
    // Both `:aid/download` and `:aid/content` land here — see the class-level BR20 note.
    await this.getById(actor, testResultId);
    return this.entityAttachments.downloadUrl(
      actor,
      TestResultsService.attachmentRef(testResultId),
      attachmentId,
      TEST_RESULT_ATTACHMENT_POLICY,
    );
  }

  async deleteAttachment(
    actor: JwtPayload,
    testResultId: string,
    attachmentId: string,
  ): Promise<void> {
    const result = await this.getById(actor, testResultId);
    await this.entityAttachments.delete(
      actor,
      TestResultsService.attachmentRef(testResultId),
      attachmentId,
      result.projectId,
    );
  }
}
