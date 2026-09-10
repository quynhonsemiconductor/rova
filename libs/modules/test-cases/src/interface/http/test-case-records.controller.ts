import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiCommonErrors } from '@platform';
import type { JwtPayload } from '@platform';
import { CurrentUser } from '@modules/identity';
import { AuthPolicy, RequirePermission, AuthorizedInService } from '@modules/access';
import { TestCasesService } from '../../application/test-cases.service';
import { TestCaseResponseDto, toTestCaseDto } from './dto/test-case-response.dto';

/** Test Case as a RECORD (AC4's detail page). */
@ApiTags('test-cases')
@Controller('test-cases')
@AuthPolicy()
export class TestCaseRecordsController {
  constructor(private readonly testCasesService: TestCasesService) {}

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
}
