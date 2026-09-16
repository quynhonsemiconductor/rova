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
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiCommonErrors, NotFoundException } from '@platform';
import type { JwtPayload } from '@platform';
import { AuthPolicy, RequirePermission, AuthorizedInService } from '@modules/access';
import { CurrentUser } from '@modules/identity/interface/http/decorators/current-user.decorator';
import { TeamService } from '../../application/team.service';
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { teamStatusEnum } from '../../../../../../db/schema/enums';
import type { Team, TeamMember, TeamWithStats } from '../../domain/team.types';

// ── DTOs ──────────────────────────────────────────────────────────────────────

const CreateTeamSchema = z.object({
  name: z.string().min(1).max(255).trim(),
  // SRS Phase 1/08 §8.2 + §4.2: 2-10 uppercase letters/numbers, start with a
  // letter, immutable after creation (UpdateTeamSchema carries no key). The FE
  // enforced this (project-teams-tab) while the API accepted 1-char lowercase.
  key: z
    .string()
    .min(2)
    .max(10)
    .regex(
      /^[A-Z][A-Z0-9]*$/,
      'Key must be 2-10 uppercase letters/numbers, starting with a letter',
    ),
  description: z.string().max(1000).trim().optional(),
  leadId: z.string().uuid().optional(),
  status: z.enum(teamStatusEnum.enumValues).optional(),
  // A team must be linked to at least one project (SRS §2A / TEAM-FR-003/006).
  projectIds: z.array(z.string().uuid()).min(1),
  memberUserIds: z.array(z.string().uuid()).optional(),
});
class CreateTeamDto extends createZodDto(CreateTeamSchema) {}

const UpdateTeamSchema = z.object({
  /**
   * Correcting a key after a rename. This schema deliberately carried no key, on the SRS rule that
   * a key is immutable after creation — written when a project key prefixed every item id, so changing it would have rewritten every identifier at once.
   *
   * `0036_type_prefixed_item_keys` gave items a type prefix (`US-1`) and `0060` moved the counters
   * to the workspace. No item key has contained a project key since, so the rule outlived its
   * reason, and what remained was a name that could be edited beside a key derived from it that
   * could not — leaving `OBSE` on a project called `Infrastructure` with no supported way to fix it.
   *
   * Optional, and never inferred from a rename: a key is displayed beside the name, in the project
   * switcher and in search, and some are chosen rather than derived, so regenerating one from a new
   * name would overwrite a deliberate value. Same shape as create, and uniqueness is re-checked
   * there, since the constraint is per workspace.
   */
  key: z
    .string()
    .min(2)
    .max(10)
    .regex(/^[A-Z][A-Z0-9]*$/, 'Key must be 2-10 uppercase letters/numbers, starting with a letter')
    .optional(),
  name: z.string().min(1).max(255).trim().optional(),
  description: z.string().max(1000).trim().nullable().optional(),
  leadId: z.string().uuid().nullable().optional(),
  status: z.enum(teamStatusEnum.enumValues).optional(),
  // When supplied, replaces the full set (reconciled). Omit to leave unchanged.
  projectIds: z.array(z.string().uuid()).min(1).optional(),
  memberUserIds: z.array(z.string().uuid()).optional(),
});
class UpdateTeamDto extends createZodDto(UpdateTeamSchema) {}

const AddTeamMemberSchema = z.object({ userId: z.string().uuid() });
class AddTeamMemberDto extends createZodDto(AddTeamMemberSchema) {}

// ── Mappers ───────────────────────────────────────────────────────────────────

