import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiCommonErrors } from '@platform';
import type { JwtPayload } from '@platform';
import { CurrentUser } from '@modules/identity';
import { AuthPolicy, RequirePermission } from '@modules/access';
import { TestCaseTypesService } from '../../application/test-case-types.service';
import { CreateTestCaseTypeDto } from './dto/test-case-request.dto';
import { TestCaseTypeOptionDto, toTestCaseTypeOptionDto } from './dto/test-case-response.dto';

/**
 * The per-project Type catalog (SRS §3), modelled on `work.labels`. `GET` is
 * `test_case:view`-gated (same shape as `GET /projects/:id/member-options` — no `resource` key,
 * the param IS the project id); `POST`/`DELETE` are `workspace:edit` — Workspace-Admin-only,
 * matching the structural project routes (`PATCH /projects/:id`), deliberately NOT `project:edit`
 * which a Project Admin also holds (CLAUDE.md: "A per-Project Admin has NO structural authority").
 * `workspace:edit` is workspace-tier, so it takes NO scope argument — the service re-scopes the
 * project id to the caller's own workspace, exactly like `updateEstimationSettings`.
 */
@ApiTags('test-case-types')
@Controller('projects/:id/test-case-types')
@AuthPolicy()
export class TestCaseTypesController {
  constructor(private readonly testCaseTypesService: TestCaseTypesService) {}

  @Get()
  @RequirePermission('test_case:view', { from: 'param', field: 'id' })
  @ApiOperation({ summary: "List a project's selectable (non-archived) Test Case Types" })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: TestCaseTypeOptionDto, isArray: true })
  @ApiCommonErrors(401, 403, 404)
  async listSelectableTypes(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TestCaseTypeOptionDto[]> {
    const types = await this.testCaseTypesService.listSelectable(user.workspaceId, id);
    return types.map(toTestCaseTypeOptionDto);
  }

  @Post()
  @RequirePermission('workspace:edit')
  @ApiOperation({ summary: 'Create a Test Case Type for a project (Workspace Admin only)' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 201, type: TestCaseTypeOptionDto })
  @ApiCommonErrors(400, 401, 403, 404, 409)
  async createType(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateTestCaseTypeDto,
  ): Promise<TestCaseTypeOptionDto> {
    const type = await this.testCaseTypesService.create(user.workspaceId, id, dto.name);
    return toTestCaseTypeOptionDto(type);
  }

  @Delete(':typeId')
  @HttpCode(204)
  @RequirePermission('workspace:edit')
  @ApiOperation({
    summary:
      'Archive (soft-hide) a Test Case Type (Workspace Admin only). Existing Test Cases keep ' +
      'their historical Type value (BR17).',
  })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'typeId', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Test Case Type archived' })
  @ApiCommonErrors(401, 403, 404)
  async archiveType(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('typeId', ParseUUIDPipe) typeId: string,
  ): Promise<void> {
    await this.testCaseTypesService.archive(user.workspaceId, id, typeId);
  }
}
