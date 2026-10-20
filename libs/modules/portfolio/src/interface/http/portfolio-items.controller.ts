import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiCommonErrors, ApiPagedResponse, buildPageArgs } from '@platform';
import type { JwtPayload, PagedResult } from '@platform';
import { CurrentUser } from '@modules/identity';
import { AuthPolicy, RequirePermission, AuthorizedInService } from '@modules/access';
import {
  PortfolioItemsService,
  type PortfolioItemDetail,
  type PortfolioItemWithProgress,
} from '../../application/portfolio-items.service';
import type { PortfolioChildItem } from '../../domain/ports/portfolio-item.repository';
import {
  ActivityQueryDto,
  ActivityResponseDto,
  ActivityPageDto,
  type ActivityLog,
} from '@modules/activity';

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
import {
  CreatePortfolioItemDto,
  PortfolioChildrenQueryDto,
  PortfolioFeatureOptionsQueryDto,
  PortfolioListQueryDto,
  RankPortfolioItemDto,
  UpdatePortfolioItemDto,
} from './dto/portfolio-item-request.dto';
import {
  PortfolioChildResponseDto,
  PortfolioFeatureOptionResponseDto,
  PortfolioItemDetailResponseDto,
  PortfolioItemResponseDto,
} from './dto/portfolio-item-response.dto';

function toDto(i: PortfolioItemWithProgress): PortfolioItemResponseDto {
  return {
    id: i.id,
    workspaceId: i.workspaceId,
    projectId: i.projectId,
    projectName: i.projectName,
    itemKey: i.itemKey,
    type: i.type,
    name: i.name,
    description: i.description,
    notes: i.notes,
    releaseNotes: i.releaseNotes,
    whatSuccessLooksLike: i.whatSuccessLooksLike,
    state: i.state,
    preliminaryEstimate: i.preliminaryEstimate,
    // numeric arrives as a string from Drizzle (precision preservation); the API
    // contract is a number, so the conversion belongs here at the boundary.
    refinedEstimate: Number(i.refinedEstimate),
    refinedItemCountEstimate: i.refinedItemCountEstimate,
    parentId: i.parentId,
    parentKey: i.parentKey,
    teamId: i.teamId,
    teamName: i.teamName,
    releaseId: i.releaseId,
    releaseName: i.releaseName,
    ownerId: i.ownerId,
    ownerName: i.ownerName,
    plannedStartDate: i.plannedStartDate,
    plannedEndDate: i.plannedEndDate,
    marketReleaseDate: i.marketReleaseDate,
    rank: i.rank,
    archivedAt: i.archivedAt === null ? null : i.archivedAt.toISOString(),
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
    childFeatureCount: i.childFeatureCount,
    rollup: i.rollup,
    progress: i.progress,
    health: i.health,
    estimate: i.estimate,
  };
}

/** The detail response — `toDto` plus the accepted-children breakdown. */
function toDetailDto(i: PortfolioItemDetail): PortfolioItemDetailResponseDto {
  return { ...toDto(i), acceptedChildren: i.acceptedChildren, milestones: i.milestones };
}

/**
 * The inbound mirror of `toDto`'s numeric handling.
 *
 * `refined_estimate` is a Postgres `numeric`, which Drizzle reads and writes as a STRING
 * to preserve precision, while the API contract is a number. `toDto` converts one way, so
 * this converts the other — both at the boundary, so no other layer sees the mismatch.
 *
 * Only `undefined` is special now: it stays "not supplied". There is no null to carry,
 * because 0 is the "not forecast" value (migration 0081) and the column is NOT NULL.
 */
function toWriteInput<T extends { refinedEstimate?: number }>(
  body: T,
): Omit<T, 'refinedEstimate'> & { refinedEstimate?: string } {
  const { refinedEstimate, ...rest } = body;
  return {
    ...rest,
    ...(refinedEstimate === undefined ? {} : { refinedEstimate: String(refinedEstimate) }),
  };
}

