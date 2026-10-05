import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { ApiCommonErrors } from '@platform';
import type { JwtPayload } from '@platform';
import { CurrentUser } from '@modules/identity';
import { AuthPolicy, RequirePermission } from '@modules/access';
import { ReportingService } from '../../application/reporting.service';
import {
  burndownCsv,
  carryoverCsv,
  exportFilename,
  teamCapacityCsv,
  velocityCsv,
} from '../../application/report-csv';
import {
  CarryoverQueryDto,
  IterationBurndownQueryDto,
  ReleaseBurnupQueryDto,
  ReleaseTrackingQueryDto,
  TeamCapacityQueryDto,
  VelocityQueryDto,
} from './dto/reporting-request.dto';
import {
  CarryoverReportResponseDto,
  IterationBurndownResponseDto,
  ReleaseBurnupResponseDto,
  ReleaseTrackingResponseDto,
  TeamCapacityResponseDto,
  VelocityResponseDto,
} from './dto/reporting-response.dto';
import type {
  CarryoverReport,
  IterationBurndownReport,
  ReleaseBurnupReport,
  ReleaseTrackingReport,
  ReportContext,
  TeamCapacityReport,
  VelocityReport,
} from '../../domain/reporting.types';

/** Set the CSV headers on the reply and hand back the body (`passthrough` sends it). */
function sendCsv(
  reply: FastifyReply,
  report: string,
  context: ReportContext,
  scope: string,
  body: string,
): string {
  const filename = exportFilename(report, context.projectName, scope);
  reply.header('Content-Type', 'text/csv; charset=utf-8');
  reply.header('Content-Disposition', `attachment; filename="${filename}"`);
  reply.header('Cache-Control', 'no-store');
  return body;
}

/**
 * Phase 6 read surface: the three reports on the `Reports` page plus Portfolio > Release
 * Tracking. Read-only — nothing here writes, and the daily snapshot jobs are internal
 * scheduled work with no HTTP route.
 *
 * Every route is gated on `report:view` resolved against `projectId` in the query string.
 * That is the Project half of §5.2's requirement; the Team half is enforced inside the
 * service by pushing the selected Team into each query rather than filtering afterwards.
 *
 * Routes are verbs of the report, not of the entity (`/reports/velocity`, not
 * `/projects/:id/velocity`): the scope is a query concern here — Project, Team and timebox
 * all come from the global context — and putting one of the three in the path would imply a
 * hierarchy the reports do not have.
 */
@ApiTags('reporting')
@Controller('reports')
@AuthPolicy()
export class ReportingController {
  constructor(private readonly reporting: ReportingService) {}

  @Get('iteration-burndown')
  @RequirePermission('report:view', { from: 'query', field: 'projectId' })
  @ApiOperation({
    summary: 'Iteration Burndown — frozen daily Remaining To Do, Accepted Points and Ideal',
  })
  @ApiResponse({ status: 200, type: IterationBurndownResponseDto })
  @ApiCommonErrors(400, 401, 403, 404)
  async getIterationBurndown(
    @CurrentUser() user: JwtPayload,
    @Query() query: IterationBurndownQueryDto,
  ): Promise<IterationBurndownReport> {
    return this.reporting.getIterationBurndown(user, {
      projectId: query.projectId,
      teamId: query.teamId,
      iterationId: query.iterationId,
    });
  }

  @Get('velocity')
  @RequirePermission('report:view', { from: 'query', field: 'projectId' })
  @ApiOperation({
    summary: 'Velocity — Accepted During / After / Not Accepted per completed timebox',
  })
  @ApiResponse({ status: 200, type: VelocityResponseDto })
  @ApiCommonErrors(400, 401, 403, 404)
  async getVelocity(
    @CurrentUser() user: JwtPayload,
    @Query() query: VelocityQueryDto,
  ): Promise<VelocityReport> {
    return this.reporting.getVelocity(user, {
      projectId: query.projectId,
      teamId: query.teamId,
      window: query.window,
    });
  }

  @Get('team-capacity')
  @RequirePermission('report:view', { from: 'query', field: 'projectId' })
  @ApiOperation({ summary: 'Team Capacity — a read-only projection of the Team Status hours' })
  @ApiResponse({ status: 200, type: TeamCapacityResponseDto })
  @ApiCommonErrors(400, 401, 403, 404)
  async getTeamCapacity(
    @CurrentUser() user: JwtPayload,
    @Query() query: TeamCapacityQueryDto,
  ): Promise<TeamCapacityReport> {
    return this.reporting.getTeamCapacity(user, {
      projectId: query.projectId,
      teamId: query.teamId,
      iterationId: query.iterationId,
    });
  }

  // ── Carryover (Phase 7 CO-10) ─────────────────────────────────────────────

