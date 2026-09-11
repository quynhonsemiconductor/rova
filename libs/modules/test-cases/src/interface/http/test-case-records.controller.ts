import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Redirect,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiCommonErrors, RateLimit } from '@platform';
import type { JwtPayload } from '@platform';
import { CurrentUser } from '@modules/identity';
import { AuthPolicy, RequirePermission, AuthorizedInService } from '@modules/access';
import { ActivityQueryDto, ActivityResponseDto } from '@modules/activity';
import type { ActivityLog } from '@modules/activity';
import {
  AttachmentResponseDto,
  DownloadUrlResponseDto,
  PresignAttachmentDto,
  PresignAttachmentResponseDto,
} from '@modules/attachments';
import type { EntityAttachment } from '@modules/attachments';
import { TestCasesService } from '../../application/test-cases.service';
import { TestResultsService } from '../../application/test-results.service';
import { RankTestCaseDto, UpdateTestCaseDto } from './dto/test-case-request.dto';
import { TestCaseResponseDto, toTestCaseDto } from './dto/test-case-response.dto';
import { CreateTestResultDto } from './dto/test-result-request.dto';
import { TestResultResponseDto, toTestResultDto } from './dto/test-result-response.dto';

function toAttachmentDto(a: EntityAttachment): AttachmentResponseDto {
  return {
    id: a.id,
    entityType: a.entityType,
    entityId: a.entityId,
    uploadedBy: a.uploadedBy,
    filename: a.filename,
    mimeType: a.mimeType,
    sizeBytes: Number(a.sizeBytes),
    createdAt: a.createdAt.toISOString(),
  };
}

function toActivityDto(a: ActivityLog): ActivityResponseDto {
  return {
    id: a.id,
    createdAt: a.createdAt,
    actorId: a.actorId,
    actorName: a.actorName,
    action: a.action,
    entityType: a.entityType,
    entityId: a.entityId,
    changes: a.changes,
    metadata: a.metadata ?? {},
  };
}

/** Test Case as a RECORD (AC4's detail page). */
@ApiTags('test-cases')
@Controller('test-cases')
@AuthPolicy()
export class TestCaseRecordsController {
  constructor(
    private readonly testCasesService: TestCasesService,
    private readonly testResultsService: TestResultsService,
  ) {}

  // Declared before `:id` so the static path is not captured as an :id (ParseUUIDPipe-validated,
  // which would 400 on the literal "by-key") — same ordering reason as `work-items.controller.ts`.
  @Get('by-key/:key')
  @AuthorizedInService(
    'test case keys are workspace-unique, so the owning project is unknown until the row loads — resolve-then-check, with getWorkItemForView(work_item:view) on the parent in the service',
    'test-case-routes.e2e.spec.ts',
  )
  @ApiOperation({ summary: 'Get a Test Case by its workspace-unique key' })
  @ApiParam({ name: 'key', type: 'string' })
  @ApiResponse({ status: 200, type: TestCaseResponseDto })
  @ApiCommonErrors(400, 401, 403, 404)
  async getByKey(
    @CurrentUser() user: JwtPayload,
    @Param('key') key: string,
  ): Promise<TestCaseResponseDto> {
    const testCase = await this.testCasesService.getByKey(user, key);
    return toTestCaseDto(testCase);
  }