function toChildDto(c: PortfolioChildItem): PortfolioChildResponseDto {
  return {
    id: c.id,
    itemKey: c.itemKey,
    type: c.type,
    title: c.title,
    scheduleState: c.scheduleState,
    storyPoints: c.storyPoints === null ? null : Number(c.storyPoints),
    priority: c.priority,
    iterationId: c.iterationId,
    iterationName: c.iterationName,
    // The repository already ordered by and returned this; only the DTO mapping dropped it, so
    // the Children tab received a rank-ordered list it had no way to reorder.
    rank: c.rank,
    projectId: c.projectId,
    releaseId: c.releaseId,
    teamId: c.teamId,
    assigneeId: c.assigneeId,
    releaseName: c.releaseName,
    projectName: c.projectName,
    teamName: c.teamName,
    ownerName: c.ownerName,
  };
}

@ApiTags('Portfolio')
@Controller('portfolio-items')
@AuthPolicy()
export class PortfolioItemsController {
  constructor(private readonly service: PortfolioItemsService) {}

  @Get()
  @AuthorizedInService(
    'cross-project list scoped by listReadableProjectIds',
    'project-authz.e2e.spec.ts',
  )
  // DELIBERATELY UNDECORATED — authorization is resolve-then-check, in the service.
  //
  // `portfolio:view` is PROJECT-tier, and this route's `projectId` is optional because
  // a Workspace Admin lists across projects (BA spec §3.2) and the grid has a Project
  // column. So the guard cannot resolve one project to check against, and the tier-safe
  // decorator correctly refuses to pretend otherwise.
  //
  // The real check is `AccessService.listReadableProjectIds`, which the service applies
  // as a project filter, distinguishing `null` (unrestricted) from `[]` (nothing) so it
  // cannot fail open. That mirrors Rally, where access to an artifact follows from
  // permission on its PROJECT rather than any per-artifact grant. Pinned by
  // `test/e2e/portfolio-isolation.e2e.spec.ts`.
  //
  // This route USED to carry `@RequirePermission('workspace:view')`. That is the
  // "gate chosen for where the id lives rather than for what the action is" bug this
  // repo has now hit three times (`work-items/by-key`, `report:view`, here):
  // `workspace:*` is admin-reserved, so a correctly project-scoped Project ADMIN 403'd at
  // the guard and the narrowing below never ran. `by-key` set the precedent for dropping
  // the decorator rather than swapping the code.
  //
  // A Project MEMBER is a different matter, and this comment used to get it wrong: it
  // cited P5-PI-FR-017 as granting one read access. That rule says the opposite on BA
  // `origin/main` — "WA all Projects; Admin manage assigned Project; Editor/No Access
  // hidden. (Viewer level removed.)" (`Phase 5/01_Portfolio_Items/SRS.md:224`) — and the
  // catalogue agrees, withholding `portfolio:view` from the `editor` level. An Editor
  // reaching this route now gets an EMPTY page, not a 403: the scope is
  // `listReadableProjectIds`, which returns `[]` for them, and `[]` is a legitimate answer
  // here rather than a refusal. Until 2026-08-14 they got every Epic and Feature in their
  // projects, because that method unioned in a roster query it never filtered by the
  // permission it was asked about.
  // See 09_Gap_Audit/PHASE_5_6_DECISION_MATRIX.md#P5-PI-16
  @ApiOperation({ summary: 'List Epics or Features' })
  @ApiPagedResponse(PortfolioItemResponseDto)
  @ApiCommonErrors(400, 401)
  async listItems(
    @CurrentUser() user: JwtPayload,
    @Query() query: PortfolioListQueryDto,
  ): Promise<PagedResult<PortfolioItemResponseDto>> {
    const args = buildPageArgs(query);
    const page = await this.service.listItems(
      user,
      {
        type: query.type,
        projectId: query.projectId,
        teamId: query.teamId,
        search: query.search,
        includeArchived: query.includeArchived,
      },
      args,
    );
    return { data: page.data.map(toDto), pageInfo: page.pageInfo };
  }

