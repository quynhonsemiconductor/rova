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
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiCommonErrors, ApiPagedResponse, buildPageArgs } from '@platform';
import type { JwtPayload, PagedResult } from '@platform';
import { CurrentUser } from '@modules/identity';
import { RequirePermission, AuthPolicy } from '@modules/access';
import { IterationsService } from '../../application/iterations.service';
import { IterationStatusService } from '../../application/iteration-status.service';
import {
  IterationQueryDto,
  CreateIterationDto,
  UpdateIterationDto,
  RolloverIterationDto,
  IterationAssignmentOptionsQueryDto,
  IterationActivityQueryDto,
} from './dto/iteration-request.dto';
import {
  IterationResponseDto,
  IterationOptionDto,
  IterationReferenceDto,
  IterationActivityResponseDto,
} from './dto/iteration-response.dto';
import {
  IterationStatusQueryDto,
  CreateIterationItemDto,
} from './dto/iteration-status-request.dto';
import {
  IterationStatusResponseDto,
  CreateIterationItemResponseDto,
} from './dto/iteration-status-response.dto';
import type { Iteration, IterationOption, IterationReference } from '../../domain/iteration.types';
import type { ActivityLog as IterationActivityLog } from '@modules/activity';

// ── Mappers ────────────────────────────────────────────────────────────────────

function toIterationOptionDto(o: IterationOption): IterationOptionDto {
  return {
    id: o.id,
    name: o.name,
    iterationKey: o.iterationKey,
    startDate: o.startDate,
    endDate: o.endDate,
    state: o.state,
  };
}

/**
 * Field-by-field, NOT a spread of the row: the reference feed's whole purpose is that a field added
 * to the timebox record cannot reach it. A `{ ...row }` here would undo the split silently.
 */
function toIterationReferenceDto(r: IterationReference): IterationReferenceDto {
  return {
    id: r.id,
    name: r.name,
    iterationKey: r.iterationKey,
    state: r.state,
    startDate: r.startDate,
    endDate: r.endDate,
    teamId: r.teamId,
  };
}

function toIterationDto(i: Iteration): IterationResponseDto {
  return {
    id: i.id,
    workspaceId: i.workspaceId,
    projectId: i.projectId,
    teamId: i.teamId,
    iterationKey: i.iterationKey,
    name: i.name,
    goal: i.goal,
    theme: i.theme,
    notes: i.notes,
    state: i.state,
    plannedVelocity: i.plannedVelocity,
    // IT-001: task-estimate rollup. Optional on the DTO — present on the list
    // (enriched by listIterations), undefined elsewhere.
    taskEstimate: i.taskEstimate,
    startDate: i.startDate,
    endDate: i.endDate,
    completedAt: i.completedAt ? i.completedAt.toISOString() : null,
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
  };
}

function toIterationActivityDto(a: IterationActivityLog): IterationActivityResponseDto {
  return {
    id: a.id,
    createdAt: a.createdAt,
    actorId: a.actorId,
    actorName: a.actorName,
    action: a.action,
    changes: a.changes,
    metadata: a.metadata ?? {},
  };
}

// ── Controller ────────────────────────────────────────────────────────────────

