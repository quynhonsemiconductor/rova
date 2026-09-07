import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiCommonErrors } from '@platform';
import type { JwtPayload } from '@platform';
import { CurrentUser } from '@modules/identity';
import { AuthPolicy, RequirePermission } from '@modules/access';
import { TestCasesService } from '../../application/test-cases.service';
import { TestCaseTypeOptionDto, toTestCaseTypeOptionDto } from './dto/test-case-response.dto';

/**
 * The per-project Type catalog (SRS §3) — Phase B ships only the READ side, for the Create modal's
 * dropdown (BR2). `POST`/`DELETE` (Type create/archive, `workspace:edit`-gated) are Phase G.
 */
@ApiTags('test-case-types')
@Controller('projects/:id/test-case-types')
@AuthPolicy()
export class TestCaseTypesController {
  constructor(private readonly testCasesService: TestCasesService) {}

  @Get()
  // Same shape as `GET /projects/:id/member-options` — no `resource` key, the param IS the project id.
  @RequirePermission('test_case:view', { from: 'param', field: 'id' })
  @ApiOperation({ summary: "List a project's selectable (non-archived) Test Case Types" })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: TestCaseTypeOptionDto, isArray: true })
  @ApiCommonErrors(401, 403, 404)
  async listSelectableTypes(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TestCaseTypeOptionDto[]> {
    const types = await this.testCasesService.listSelectableTypes(user, id);
    return types.map(toTestCaseTypeOptionDto);
  }
}