  /**
   * The FEATURE REFERENCE feed — the picker behind the `Feature` field on a Story/Defect.
   *
   * DECLARED ABOVE `:id` deliberately: Nest matches in declaration order, so below it every
   * request for `/options` would be a `getItem` call with `id = 'options'` and die in
   * `ParseUUIDPipe` as a 400.
   *
   * WHY IT IS `work_item:view` AND NOT `portfolio:view`. §5.3:130-135 puts a `Feature` field
   * in the Work Item detail rail, and §5.2:124 makes that field the ONLY way a Story's Feature
   * membership is ever set ("no 'link existing Story/Defect' … set only at creation or by
   * editing that Story/Defect's own record elsewhere"). §3.2:79 gives an Editor
   * Create/View/Edit/Delete over Story/Defect, so gating the field's feed on `portfolio:view`
   * — which the `editor` level withholds — would remove a capability from the one role that
   * owns those records, with no alternative path. The Portfolio SURFACE stays hidden from an
   * Editor (§3.2:85, P5-PI-FR-017); a Feature's key and name on a picker are not that surface.
   *
   * The precedent is the BA's own, one field over: `Phase 2/02_Iterations/SRS.md:393` reads
   * "Editor | Timeboxes hidden; may update Work Item Iteration through approved
   * Backlog/Iteration Status flows only" — hidden surface, permitted field, therefore a feed.
   * Release is decided the OTHER way and says so in words ("cannot assign Release", BL §8:294),
   * which is why that one is refused in `WorkItemsService` instead. The BA is SILENT on
   * Feature, so this is a declared reading, not a derived rule — recorded in `CLAUDE.md` and
   * put to the BA. If they rule it like Release, this route and one SPA field are the whole
   * reversal.
   *
   * Project-scoped, so the GUARD checks it: §5.3:133 says "the selectable Feature list is
   * scoped to the Work Item's Project", which makes `projectId` required, which in turn means
   * this needs no service-side `listReadableProjectIds` narrowing at all.
   */
  @Get('options')
  @RequirePermission('work_item:view', { from: 'query', field: 'projectId' })
  @ApiOperation({ summary: "List a project's active Features as picker options" })
  @ApiResponse({ status: 200, type: PortfolioFeatureOptionResponseDto, isArray: true })
  @ApiCommonErrors(400, 401, 403)
  async listFeatureOptions(
    @CurrentUser() user: JwtPayload,
    @Query() query: PortfolioFeatureOptionsQueryDto,
  ): Promise<PortfolioFeatureOptionResponseDto[]> {
    return this.service.listFeatureOptions(user, query.projectId);
  }