function toTeamDto(t: Team) {
  return {
    id: t.id,
    workspaceId: t.workspaceId,
    name: t.name,
    key: t.key,
    description: t.description,
    leadId: t.leadId,
    status: t.status,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

function toTeamWithStatsDto(t: TeamWithStats) {
  return { ...toTeamDto(t), memberCount: t.memberCount, projects: t.projects };
}

function toTeamMemberDto(m: TeamMember) {
  return {
    id: m.id,
    teamId: m.teamId,
    userId: m.userId,
    status: m.status,
    joinedAt: m.joinedAt.toISOString(),
    // Resolved by the repo's identity.users join — the roster renders them.
    displayName: m.displayName ?? null,
    email: m.email ?? null,
    avatarUrl: m.avatarUrl ?? null,
    /**
     * `Workspace Admin` is what this row is BADGED as, and the reason it carries no access level.
     *
     * The BA made a Workspace Admin an eligible Team member on 2026-08-20 — operational scope only —
     * while §2.1 still keeps them off `work.project_members`. So `Admin`/`Editor` is not merely absent
     * for them, it would be false, and the roster needs to say which case a blank level is.
     * `false` rather than absent, so a client cannot read "field missing" as "not an admin yet".
     */
    isWorkspaceAdmin: m.isWorkspaceAdmin ?? false,
  };
}

// ── Controller ────────────────────────────────────────────────────────────────

@ApiTags('teams')
@Controller()
@AuthPolicy()
export class TeamController {
  constructor(private readonly teamService: TeamService) {}

  // Workspace-scoped team list + create
  @Get('workspaces/:workspaceId/teams')
  @AuthorizedInService(
    'a cross-project list scoped by AccessService.listReadableProjectIds to the teams linked to a project the caller can read — null means UNRESTRICTED and [] means nothing, which no scope descriptor can carry',
    'directory-team-authz.e2e.spec.ts',
  )
  @ApiOperation({ summary: 'List teams linked to a project the caller can read' })
  @ApiParam({ name: 'workspaceId', type: 'string', format: 'uuid' })
  @ApiQuery({ name: 'includeInactive', required: false, type: 'boolean' })
  @ApiResponse({ status: 200, schema: { type: 'array', items: { type: 'object' } } })
  @ApiCommonErrors(401, 404)
  async listTeams(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    if (workspaceId !== user.workspaceId) {
      throw new NotFoundException('WORKSPACE_NOT_FOUND', 'Workspace not found');
    }
    const teams = await this.teamService.listTeamsForReader(
      workspaceId,
      user.sub,
      includeInactive === 'true',
    );
    return teams.map(toTeamWithStatsDto);
  }

  @Post('workspaces/:workspaceId/teams')
  @RequirePermission('teams:create')
  @ApiOperation({ summary: 'Create a team in a workspace' })
  @ApiParam({ name: 'workspaceId', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 201, schema: { type: 'object' } })
  @ApiCommonErrors(400, 401, 409, 422)
  async createTeam(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body() dto: CreateTeamDto,
  ) {
    if (workspaceId !== user.workspaceId) {
      throw new NotFoundException('WORKSPACE_NOT_FOUND', 'Workspace not found');
    }
    const team = await this.teamService.createTeam(
      workspaceId,
      {
        name: dto.name,
        key: dto.key,
        description: dto.description,
        leadId: dto.leadId,
        status: dto.status,
        projectIds: dto.projectIds,
        memberUserIds: dto.memberUserIds,
      },
      user.sub,
    );
    return toTeamDto(team);
  }

  // Individual team operations
  //
  // The team id resolves to its PROJECT LINKS, and a team may be linked to several — so the check is
  // "readable through at least one of them", which is a resolve-then-check shape no decorator can
  // express (the same reason `GET /work-items/by-key` carries none). Not a `project` scope on a
  // `resource`, either: that resolves ONE project id, and a team does not have one.
  @Get('teams/:id')
  @AuthorizedInService(
    'the team must be linked to at least one project the caller can read; unreachable is 404, so the detail route cannot confirm the existence of a team the list hides',
    'directory-team-authz.e2e.spec.ts',
  )
  @ApiOperation({ summary: 'Get team details' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, schema: { type: 'object' } })
  @ApiCommonErrors(401, 404)
  async getTeam(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    const team = await this.teamService.getTeamForReader(id, user.workspaceId, user.sub);
    return toTeamDto(team);
  }

  @Patch('teams/:id')
  @RequirePermission('teams:edit')
  @ApiOperation({ summary: 'Update team' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, schema: { type: 'object' } })
  @ApiCommonErrors(400, 401, 404, 422)
  async updateTeam(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTeamDto,
  ) {
    const team = await this.teamService.updateTeam(id, dto, user.workspaceId, user.sub);
    return toTeamDto(team);
  }

  /**
   * Delete an ARCHIVED team that holds no history (the workspace Archive surface).
   *
   * `teams:edit` and not a new `teams:delete` code: §3.1 reserves team configuration for the Workspace
   * Admin and `teams:*` is workspace-tier, so the audience is already exactly right — and a NEW
   * permission would reach no existing workspace without a backfill migration (CLAUDE.md,
   * "Permissions reach a workspace ONCE"), which is a lot of machinery for an audience that cannot
   * differ from this one.
   *
   * 412 rather than 409 for both refusals: the request is well-formed and the caller is allowed, but
   * the team is in the wrong state for it (`TEAM_NOT_ARCHIVED`, `TEAM_HAS_HISTORY`) — the same shape as
   * every other precondition in this codebase.
   */
  @Delete('teams/:id')
  @RequirePermission('teams:edit')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete an archived team that holds no delivery or report history' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Team deleted' })
  @ApiCommonErrors(401, 404, 412)
  async deleteTeam(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.teamService.deleteTeam(id, user.workspaceId, user.sub);
  }

  // Team member operations
  @Get('teams/:id/members')
  @AuthorizedInService(
    'same project-link check as the detail route — and this roster carries every member name and EMAIL, so an unscoped read is the directory leak reached through a team id',
    'directory-team-authz.e2e.spec.ts',
  )
  @ApiOperation({ summary: 'List team members' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, schema: { type: 'array', items: { type: 'object' } } })
  @ApiCommonErrors(401, 404)
  async listTeamMembers(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    const members = await this.teamService.listTeamMembersForReader(id, user.workspaceId, user.sub);
    return members.map(toTeamMemberDto);
  }

  @Post('teams/:id/members')
  @RequirePermission('teams:manage_members')
  @ApiOperation({ summary: 'Add a user to a team' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 201, schema: { type: 'object' } })
  @ApiCommonErrors(400, 401, 404, 409, 422)
  async addTeamMember(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddTeamMemberDto,
  ) {
    const member = await this.teamService.addTeamMember(id, dto.userId, user.workspaceId, user.sub);
    return toTeamMemberDto(member);
  }

  @Delete('teams/:id/members/:userId')
  @RequirePermission('teams:manage_members')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a user from a team' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'userId', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Member removed' })
  @ApiCommonErrors(401, 404)
  async removeTeamMember(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    await this.teamService.removeTeamMember(id, userId, user.workspaceId, user.sub);
  }
}
