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
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiCommonErrors } from '@platform';
import type { JwtPayload } from '@platform';
import { CurrentUser } from '@modules/identity';
import { AuthPolicy, RequirePermission } from '@modules/access';
import { CollaborationService } from '../../application/collaboration.service';
import { CreateCommentDto, UpdateCommentDto } from './dto/collaboration-request.dto';
import { CommentResponseDto, toCommentDto } from './dto/collaboration-response.dto';

/**
 * Comments on a PORTFOLIO ITEM (Epic or Feature).
 *
 * A separate controller rather than extra routes on `PortfolioItemsController`, for two
 * reasons that both point the same way:
 *
 * 1. **No module cycle.** `CollaborationModule` already imports `PortfolioModule` to
 *    resolve a Feature's project for the permission check. Putting these routes on the
 *    portfolio controller would need `PortfolioModule` to import Collaboration back, and
 *    the pair would only load behind `forwardRef`. Comments belong to the collaboration
 *    module; the entity it hangs off does not change that.
 *
 * 2. **The guard is resource-typed.** `@RequirePermission` resolves a concrete resource to
 *    find the owning project, so one generic `/comments?entityType=…` route could not gate
 *    a work-item comment on `work_item:edit` and a portfolio one on `portfolio:edit`. Two
 *    doors, one entity-generic service behind them.
 *
 * Update and delete ARE mirrored here even though the work-item versions already resolve
 * their subject from the loaded comment and would function for either entity type. The
 * alternative was for the client to edit a portfolio comment through
 * `/v1/work-items/<portfolio-item-id>/comments/:commentId` — a path segment that names one
 * table and carries an id from another.
 *
 * Unlike the work-item twins, these two DO carry `@RequirePermission` on the path item. Two
 * checks then run — the guard on `:id`, and `assertCanCollaborate` on the loaded comment's own
 * subject — which is strictly stronger than either alone and keeps the unpoliced-route ratchet
 * from rising for routes that were never meant to be open.
 */
@ApiTags('collaboration')
@Controller('portfolio-items/:id')
@AuthPolicy()
export class PortfolioCollaborationController {
  constructor(private readonly collaboration: CollaborationService) {}

  @Get('comments')
  @RequirePermission('portfolio:view', { resource: 'portfolio_item', from: 'param', field: 'id' })
  @ApiOperation({ summary: 'List comments on an Epic or Feature' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: [CommentResponseDto] })
  @ApiCommonErrors(401, 404)
  async listComments(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CommentResponseDto[]> {
    const rows = await this.collaboration.listComments(user, {
      entityType: 'portfolio_item',
      entityId: id,
    });
    // `Comment.entityType` widened to admit `test_case` / `test_result` when migration 0129
    // widened `entity_ref_type` (Phase 7). This route only ever queries `entityType:
    // 'portfolio_item'` above, so every row is provably one of `toCommentDto`'s two members; the
    // refusal that keeps a test_case/test_result row from reaching this cast is Phase C's C7 task.
    return rows.map((c) => toCommentDto(c as Parameters<typeof toCommentDto>[0]));
  }

  @Post('comments')
  @RequirePermission('portfolio:edit', { resource: 'portfolio_item', from: 'param', field: 'id' })
  @ApiOperation({ summary: 'Add a comment to an Epic or Feature' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 201, type: CommentResponseDto })
  @ApiCommonErrors(400, 401, 422)
  async createComment(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCommentDto,
  ): Promise<CommentResponseDto> {
    const comment = await this.collaboration.createComment(
      user,
      { entityType: 'portfolio_item', entityId: id },
      dto.body,
      dto.parentId,
      dto.mentionedUserIds,
    );
    // See the comment in `listComments` — this route only ever creates `entityType: 'portfolio_item'`.
    return toCommentDto(comment as Parameters<typeof toCommentDto>[0]);
  }

  @Patch('comments/:commentId')
  // Gated on the PATH item even though the service re-resolves the subject from the loaded
  // comment. Both checks run, so this is strictly stronger than the work-item twins (which
  // carry no decorator): the caller must be able to edit the item in the URL, AND the
  // comment must actually hang off something they may edit.
  @RequirePermission('portfolio:edit', { resource: 'portfolio_item', from: 'param', field: 'id' })
  @ApiOperation({ summary: 'Update a comment on an Epic or Feature' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'commentId', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: CommentResponseDto })
  @ApiCommonErrors(400, 401, 404, 422)
  async updateComment(
    @CurrentUser() user: JwtPayload,
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @Body() dto: UpdateCommentDto,
  ): Promise<CommentResponseDto> {
    const comment = await this.collaboration.updateComment(user, commentId, dto.body);
    // This controller is mounted under `portfolio-items/:id` — every comment reached through it
    // is a portfolio-item comment. See `listComments`'s comment for why this cast is narrowing.
    return toCommentDto(comment as Parameters<typeof toCommentDto>[0]);
  }

  @Delete('comments/:commentId')
  @HttpCode(204)
  @RequirePermission('portfolio:edit', { resource: 'portfolio_item', from: 'param', field: 'id' })
  @ApiOperation({ summary: 'Delete a comment on an Epic or Feature (soft delete)' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'commentId', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Comment deleted' })
  @ApiCommonErrors(401, 404)
  async deleteComment(
    @CurrentUser() user: JwtPayload,
    @Param('commentId', ParseUUIDPipe) commentId: string,
  ): Promise<void> {
    await this.collaboration.deleteComment(user, commentId);
  }
}