  @Get(':id')
  // Resolved by LOADING the row: the project id is only reachable via `:id` here, and a
  // bad id becomes a clean 404 rather than a misleading 403.
  @RequirePermission('portfolio:view', { resource: 'portfolio_item', from: 'param', field: 'id' })
  @ApiOperation({ summary: 'Get an Epic or Feature with its rollups' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: PortfolioItemDetailResponseDto })
  @ApiCommonErrors(401, 404)
  async getItem(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PortfolioItemDetailResponseDto> {
    return toDetailDto(await this.service.getItem(user, id));
  }

  @Get(':id/activity')
  @RequirePermission('portfolio:view', { resource: 'portfolio_item', from: 'param', field: 'id' })
  @ApiOperation({ summary: 'List the revision history of an Epic or Feature' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: ActivityPageDto })
  @ApiCommonErrors(401, 404)
  async getActivity(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ActivityQueryDto,
  ): Promise<ActivityPageDto> {
    const { page, pageSize } = query;
    const result = await this.service.getActivity(user, id, {
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    return { data: result.items.map(toActivityDto), total: result.total, page, pageSize };
  }

  @Get(':id/children')
  @RequirePermission('portfolio:view', { resource: 'portfolio_item', from: 'param', field: 'id' })
  @ApiOperation({ summary: 'List the Story/Defect linked to a Feature' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiPagedResponse(PortfolioChildResponseDto)
  @ApiCommonErrors(400, 401, 404)
  async listChildren(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PortfolioChildrenQueryDto,
  ): Promise<PagedResult<PortfolioChildResponseDto>> {
    const args = buildPageArgs(query);
    const page = await this.service.listChildren(user, id, { ...args, search: query.search });
    return { data: page.data.map(toChildDto), pageInfo: page.pageInfo };
  }

  @Post()
  // Scoped from the BODY: a create names its project explicitly, so unlike the list
  // route the guard CAN resolve one project and check `portfolio:create` against it.
  @RequirePermission('portfolio:create', { from: 'body', field: 'projectId' })
  @ApiOperation({ summary: 'Create an Epic or Feature' })
  @ApiResponse({ status: 201, type: PortfolioItemResponseDto })
  @ApiCommonErrors(400, 401, 403, 422)
  async createItem(
    @CurrentUser() user: JwtPayload,
    @Body() body: CreatePortfolioItemDto,
  ): Promise<PortfolioItemResponseDto> {
    return toDto(await this.service.createItem(user, toWriteInput(body)));
  }

  @Patch(':id')
  // Resolved by LOADING the row — the project is only reachable through `:id`, and the
  // body deliberately cannot carry a projectId (moving projects is not supported).
  @RequirePermission('portfolio:edit', { resource: 'portfolio_item', from: 'param', field: 'id' })
  @ApiOperation({ summary: 'Update an Epic or Feature' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: PortfolioItemResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 422)
  async updateItem(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdatePortfolioItemDto,
  ): Promise<PortfolioItemResponseDto> {
    return toDto(await this.service.updateItem(user, id, toWriteInput(body)));
  }

  @Patch(':id/rank')
  // Reordering IS an edit, so it takes `portfolio:edit` rather than a separate code —
  // there is no meaningful authority to reorder without being able to change the item.
  @RequirePermission('portfolio:edit', { resource: 'portfolio_item', from: 'param', field: 'id' })
  @ApiOperation({ summary: 'Move an Epic or Feature between two neighbours' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: PortfolioItemResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 422)
  async rankItem(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RankPortfolioItemDto,
  ): Promise<PortfolioItemResponseDto> {
    return toDto(await this.service.rankItem(user, id, body));
  }

  @Post(':id/archive')
  @RequirePermission('portfolio:archive', {
    resource: 'portfolio_item',
    from: 'param',
    field: 'id',
  })
  @ApiOperation({ summary: 'Archive an Epic or Feature (soft delete)' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: PortfolioItemResponseDto })
  @ApiCommonErrors(401, 403, 404, 422)
  async archiveItem(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PortfolioItemResponseDto> {
    return toDto(await this.service.setArchived(user, id, true));
  }

  @Post(':id/unarchive')
  // Restoring is the inverse of archiving, so it takes the SAME permission rather than
  // `portfolio:edit` — anyone who can hide an item can bring it back, and no one else.
  @RequirePermission('portfolio:archive', {
    resource: 'portfolio_item',
    from: 'param',
    field: 'id',
  })
  @ApiOperation({ summary: 'Restore an archived Epic or Feature' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: PortfolioItemResponseDto })
  @ApiCommonErrors(401, 403, 404)
  async unarchiveItem(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PortfolioItemResponseDto> {
    return toDto(await this.service.setArchived(user, id, false));
  }

  @Get(':id/features')
  @RequirePermission('portfolio:view', { resource: 'portfolio_item', from: 'param', field: 'id' })
  @ApiOperation({ summary: "List an Epic's child Features" })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: PortfolioItemResponseDto, isArray: true })
  @ApiCommonErrors(401, 404)
  async listChildFeatures(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PortfolioItemResponseDto[]> {
    const children = await this.service.listChildFeatures(user, id);
    return children.map(toDto);
  }
}