@ApiTags('iterations')
@Controller('iterations')
// Iterations are project-owned. Create checks the project in the body via the
// guard; update/delete/commit/accept resolve the project from the iteration id.
// Guards run in a guaranteed order (JwtAuth → Permission → ProjectPermission).
//
// THE READS SPLIT IN THREE, AND THE SPLIT IS THE POINT (§3.2, RBE-09 / P23-08 / P01-11).
//
//   route                        question it answers                     population         code
//   ───────────────────────────  ──────────────────────────────────────  ─────────────────  ──────────────
//   GET /iterations/options      REFERENCE: what is it called, and when?  every state        iteration:view
//   GET /iterations/assignable   ELIGIBILITY: what may I assign into?     every state        iteration:view
//   GET /iterations              the RECORD: goal/theme/notes/velocity    every state        timebox:view
//   GET /iterations/:id{,/activity}  the RECORD + its revision history    —                 timebox:view
//   GET /iterations/:id/status   Iteration Status read-model              —                  iteration:view
//
// The FIRST split (2026-08-14) separated the SURFACE: `timebox:view` for `Plan > Timeboxes`, which
// §3.2 marks **Hidden** for an Editor, and `iteration:view` for `Track > Iteration Status`, which
// §3.2 grants them as "View and update in assigned Teams". It left `GET /iterations` on
// `iteration:view` because four Editor surfaces read it — so the surface was split and the FEED was
// not, and the timebox RECORD (goal, theme, notes, planned velocity) stayed readable by every
// Editor. That is what this second split closes.
//
// TWO ROUTES AND NOT A `?includeAllStates` FLAG, deliberately. REFERENCE and ELIGIBILITY are two
// different questions, and a flag that silently changes a population is the shape that produced the
// zero-point Velocity bars (CLAUDE.md: "Eligibility must be counted in the SAME scope as the
// measurement"). `/options` keeps the REFERENCE meaning because that word already means "reference
// feed" for releases, milestones, portfolio items and member options — consistency across the seam
// beats avoiding a rename.
//
// Since P6-VEL-004 (BA retest 2026-08-17) the two answers cover the SAME rows and differ only in
// projection (`/options` also returns `team_id`). Eligibility stopped excluding ACCEPTED iterations
// because the write path never refused one: Velocity attributes points by an item's CURRENT
// iteration, so a closed sprint must be selectable or the rule holds only on the way out. The two
// routes stay separate — the eligibility question can narrow again, `/assignable` deliberately does
// NOT expose `team_id`, and the SPA's generated client is committed, so removing a route is a codegen
// change rather than a cleanup.
//
// Do not "simplify" any of these back into one: whichever code won, one of the two §3.2 rows would
// be wrong again. See the TIMEBOX_VIEW docblock in db/permissions.catalog.ts.
@AuthPolicy()
export class IterationsController {
  constructor(
    private readonly iterationsService: IterationsService,
    private readonly iterationStatusService: IterationStatusService,
  ) {}

  @Get()
  /**
   * The timebox RECORD, in a page: `goal`, `theme`, `notes`, `plannedVelocity` and the task-estimate
   * rollup. It is the `Plan > Timeboxes` GRID's feed and nothing else, so it takes the
   * administration code — §3.2 marks that surface Hidden for an Editor.
   *
   * It used to be `iteration:view`, because it was ALSO the feed behind Iteration Status's picker,
   * the Backlog's iteration filter, Team Status and Quality, and gating it would have 403'd all
   * four. `GET /iterations/options` is what those read now: same population, none of the record.
   */
  @RequirePermission('timebox:view', { from: 'query', field: 'projectId' })
  @ApiOperation({
    summary: 'List iterations for a project (the timebox record — Plan > Timeboxes)',
  })
  @ApiPagedResponse(IterationResponseDto)
  @ApiCommonErrors(400, 401, 404)
  async listIterations(
    @CurrentUser() user: JwtPayload,
    @Query() query: IterationQueryDto,
  ): Promise<PagedResult<IterationResponseDto>> {
    const args = buildPageArgs(query);
    const page = await this.iterationsService.listIterations(
      user,
      query.projectId,
      {
        teamId: query.teamId,
        state: query.state,
        q: query.q,
      },
      args,
    );
    return { data: page.data.map(toIterationDto), pageInfo: page.pageInfo };
  }

  @Post()
  @RequirePermission('iteration:create', { from: 'body', field: 'projectId' })
  @ApiOperation({ summary: 'Create an iteration' })
  @ApiResponse({ status: 201, type: IterationResponseDto })
  @ApiCommonErrors(400, 401, 404, 422)
  async createIteration(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateIterationDto,
  ): Promise<IterationResponseDto> {
    const iteration = await this.iterationsService.createIteration(user, dto.projectId, dto.name, {
      teamId: dto.teamId,
      goal: dto.goal,
      theme: dto.theme,
      notes: dto.notes,
      state: dto.state,
      startDate: dto.startDate ?? undefined,
      endDate: dto.endDate ?? undefined,
      plannedVelocity: dto.plannedVelocity,
    });
    return toIterationDto(iteration);
  }

  // ── The two compact feeds (P2-IT-10) — declared before :id to avoid route conflict ──

