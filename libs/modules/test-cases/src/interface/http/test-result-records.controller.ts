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
import { AuthPolicy, RequirePermission } from '@modules/access';
import { ActivityQueryDto, ActivityResponseDto } from '@modules/activity';
import type { ActivityLog } from '@modules/activity';
import {
  AttachmentResponseDto,
  DownloadUrlResponseDto,
  PresignAttachmentDto,
  PresignAttachmentResponseDto,
} from '@modules/attachments';
import type { EntityAttachment } from '@modules/attachments';
import { TestResultsService } from '../../application/test-results.service';
import { UpdateTestResultDto } from './dto/test-result-request.dto';
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

/** Test Result as a RECORD (SRS §9, E3's detail page). */
@ApiTags('test-cases')
@Controller('test-results')
@AuthPolicy()
export class TestResultRecordsController {
  constructor(private readonly testResultsService: TestResultsService) {}

  @Get(':id')
  @RequirePermission('test_result:view', { resource: 'test_result', from: 'param', field: 'id' })
  @ApiOperation({ summary: 'Get a Test Result by ID' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: TestResultResponseDto })
  @ApiCommonErrors(401, 404)
  async getById(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TestResultResponseDto> {
    const result = await this.testResultsService.getById(user, id);
    return toTestResultDto(result);
  }

  @Patch(':id')
  @RequirePermission('test_result:edit', { resource: 'test_result', from: 'param', field: 'id' })
  @ApiOperation({ summary: 'Edit a Test Result (SRS §9)' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: TestResultResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 412)
  async update(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTestResultDto,
  ): Promise<TestResultResponseDto> {
    const result = await this.testResultsService.update(user, id, dto);
    return toTestResultDto(result);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('test_result:delete', { resource: 'test_result', from: 'param', field: 'id' })
  @ApiOperation({ summary: 'Delete a Test Result (soft delete)' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Test Result deleted' })
  @ApiCommonErrors(401, 403, 404)
  async delete(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.testResultsService.delete(user, id);
  }

  // ── Activity (Revision History) ──────────────────────────────────────────────

  @Get(':id/activity')
  @RequirePermission('test_result:view', { resource: 'test_result', from: 'param', field: 'id' })
  @ApiOperation({ summary: 'List the revision history of a Test Result' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: ActivityResponseDto, isArray: true })
  @ApiCommonErrors(401, 404)
  async getActivity(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ActivityQueryDto,
  ): Promise<{ data: ActivityResponseDto[]; total: number; page: number; pageSize: number }> {
    const { page, pageSize } = query;
    const result = await this.testResultsService.getActivity(user, id, {
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

  // ── Attachments (E2) ──────────────────────────────────────────────────────────

  @Post(':id/attachments/presign')
  @RateLimit('STRICT')
  @ApiOperation({ summary: 'Get presigned S3 PUT URL to upload a Test Result attachment' })
  @RequirePermission('test_result:edit', { resource: 'test_result', from: 'param', field: 'id' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 201, type: PresignAttachmentResponseDto })
  @ApiCommonErrors(400, 401, 404, 422)
  async presignAttachment(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PresignAttachmentDto,
  ): Promise<PresignAttachmentResponseDto> {
    return this.testResultsService.presignAttachment(user, id, {
      filename: dto.filename,
      mimeType: dto.mimeType,
      sizeBytes: dto.sizeBytes,
      checksumSha256: dto.checksumSha256,
    });
  }

  @Post(':id/attachments/:aid/confirm')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirm file upload completed — activates the attachment' })
  @RequirePermission('test_result:edit', { resource: 'test_result', from: 'param', field: 'id' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'aid', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: AttachmentResponseDto })
  @ApiCommonErrors(400, 401, 404, 422)
  async confirmAttachment(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('aid', ParseUUIDPipe) aid: string,
  ): Promise<AttachmentResponseDto> {
    const attachment = await this.testResultsService.confirmAttachment(user, id, aid);
    return toAttachmentDto(attachment);
  }

  @Get(':id/attachments')
  @ApiOperation({ summary: 'List completed attachments for a Test Result' })
  @RequirePermission('test_result:view', { resource: 'test_result', from: 'param', field: 'id' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: AttachmentResponseDto, isArray: true })
  @ApiCommonErrors(401, 404)
  async listAttachments(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AttachmentResponseDto[]> {
    const items = await this.testResultsService.listAttachments(user, id);
    return items.map(toAttachmentDto);
  }

  @Get(':id/attachments/:aid/download')
  @ApiOperation({ summary: 'Get a presigned S3 GET URL for downloading an attachment' })
  @RequirePermission('test_result:view', { resource: 'test_result', from: 'param', field: 'id' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'aid', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: DownloadUrlResponseDto })
  @ApiCommonErrors(401, 404)
  async getAttachmentDownloadUrl(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('aid', ParseUUIDPipe) aid: string,
  ): Promise<DownloadUrlResponseDto> {
    return this.testResultsService.getAttachmentDownloadUrl(user, id, aid);
  }

  /**
   * Stable, authenticated URL for an attachment's bytes — same shape as
   * `test-case-records.controller.ts`'s own `:aid/content` (BR20: the SAME scoped read every
   * attachment route on this controller uses, via `TestResultsService.getById`).
   */
  @Get(':id/attachments/:aid/content')
  @Redirect(undefined, 302)
  @ApiOperation({ summary: 'Redirect to the attachment bytes (stable, authenticated URL)' })
  @RequirePermission('test_result:view', { resource: 'test_result', from: 'param', field: 'id' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'aid', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 302, description: 'Redirect to a short-lived presigned URL' })
  @ApiCommonErrors(401, 404)
  async getAttachmentContent(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('aid', ParseUUIDPipe) aid: string,
  ): Promise<{ url: string; statusCode: number }> {
    const { downloadUrl } = await this.testResultsService.getAttachmentDownloadUrl(user, id, aid);
    return { url: downloadUrl, statusCode: 302 };
  }

  @Delete(':id/attachments/:aid')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete an attachment (uploader or admin only)' })
  @RequirePermission('test_result:edit', { resource: 'test_result', from: 'param', field: 'id' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'aid', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Attachment deleted' })
  @ApiCommonErrors(401, 403, 404)
  async deleteAttachment(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('aid', ParseUUIDPipe) aid: string,
  ): Promise<void> {
    await this.testResultsService.deleteAttachment(user, id, aid);
  }
}
