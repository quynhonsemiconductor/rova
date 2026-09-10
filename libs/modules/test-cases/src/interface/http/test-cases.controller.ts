import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiCommonErrors, ApiPagedResponse, buildPageArgs } from '@platform';
import type { JwtPayload, PagedResult } from '@platform';
import { CurrentUser } from '@modules/identity';
import { AuthPolicy, RequirePermission } from '@modules/access';
import { TestCasesService } from '../../application/test-cases.service';
import { TestCaseListQueryDto } from './dto/test-case-request.dto';
import { TestCaseResponseDto, toTestCaseDto } from './dto/test-case-response.dto';

/** Test Cases NESTED under their parent Work Item (AC2's list, the tab badge's source). */
@ApiTags('test-cases')
@Controller('work-items/:id/test-cases')
@AuthPolicy()
export class WorkItemTestCasesController {
  constructor(private readonly testCasesService: TestCasesService) {}

  @Get()
  @RequirePermission('test_case:view', { resource: 'work_item', from: 'param', field: 'id' })
  @ApiOperation({ summary: "List a Work Item's Test Cases, in rank order" })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiPagedResponse(TestCaseResponseDto)
  @ApiCommonErrors(400, 401, 404)
  async listByWorkItem(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: TestCaseListQueryDto,
  ): Promise<PagedResult<TestCaseResponseDto>> {
    const args = buildPageArgs(query);
    const page = await this.testCasesService.list(user, id, args);
    return { data: page.data.map(toTestCaseDto), pageInfo: page.pageInfo };
  }
}