  @Get('options')
  /**
   * REFERENCE. Every state, `iteration:view` — the code every project access level holds, and must:
   * this is the feed for Iteration Status's picker, the Backlog's iteration filter and its id→name
   * cell, Team Status's picker, Quality's inline cell, the Backlog summary panel and both report
   * scope pickers. Nine of those ten call sites read `GET /iterations` before this existed.
   *
   * `IterationReferenceDto`, NOT `IterationResponseDto`: the payload is identity plus window plus
   * team, and the record's narrative and forecast fields are structurally absent (a separate zod
   * schema, not a `.pick()`).
   *
   * ACCEPTED iterations are INCLUDED: an item's iteration keeps resolving to its name after the
   * sprint closes; without it, a Backlog cell for a genuinely scheduled item rendered `--` — see
   * RELATION_DATA_TRACEABILITY.md. That used to be the difference from `/assignable`; since
   * P6-VEL-004 the difference is the PROJECTION (`team_id`, which `iterationsInScope` needs).
   */
  @RequirePermission('iteration:view', { from: 'query', field: 'projectId' })
  @ApiOperation({
    summary: 'Reference feed: every iteration, for filters, labels and scope pickers',
  })
  @ApiResponse({ status: 200, type: [IterationReferenceDto] })
  @ApiCommonErrors(400, 401, 404)
  async listIterationReferences(
    @CurrentUser() user: JwtPayload,
    @Query() query: IterationAssignmentOptionsQueryDto,
  ): Promise<IterationReferenceDto[]> {
    const references = await this.iterationsService.getIterationReferences(
      user,
      query.projectId,
      query.teamId,
    );
    return references.map(toIterationReferenceDto);
  }

  @Get('assignable')
  /**
   * ELIGIBILITY, `iteration:view` — the population `PATCH /work-items/bulk-iteration` and the
   * inline/sidebar assignment pickers may write into, so a caller is never offered a target the
   * server would refuse AND never denied one it accepts.
   *
   * State is NOT a predicate here (P6-VEL-004, BA retest 2026-08-17): a closed sprint is a legal
   * destination, and excluding it made the move-IN half of Velocity's current-assignment rule
   * impossible from the UI. The rule this mirrors is `assertIterationAssignable` — project, plus
   * team for a team-scoped timebox.
   *
   * This route is `GET /iterations/options` renamed. `/options` took over the reference meaning it
   * carries everywhere else in this API, and the eligibility question moved here rather than
   * becoming a query flag on one endpoint.
   */
  @RequirePermission('iteration:view', { from: 'query', field: 'projectId' })
  @ApiOperation({ summary: 'Eligibility feed: the iterations work may be assigned into' })
  @ApiResponse({ status: 200, type: [IterationOptionDto] })
  @ApiCommonErrors(400, 401, 404)
  async getAssignmentOptions(
    @CurrentUser() user: JwtPayload,
    @Query() query: IterationAssignmentOptionsQueryDto,
  ): Promise<IterationOptionDto[]> {
    const options = await this.iterationsService.getAssignmentOptions(
      user,
      query.projectId,
      query.teamId,
    );
    return options.map(toIterationOptionDto);
  }

