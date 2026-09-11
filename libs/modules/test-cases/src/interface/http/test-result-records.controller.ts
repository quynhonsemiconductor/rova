import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiCommonErrors } from '@platform';
import type { JwtPayload } from '@platform';
import { CurrentUser } from '@modules/identity';
import { AuthPolicy, RequirePermission } from '@modules/access';
import { TestResultsService } from '../../application/test-results.service';
import { TestResultResponseDto, toTestResultDto } from './dto/test-result-response.dto';

/** Test Result as a RECORD. `PATCH`/`DELETE` are Phase E/F. */
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
}
