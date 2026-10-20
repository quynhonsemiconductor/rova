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
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ApiCommonErrors } from '@platform';
import type { JwtPayload } from '@platform';
import { SelfScoped } from '@modules/access';
import { CurrentUser } from '@modules/identity';

import { ApiTokensService } from '../../application/api-tokens.service';
import {
  ApiTokenResponseDto,
  CreateApiTokenDto,
  CreatedApiTokenResponseDto,
  toApiTokenResponse,
} from './dto/api-token.dto';
import { SessionAuthOnly } from './session-auth-only.decorator';

/**
 * A user's own API tokens.
 *
 * `me/*` surface, so every route is self-scoped: the principal IS the scope, and there is no permission
 * code to check — the same shape as `me/avatar`. Real Rally works this way too: any user may mint their
 * own API Key, and only an administrator sees everyone's.
 *
 * Every route uses {@link SessionAuthOnly} rather than `@Auth()`, so a caller authenticated BY a token
 * is refused: a token can neither mint another nor revoke the one that would stop it.
 */
@ApiTags('api-tokens')
@Controller('me/api-tokens')
export class ApiTokensController {
  constructor(private readonly tokens: ApiTokensService) {}

  @Post()
  @SelfScoped("mints a token for the caller's own principal")
  @SessionAuthOnly()
  @ApiOperation({
    summary: 'Mint an API token',
    description:
      'Returns the credential ONCE. It is stored only as a hash, so it cannot be shown again — a ' +
      'lost token is revoked and replaced. Scopes narrow the token; they can never widen it.',
  })
  @ApiResponse({ status: 201, type: CreatedApiTokenResponseDto })
  @ApiCommonErrors(400, 401, 403, 422)
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateApiTokenDto,
  ): Promise<CreatedApiTokenResponseDto> {
    const { token, plaintext } = await this.tokens.mint({
      workspaceId: user.workspaceId,
      userId: user.sub,
      name: dto.name,
      expiresInDays: dto.expiresInDays,
      scopes: dto.scopes,
    });
    return { ...toApiTokenResponse(token), token: plaintext };
  }

  @Get()
  @SelfScoped("lists the caller's own tokens")
  @SessionAuthOnly()
  @ApiOperation({
    summary: 'List my API tokens',
    description:
      'Includes revoked tokens: the list is also the audit surface, and a token that vanished on ' +
      'revocation would leave no record that it ever existed.',
  })
  @ApiResponse({ status: 200, type: ApiTokenResponseDto, isArray: true })
  @ApiCommonErrors(401, 403)
  async list(@CurrentUser() user: JwtPayload): Promise<ApiTokenResponseDto[]> {
    return (await this.tokens.listOwn(user.workspaceId, user.sub)).map(toApiTokenResponse);
  }

  @Delete(':id')
  @HttpCode(204)
  @SelfScoped("revokes one of the caller's own tokens")
  @SessionAuthOnly()
  @ApiOperation({ summary: 'Revoke one of my API tokens' })
  @ApiResponse({
    status: 204,
    description: 'Revoked, or already revoked — the call is idempotent.',
  })
  @ApiCommonErrors(401, 403, 404)
  async revoke(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.tokens.revokeOwn(user.workspaceId, user.sub, id);
  }
}