  @Get('carryover')
  @RequirePermission('report:view', { from: 'query', field: 'projectId' })
  @ApiOperation({ summary: 'Carryover — Carry In / Out, transferred To Do, rate, trend and rows' })
  @ApiResponse({ status: 200, type: CarryoverReportResponseDto })
  @ApiCommonErrors(400, 401, 403, 404)
  async getCarryover(
    @CurrentUser() user: JwtPayload,
    @Query() query: CarryoverQueryDto,
  ): Promise<CarryoverReport> {
    return this.reporting.getCarryover(user, {
      projectId: query.projectId,
      teamId: query.teamId,
      iterationId: query.iterationId,
      direction: query.direction,
    });
  }

  // ── CSV export (Phase 7 rulings R1/R4, plan D11) ──────────────────────────
  //
  // `report:export` — Workspace Admin and Project Admin only. Each route takes its report's OWN query
  // DTO and calls the SAME service method the JSON route calls, so a CSV cannot disagree with the
  // screen. Declared before nothing that could capture it: every path is a fixed two-segment string.

  @Get('iteration-burndown/export')
  @RequirePermission('report:export', { from: 'query', field: 'projectId' })
  @ApiOperation({ summary: 'Iteration Burndown as CSV' })
  @ApiProduces('text/csv')
  @ApiResponse({ status: 200, schema: { type: 'string' } })
  @ApiCommonErrors(400, 401, 403, 404)
  async exportIterationBurndown(
    @CurrentUser() user: JwtPayload,
    @Query() query: IterationBurndownQueryDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    const report = await this.getIterationBurndown(user, query);
    return sendCsv(
      reply,
      'iteration-burndown',
      report.context,
      report.timebox.name,
      burndownCsv(report),
    );
  }

  @Get('velocity/export')
  @RequirePermission('report:export', { from: 'query', field: 'projectId' })
  @ApiOperation({ summary: 'Velocity as CSV' })
  @ApiProduces('text/csv')
  @ApiResponse({ status: 200, schema: { type: 'string' } })
  @ApiCommonErrors(400, 401, 403, 404)
  async exportVelocity(
    @CurrentUser() user: JwtPayload,
    @Query() query: VelocityQueryDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    const report = await this.getVelocity(user, query);
    return sendCsv(reply, 'velocity', report.context, `last-${report.window}`, velocityCsv(report));
  }

  @Get('team-capacity/export')
  @RequirePermission('report:export', { from: 'query', field: 'projectId' })
  @ApiOperation({ summary: 'Team Capacity as CSV' })
  @ApiProduces('text/csv')
  @ApiResponse({ status: 200, schema: { type: 'string' } })
  @ApiCommonErrors(400, 401, 403, 404)
  async exportTeamCapacity(
    @CurrentUser() user: JwtPayload,
    @Query() query: TeamCapacityQueryDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    const report = await this.getTeamCapacity(user, query);
    return sendCsv(
      reply,
      'team-capacity',
      report.context,
      report.timebox.name,
      teamCapacityCsv(report),
    );
  }

  @Get('carryover/export')
  @RequirePermission('report:export', { from: 'query', field: 'projectId' })
  @ApiOperation({ summary: 'Carryover as CSV — honours the Direction filter' })
  @ApiProduces('text/csv')
  @ApiResponse({ status: 200, schema: { type: 'string' } })
  @ApiCommonErrors(400, 401, 403, 404)
  async exportCarryover(
    @CurrentUser() user: JwtPayload,
    @Query() query: CarryoverQueryDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    const report = await this.getCarryover(user, query);
    return sendCsv(reply, 'carryover', report.context, report.timebox.name, carryoverCsv(report));
  }

  @Get('release-tracking')
  @RequirePermission('report:view', { from: 'query', field: 'projectId' })
  @ApiOperation({
    summary: 'Release Tracking — Direct / Derived / Unparented buckets, rows and totals',
  })
  @ApiResponse({ status: 200, type: ReleaseTrackingResponseDto })
  @ApiCommonErrors(400, 401, 403, 404)
  async getReleaseTracking(
    @CurrentUser() user: JwtPayload,
    @Query() query: ReleaseTrackingQueryDto,
  ): Promise<ReleaseTrackingReport> {
    return this.reporting.getReleaseTracking(user, {
      projectId: query.projectId,
      teamId: query.teamId,
      releaseId: query.releaseId,
      unit: query.unit,
      bucket: query.bucket,
      page: query.page,
      pageSize: query.pageSize,
      q: query.q,
      sort: query.sort,
    });
  }

  @Get('release-tracking/burnup')
  @RequirePermission('report:view', { from: 'query', field: 'projectId' })
  @ApiOperation({ summary: 'Release Tracking burnup — Accepted, Planned, Preliminary and Ideal' })
  @ApiResponse({ status: 200, type: ReleaseBurnupResponseDto })
  @ApiCommonErrors(400, 401, 403, 404)
  async getReleaseBurnup(
    @CurrentUser() user: JwtPayload,
    @Query() query: ReleaseBurnupQueryDto,
  ): Promise<ReleaseBurnupReport> {
    return this.reporting.getReleaseBurnup(user, {
      projectId: query.projectId,
      teamId: query.teamId,
      releaseId: query.releaseId,
      unit: query.unit,
    });
  }
}