  @Get(':id')
  // The timebox RECORD — goal, theme, notes, planned velocity — read by exactly one screen,
  // the `Plan > Timeboxes` detail (`IterationDetail`, the only caller of `useIteration`).
  // §3.2 hides that screen from an Editor, so it takes the administration code.
  @RequirePermission('timebox:view', { resource: 'iteration', from: 'param', field: 'id' })
  @ApiOperation({ summary: 'Get iteration details' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: IterationResponseDto })
  @ApiCommonErrors(401, 404)
  async getIteration(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<IterationResponseDto> {
    const iteration = await this.iterationsService.getIterationForView(user, id);
    return toIterationDto(iteration);
  }

  @Get(':id/activity')
  // Who committed, who moved the dates, who changed the goal — the Timeboxes detail's own
  // Revision History tab, and nothing else calls it. Same gate as the record it belongs to.
  @RequirePermission('timebox:view', { resource: 'iteration', from: 'param', field: 'id' })
  @ApiOperation({ summary: 'List the revision history of an iteration' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: IterationActivityResponseDto, isArray: true })
  @ApiCommonErrors(401, 404)
  async getActivity(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: IterationActivityQueryDto,
  ): Promise<{
    data: IterationActivityResponseDto[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const { page, pageSize } = query;
    const result = await this.iterationsService.getIterationActivity(user, id, {
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    return {
      data: result.items.map(toIterationActivityDto),
      total: result.total,
      page,
      pageSize,
    };
  }

  @Patch(':id')
  @RequirePermission('iteration:edit', { resource: 'iteration', from: 'param', field: 'id' })
  @ApiOperation({ summary: 'Update iteration details' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: IterationResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 422)
  async updateIteration(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateIterationDto,
  ): Promise<IterationResponseDto> {
    const iteration = await this.iterationsService.updateIteration(user, id, dto);
    return toIterationDto(iteration);
  }

  @Delete(':id')
  @RequirePermission('iteration:delete', { resource: 'iteration', from: 'param', field: 'id' })
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete a planning-state iteration that has no recorded Burndown history',
  })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Iteration deleted' })
  @ApiCommonErrors(400, 401, 403, 404)
  async deleteIteration(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.iterationsService.deleteIteration(user, id);
  }

  @Post(':id/commit')
  @RequirePermission('iteration:edit', { resource: 'iteration', from: 'param', field: 'id' })
  @ApiOperation({ summary: 'Commit an iteration (→ committed)' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 201, type: IterationResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 409)
  async commitIteration(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<IterationResponseDto> {
    const iteration = await this.iterationsService.commitIteration(user, id);
    return toIterationDto(iteration);
  }

  @Post(':id/accept')
  @RequirePermission('iteration:edit', { resource: 'iteration', from: 'param', field: 'id' })
  @ApiOperation({
    summary:
      'Accept an iteration (→ accepted). Requires ≥1 assigned Story/Defect and all of them accepted.',
  })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiCommonErrors(400, 401, 403, 404, 422)
  async acceptIteration(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<IterationResponseDto> {
    const iteration = await this.iterationsService.acceptIteration(user, id);
    return toIterationDto(iteration);
  }

  @Post(':id/rollover')
  @RequirePermission('iteration:edit', { resource: 'iteration', from: 'param', field: 'id' })
  @ApiOperation({
    summary: 'Move unfinished items out of an iteration to another iteration or the backlog',
  })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiCommonErrors(400, 401, 403, 404, 422)
  async rolloverIteration(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RolloverIterationDto,
  ): Promise<{ movedCount: number }> {
    return this.iterationsService.rolloverUnfinished(user, id, {
      moveToIterationId: dto.moveToIterationId,
    });
  }

  // ── Iteration Status read-model (P2.3) ──────────────────────────────────────

  @Get(':id/status')
  // `iteration:view`, NOT `timebox:view`: §3.2 gives an Editor `Iteration Status | View
  // and update in assigned Teams`. This is the surface the split exists to keep open.
  @RequirePermission('iteration:view', { resource: 'iteration', from: 'param', field: 'id' })
  @ApiOperation({ summary: 'Get Iteration Status: metrics + assigned work items' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: IterationStatusResponseDto })
  @ApiCommonErrors(400, 401, 404)
  async getIterationStatus(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: IterationStatusQueryDto,
  ): Promise<IterationStatusResponseDto> {
    const args = buildPageArgs(query);
    const result = await this.iterationStatusService.getStatus(
      user,
      id,
      {
        q: query.q,
        type: query.type,
        scheduleState: query.scheduleState,
        isBlocked: query.isBlocked,
        assigneeId: query.assigneeId,
        devOwnerId: query.devOwnerId,
        // Manage Filters (P2-IS-FR-022): the chosen columns' own predicates,
        // combined server-side with everything above and with `q`.
        itemKey: query.itemKey,
        title: query.title,
        planEstimate: query.planEstimate,
        taskEstimate: query.taskEstimate,
        toDo: query.toDo,
        startDate: query.startDate,
        targetEndDate: query.targetEndDate,
      },
      args,
    );
    return {
      iteration: {
        id: result.iteration.id,
        name: result.iteration.name,
        iterationKey: result.iteration.iterationKey,
        startDate: result.iteration.startDate,
        endDate: result.iteration.endDate,
        plannedVelocity: result.iteration.plannedVelocity,
      },
      metrics: result.metrics,
      items: result.items.data,
      pageInfo: result.items.pageInfo,
    };
  }

  @Post(':id/work-items')
  /**
   * `work_item:create`, not `iteration:edit` — creating a Story inside an iteration is a work-item
   * create (Iteration Status SRS: "Create Story/Defect in Iteration | `work_item:create` plus
   * project/team access"), and the service's own docblock already said so.
   *
   * A Project Member holds `work_item:create` and not `iteration:edit`, so they saw the Add New
   * button (gated client-side on `work_item:create`), filled the modal and got a 403 — for an item
   * they can create from the Backlog. The iteration still supplies the project scope.
   */
  @RequirePermission('work_item:create', { resource: 'iteration', from: 'param', field: 'id' })
  @ApiOperation({ summary: 'Create a Story/Defect directly in the iteration' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 201, type: CreateIterationItemResponseDto })
  @ApiCommonErrors(400, 401, 404, 422)
  async createIterationItem(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateIterationItemDto,
  ): Promise<CreateIterationItemResponseDto> {
    return this.iterationStatusService.createItemInIteration(user, id, {
      type: dto.type,
      title: dto.title,
      assigneeId: dto.assigneeId,
      planEstimate: dto.planEstimate,
      teamId: dto.teamId,
    });
  }
}