  @Get(':id')
  @RequirePermission('test_case:view', { resource: 'test_case', from: 'param', field: 'id' })
  @ApiOperation({ summary: 'Get a Test Case by ID' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: TestCaseResponseDto })
  @ApiCommonErrors(401, 404)
  async getById(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TestCaseResponseDto> {
    const testCase = await this.testCasesService.getById(user, id);
    return toTestCaseDto(testCase);
  }

  @Patch(':id')
  @RequirePermission('test_case:edit', { resource: 'test_case', from: 'param', field: 'id' })
  @ApiOperation({ summary: 'Edit a Test Case (SRS §6.3)' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: TestCaseResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 412)
  async update(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTestCaseDto,
  ): Promise<TestCaseResponseDto> {
    const testCase = await this.testCasesService.update(user, id, dto);
    return toTestCaseDto(testCase);
  }

  /**
   * Rank drag-reorder (F3) — a single-item neighbour-based reorder, the exact shape
   * `PATCH /work-items/:id/rank` uses. `beforeId`/`afterId` name the rows immediately
   * above/below the target's NEW position; the service computes a LexoRank between their
   * stored ranks.
   */
  @Patch(':id/rank')
  @RequirePermission('test_case:edit', { resource: 'test_case', from: 'param', field: 'id' })
  @ApiOperation({ summary: 'Reorder a Test Case between two neighbours (drag-to-reorder)' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: TestCaseResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 412)
  async rank(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RankTestCaseDto,
  ): Promise<TestCaseResponseDto> {
    const testCase = await this.testCasesService.reorder(user, id, dto);
    return toTestCaseDto(testCase);
  }

  /**
   * Delete a Test Case (F1/F2). SOFT — `deleted_at` — and cascades to its Results in the SAME
   * transaction (`TestCasesService.delete`); the FE confirmation is NAMED, not typed, because the
   * delete is recoverable in the database (CLAUDE.md: a typed gate is reserved for the
   * irreversible).
   */
  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('test_case:delete', { resource: 'test_case', from: 'param', field: 'id' })
  @ApiOperation({ summary: 'Delete a Test Case (soft; cascades to its Results)' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Test case deleted' })
  @ApiCommonErrors(401, 403, 404)
  async delete(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.testCasesService.delete(user, id);
  }

  // ── Activity (Revision History, C6) ──────────────────────────────────────────

  @Get(':id/activity')
  @RequirePermission('test_case:view', { resource: 'test_case', from: 'param', field: 'id' })
  @ApiOperation({ summary: 'List the revision history of a Test Case' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: ActivityResponseDto, isArray: true })
  @ApiCommonErrors(401, 404)
  async getActivity(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ActivityQueryDto,
  ): Promise<{ data: ActivityResponseDto[]; total: number; page: number; pageSize: number }> {
    const { page, pageSize } = query;
    const result = await this.testCasesService.getActivity(user, id, {
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    return {
      data: result.items.map(toActivityDto),
      total: result.total,
      page,
      pageSize,
    };
  }

  // ── Test Results (Phase D) ────────────────────────────────────────────────────

  @Get(':id/test-results')
  @RequirePermission('test_result:view', { resource: 'test_case', from: 'param', field: 'id' })
  @ApiOperation({ summary: "List a Test Case's Results, latest first (BR14)" })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: TestResultResponseDto, isArray: true })
  @ApiCommonErrors(401, 404)
  async listResults(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TestResultResponseDto[]> {
    const results = await this.testResultsService.list(user, id);
    return results.map(toTestResultDto);
  }

  @Post(':id/test-results')
  @RequirePermission('test_result:create', { resource: 'test_case', from: 'param', field: 'id' })
  @ApiOperation({ summary: 'Add a Test Result to a Test Case (SRS §8)' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 201, type: TestResultResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 412)
  async createResult(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateTestResultDto,
  ): Promise<TestResultResponseDto> {
    const result = await this.testResultsService.create(user, id, dto);
    return toTestResultDto(result);
  }

  // ── Attachments (C4) ──────────────────────────────────────────────────────────

  @Post(':id/attachments/presign')
  @RateLimit('STRICT')
  @ApiOperation({ summary: 'Get presigned S3 PUT URL to upload a Test Case attachment' })
  @RequirePermission('test_case:edit', { resource: 'test_case', from: 'param', field: 'id' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 201, type: PresignAttachmentResponseDto })
  @ApiCommonErrors(400, 401, 404, 422)
  async presignAttachment(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PresignAttachmentDto,
  ): Promise<PresignAttachmentResponseDto> {
    return this.testCasesService.presignAttachment(user, id, {
      filename: dto.filename,
      mimeType: dto.mimeType,
      sizeBytes: dto.sizeBytes,
      checksumSha256: dto.checksumSha256,
    });
  }

  @Post(':id/attachments/:aid/confirm')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirm file upload completed — activates the attachment' })
  @RequirePermission('test_case:edit', { resource: 'test_case', from: 'param', field: 'id' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'aid', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: AttachmentResponseDto })
  @ApiCommonErrors(400, 401, 404, 422)
  async confirmAttachment(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('aid', ParseUUIDPipe) aid: string,
  ): Promise<AttachmentResponseDto> {
    const attachment = await this.testCasesService.confirmAttachment(user, id, aid);
    return toAttachmentDto(attachment);
  }

  @Get(':id/attachments')
  @ApiOperation({ summary: 'List completed attachments for a Test Case' })
  @RequirePermission('test_case:view', { resource: 'test_case', from: 'param', field: 'id' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: AttachmentResponseDto, isArray: true })
  @ApiCommonErrors(401, 404)
  async listAttachments(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AttachmentResponseDto[]> {
    const items = await this.testCasesService.listAttachments(user, id);
    return items.map(toAttachmentDto);
  }

  @Get(':id/attachments/:aid/download')
  @ApiOperation({ summary: 'Get a presigned S3 GET URL for downloading an attachment' })
  @RequirePermission('test_case:view', { resource: 'test_case', from: 'param', field: 'id' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'aid', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: DownloadUrlResponseDto })
  @ApiCommonErrors(401, 404)
  async getAttachmentDownloadUrl(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('aid', ParseUUIDPipe) aid: string,
  ): Promise<DownloadUrlResponseDto> {
    return this.testCasesService.getAttachmentDownloadUrl(user, id, aid);
  }

  /**
   * Stable, authenticated URL for an attachment's bytes — same shape as
   * `work-items.controller.ts`'s own `:aid/content` (BR20: the SAME scoped read every attachment
   * route on this controller uses, via `TestCasesService.getById`).
   *
   * Semgrep's `nestjs-open-redirect` flags the `{ url }` shape generically — it cannot trace that
   * `downloadUrl` is a server-generated S3 presigned URL (bucket/key/expiry/signature, all
   * server-side), never built from request input. The only caller-supplied value, `aid`, is a
   * `ParseUUIDPipe`-validated id used purely as a lookup key into a permission-scoped attachment
   * record; it can only select which pre-existing, already-authorized URL comes back, never choose
   * an arbitrary redirect target. False positive, same as the identical pre-existing route on
   * `work-items.controller.ts`.
   */
  // nosemgrep: typescript.nestjs.security.audit.nestjs-open-redirect.nestjs-open-redirect
  @Get(':id/attachments/:aid/content')
  @Redirect(undefined, 302)
  @ApiOperation({ summary: 'Redirect to the attachment bytes (stable, authenticated URL)' })
  @RequirePermission('test_case:view', { resource: 'test_case', from: 'param', field: 'id' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'aid', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 302, description: 'Redirect to a short-lived presigned URL' })
  @ApiCommonErrors(401, 404)
  async getAttachmentContent(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('aid', ParseUUIDPipe) aid: string,
  ): Promise<{ url: string; statusCode: number }> {
    const { downloadUrl } = await this.testCasesService.getAttachmentDownloadUrl(user, id, aid);
    return { url: downloadUrl, statusCode: 302 };
  }

  @Delete(':id/attachments/:aid')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete an attachment (uploader or admin only)' })
  @RequirePermission('test_case:edit', { resource: 'test_case', from: 'param', field: 'id' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'aid', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Attachment deleted' })
  @ApiCommonErrors(401, 403, 404)
  async deleteAttachment(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('aid', ParseUUIDPipe) aid: string,
  ): Promise<void> {
    await this.testCasesService.deleteAttachment(user, id, aid);
  }
}
