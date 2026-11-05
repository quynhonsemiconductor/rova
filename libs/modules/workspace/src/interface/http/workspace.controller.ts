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
import {
  ApiBearerAuth,
  ApiExcludeEndpoint,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  Auth,
  ApiCommonErrors,
  ApiPagedResponse,
  buildPageArgs,
  PageQueryDto,
  UseIdempotency,
  RateLimit,
  NotFoundException,
} from '@platform';
import type { JwtPayload, PagedResult, EmailDeliveryStatus } from '@platform';
import { AuthPolicy, RequirePermission, AuthorizedInService } from '@modules/access';
import { CurrentUser } from '@modules/identity/interface/http/decorators/current-user.decorator';
import { WorkspaceService } from '../../application/workspace.service';
import {
  CreateWorkspaceDto,
  UpdateWorkspaceDto,
  AddMemberDto,
  UpdateMemberDto,
  InviteMemberDto,
  AcceptInvitationDto,
  UpdateWorkspaceSettingsDto,
} from './dto/workspace-request.dto';
import {
  WorkspaceResponseDto,
  MemberResponseDto,
  MemberOptionResponseDto,
  MemberWithProfileResponseDto,
  InvitationResponseDto,
  InvitationLinkResponseDto,
  WorkspaceSettingsResponseDto,
} from './dto/workspace-response.dto';
import type {
  Workspace,
  WorkspaceMember,
  WorkspaceInvitation,
  WorkspaceSettings,
} from '../../domain/workspace.types';

// ── Mappers ──────────────────────────────────────────────────────────────────

function toWorkspaceDto(w: Workspace): WorkspaceResponseDto {
  return {
    id: w.id,
    slug: w.slug,
    name: w.name,
    description: w.description,
    avatarUrl: w.avatarUrl,
    settings: w.settings,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}

function toMemberDto(m: WorkspaceMember): MemberResponseDto {
  return {
    id: m.id,
    workspaceId: m.workspaceId,
    userId: m.userId,
    roleId: m.roleId,
    status: m.status,
    joinedAt: m.joinedAt?.toISOString() ?? new Date().toISOString(),
    createdAt: m.createdAt.toISOString(),
  };
}

function toInvitationDto(
  i: WorkspaceInvitation & { emailDelivery?: EmailDeliveryStatus },
): InvitationResponseDto {
  return {
    id: i.id,
    workspaceId: i.workspaceId,
    email: i.email,
    roleId: i.roleId,
    status: i.status,
    invitedBy: i.invitedBy,
    expiresAt: i.expiresAt.toISOString(),
    emailDelivery: i.emailDelivery ?? 'unknown',
    resendCount: i.resendCount,
    lastSentAt: i.lastSentAt.toISOString(),
    acceptedBy: i.acceptedBy,
    acceptedAt: i.acceptedAt?.toISOString() ?? null,
    createdAt: i.createdAt.toISOString(),
  };
}

function toSettingsDto(s: WorkspaceSettings): WorkspaceSettingsResponseDto {
  return {
    workspaceId: s.workspaceId,
    timezone: s.timezone,
    defaultLocale: s.defaultLocale,
    dateFormat: s.dateFormat,
    updatedAt: s.updatedAt.toISOString(),
  };
}

// ── Controllers ──────────────────────────────────────────────────────────────

@ApiTags('workspaces')
@Controller('workspaces')
@AuthPolicy()
export class WorkspaceController {
  constructor(private readonly workspaceService: WorkspaceService) {}

  /**
   * Guard: workspace-scoped routes operate strictly on the caller's active
   * workspace. A path id that isn't the active workspace is treated as
   * not-found so we never leak the existence of other workspaces.
   */
  private assertActive(user: JwtPayload, id: string): void {
    if (id !== user.workspaceId) {
      throw new NotFoundException('WORKSPACE_NOT_FOUND', 'Workspace not found');
    }
  }

  // ── List workspaces ────────────────────────────────────────────────────────

  @Get()
  @AuthorizedInService(
    'lists only the workspaces the caller is a member of',
    'workspace.service.spec.ts',
  )
  @ApiOperation({ summary: 'List workspaces the authenticated user belongs to' })
  @ApiPagedResponse(WorkspaceResponseDto)
  @ApiCommonErrors(401)
  async listWorkspaces(
    @CurrentUser() user: JwtPayload,
    @Query() query: PageQueryDto,
  ): Promise<PagedResult<WorkspaceResponseDto>> {
    const args = buildPageArgs(query);
    const page = await this.workspaceService.listWorkspacesForUser(user.sub, args);
    return { data: page.data.map(toWorkspaceDto), pageInfo: page.pageInfo };
  }

  // ── Create workspace ───────────────────────────────────────────────────────
  // MVP constraint: workspace provisioning is system-only (COMPANY-FR-010).

  @Post()
  @RequirePermission('workspace:create')
  @ApiExcludeEndpoint()
  @ApiOperation({ summary: 'Create a new workspace' })
  @ApiResponse({ status: 201, type: WorkspaceResponseDto })
  @ApiCommonErrors(400, 401, 409, 422)
  async createWorkspace(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateWorkspaceDto,
  ): Promise<WorkspaceResponseDto> {
    const workspace = await this.workspaceService.createWorkspace(
      user,
      dto.slug,
      dto.name,
      dto.description,
      dto.avatarUrl,
    );
    return toWorkspaceDto(workspace);
  }

  // ── Get workspace ──────────────────────────────────────────────────────────

  @Get(':id')
  @AuthorizedInService(
    'membership of the requested workspace is checked in the service',
    'workspace.service.spec.ts',
  )
  @ApiOperation({ summary: 'Get workspace details' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: WorkspaceResponseDto })
  @ApiCommonErrors(401, 404)
  async getWorkspace(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WorkspaceResponseDto> {
    this.assertActive(user, id);
    const workspace = await this.workspaceService.getWorkspace(id);
    return toWorkspaceDto(workspace);
  }

  // ── Update workspace ───────────────────────────────────────────────────────

  @Patch(':id')
  @RequirePermission('workspace:edit')
  @ApiOperation({ summary: 'Update workspace' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: WorkspaceResponseDto })
  @ApiCommonErrors(400, 401, 404, 422)
  async updateWorkspace(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkspaceDto,
  ): Promise<WorkspaceResponseDto> {
    this.assertActive(user, id);
    const workspace = await this.workspaceService.updateWorkspace(id, dto, user.sub);
    return toWorkspaceDto(workspace);
  }

  // ── Delete workspace ───────────────────────────────────────────────────────
  // MVP constraint: workspace archival is system-only (COMPANY-FR-010).

  @Delete(':id')
  @RequirePermission('workspace:delete')
  @ApiExcludeEndpoint()
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete workspace (soft delete)' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Workspace deleted' })
  @ApiCommonErrors(401, 404)
  async deleteWorkspace(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    this.assertActive(user, id);
    await this.workspaceService.deleteWorkspace(id);
  }

  // ── `GET :id/members` IS DELETED. Do not re-add it. ────────────────────────
  //
  // It listed every workspace member with their `roleId` and account `status`, behind an
  // in-service authorization claim whose stated reason was "membership of the workspace whose
  // members are listed" — which is `assertActive` and nothing more, so ANY active member read the
  // whole company's role assignments, including a principal with No Access to every project.
  //
  // (Written without the decorator's call syntax on purpose: `test/route-policy.ratchet.spec.ts`
  // parses source TEXT, so a comment reproducing `@AuthorizedInService(...)` is counted as a live
  // citation and fails on the pinning spec it names.)
  //
  // Deleted rather than gated, because a gate would have preserved a route with NO CONSUMER: the
  // SPA never called it (nothing outside the generated client referenced
  // `/v1/workspaces/{id}/members'`), nothing in `apps/worker` did, and no other service did — the
  // only caller of `WorkspaceService.listMembers` was this handler, so that method is gone with it.
  // A gated dead route is worse than no route: it keeps a payload alive for whoever finds it next
  // and it reads, in review, as a considered decision about an audience.
  //
  // Its two real audiences already have routes, split by what they serve (RBE-07, below):
  //   • a picker needs id / name / email / avatar  → `:id/member-options`
  //   • User Management needs the rest             → `:id/members-with-profile` (`workspace:view`)
  // If a future surface needs paged membership WITH role ids, it wants a new route named for that
  // audience and gated on `users:assign_role` or `workspace:view` — not this one back.

  // ── The roster, SPLIT IN TWO (RBE-07) ──────────────────────────────────────
  //
  // One route used to serve both audiences, and it was reachable by any authenticated caller —
  // including a principal with No Access, i.e. no active `project_members` row anywhere. So the
  // company directory, with `phone`, `lastLoginAt` and every role id, was readable by an Editor and
  // by a non-participant alike. It could not simply be gated, because it also feeds the Portfolio
  // and Projects OWNER PICKERS: gating it as an admin surface 403s ordinary delivery screens, which
  // is why CLAUDE.md recorded it as deferred behind "split the feed first".
  //
  // The split is by AUDIENCE, and each route is named for what it serves:
  //   • `:id/member-options`       — the assignee / owner picker feed. id, name, email, avatar.
  //   • `:id/members-with-profile` — the User Management administrative roster. Everything else.
  //
  // The sensitive fields are `phone`, `lastLoginAt` and the role ids — NOT name and email, which
  // are already on screen wherever someone is an assignee, a lead or a team member.

  @Get(':id/member-options')
  @AuthorizedInService(
    'the picker feed is scoped by AccessService.listReadableProjectIds — null means UNRESTRICTED and [] means a No Access principal reads nobody, a distinction no scope descriptor can carry, and no permission code fits: an Editor holds no workspace-tier code and there is no project in the path',
    'directory-team-authz.e2e.spec.ts',
  )
  @ApiOperation({
    summary: 'Assignee / owner picker feed — workspace members at display fields only',
  })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: MemberOptionResponseDto, isArray: true })
  @ApiCommonErrors(401, 404)
  async listMemberOptions(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MemberOptionResponseDto[]> {
    this.assertActive(user, id);
    return this.workspaceService.listMemberOptions(id, user.sub);
  }

  @Get(':id/members-with-profile')
  // `workspace:view`, the code that already gates `GET :id/settings` on this controller: an
  // existing, workspace-tier, Workspace-Admin-only read code for workspace administration data,
  // which a staff directory carrying contact details and last-login times is. Deliberately NOT a
  // new `users:view` — the catalogue's own comment said there was no such gate because "roster
  // READS stay open, owner pickers need them", and with the picker feed split out that premise is
  // gone rather than needing a new code (and a new code would need a backfill migration to reach an
  // existing workspace at all).
  //
  // Chosen for what the ACTION is, not for where the id lives. Every consumer of the sensitive
  // fields is Workspace-Admin-only already: Members (`users:assign_role`), Workspace Settings
  // (`workspace:view`), Audit (`audit:view`), the project Add-Member modal
  // (`project:manage_members`) and the Team form (`teams:create` / `teams:edit`). None of them
  // loses anything; the picker screens moved to the feed above.
  @RequirePermission('workspace:view')
  @ApiOperation({
    summary: 'User Management roster — profile, contact details and roles (Workspace Admin only)',
  })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: MemberWithProfileResponseDto, isArray: true })
  @ApiCommonErrors(401, 403, 404)
  async listMembersWithProfile(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MemberWithProfileResponseDto[]> {
    this.assertActive(user, id);
    return this.workspaceService.listMembersWithProfile(id) as unknown as Promise<
      MemberWithProfileResponseDto[]
    >;
  }

  // ── Add member ─────────────────────────────────────────────────────────────

  @Post(':id/members')
  @RequirePermission('users:assign_role')
  @ApiOperation({ summary: 'Add a user to the workspace' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 201, type: MemberResponseDto })
  @ApiCommonErrors(400, 401, 404, 409, 422)
  async addMember(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddMemberDto,
  ): Promise<MemberResponseDto> {
    this.assertActive(user, id);
    const member = await this.workspaceService.addMember(id, dto.userId, user.sub);
    return toMemberDto(member);
  }

  // ── Update member ──────────────────────────────────────────────────────────

  @Patch(':id/members/:memberId')
  @RequirePermission('users:assign_role')
  @ApiOperation({ summary: 'Update member role or status' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'memberId', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: MemberResponseDto })
  @ApiCommonErrors(400, 401, 404, 409, 422)
  async updateMember(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() dto: UpdateMemberDto,
  ): Promise<MemberResponseDto> {
    this.assertActive(user, id);
    const member = await this.workspaceService.updateMember(id, memberId, dto, user.sub);
    return toMemberDto(member);
  }

  // ── Remove member ──────────────────────────────────────────────────────────

  @Delete(':id/members/:userId')
  @RequirePermission('users:remove')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a user from the workspace' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'userId', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Member removed' })
  @ApiCommonErrors(401, 404)
  async removeMember(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    this.assertActive(user, id);
    await this.workspaceService.removeMember(id, userId, user.sub);
  }

  // ── Invite member ──────────────────────────────────────────────────────────

  @Post(':id/invitations')
  @RequirePermission('users:invite')
  @UseIdempotency()
  @RateLimit('STRICT')
  @ApiOperation({ summary: 'Invite a user to the workspace by email' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 201, type: InvitationResponseDto })
  @ApiCommonErrors(400, 401, 409, 422)
  async inviteMember(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InviteMemberDto,
  ): Promise<InvitationResponseDto> {
    this.assertActive(user, id);
    const invitation = await this.workspaceService.inviteMember(
      id,
      dto.email,
      dto.roleId,
      user.sub,
      // §6.4 — the projects and levels the invitee lands with, so the common path does not produce
      // a member who can see nothing. Absent means "no initial access", the pre-§6.4 behaviour.
      dto.projectAccess ?? [],
    );
    return toInvitationDto(invitation);
  }

  // ── List invitations ───────────────────────────────────────────────────────

  @Get(':id/invitations')
  // Same code as sending one. The list is the pending-hire roster — address plus assigned role — and
  // it was readable by any authenticated member while `POST` was correctly gated. Its only consumer
  // is User Management, which the SRS reserves for Workspace Admin.
  @RequirePermission('users:invite')
  @ApiOperation({ summary: 'List invitations for a workspace' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: [InvitationResponseDto] })
  @ApiCommonErrors(401, 404)
  async listInvitations(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InvitationResponseDto[]> {
    this.assertActive(user, id);
    const invitations = await this.workspaceService.listInvitations(id);
    return invitations.map(toInvitationDto);
  }

  // ── Resend invitation ──────────────────────────────────────────────────────

  @Post(':id/invitations/:invitationId/resend')
  @RequirePermission('users:invite')
  @RateLimit('STRICT')
  @ApiOperation({ summary: 'Resend a pending or expired workspace invitation' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'invitationId', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: InvitationResponseDto })
  @ApiCommonErrors(400, 401, 404, 409)
  async resendInvitation(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('invitationId', ParseUUIDPipe) invitationId: string,
  ): Promise<InvitationResponseDto> {
    this.assertActive(user, id);
    const invitation = await this.workspaceService.resendInvitation(id, invitationId, user.sub);
    return toInvitationDto(invitation);
  }

  // ── Copy invitation link ───────────────────────────────────────────────────
  // Same guard and rate class as resend — the token ROTATES, so this endpoint is a
  // credential-issuing action and not a free read — but nothing is emailed: the URL
  // is handed to the inviter to deliver over whatever channel reaches the member.
  // The members this exists for are internal-domain colleagues whose mail path is
  // unreliable (tenant filters quarantine transactional senders) — see
  // WorkspaceService.buildInvitationLink for the rotation and cooldown semantics.

  @Post(':id/invitations/:invitationId/link')
  @RequirePermission('users:invite')
  @RateLimit('STRICT')
  @ApiOperation({
    summary:
      'Rotate and return the invitation accept URL without emailing — deliver it by any channel',
  })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'invitationId', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: InvitationLinkResponseDto })
  @ApiCommonErrors(400, 401, 404, 409)
  async buildInvitationLink(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('invitationId', ParseUUIDPipe) invitationId: string,
  ): Promise<InvitationLinkResponseDto> {
    this.assertActive(user, id);
    const link = await this.workspaceService.buildInvitationLink(id, invitationId, user.sub);
    return {
      invitationId: link.invitationId,
      email: link.email,
      inviteUrl: link.inviteUrl,
      expiresAt: link.expiresAt.toISOString(),
    };
  }

  // ── Cancel invitation ──────────────────────────────────────────────────────

  @Delete(':id/invitations/:invitationId')
  @RequirePermission('users:invite')
  @HttpCode(204)
  @ApiOperation({ summary: 'Cancel a pending workspace invitation' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'invitationId', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Invitation cancelled' })
  @ApiCommonErrors(401, 404)
  async cancelInvitation(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('invitationId', ParseUUIDPipe) invitationId: string,
  ): Promise<void> {
    this.assertActive(user, id);
    await this.workspaceService.cancelInvitation(id, invitationId, user.sub);
  }

  // ── Workspace settings ─────────────────────────────────────────────────────

  @Get(':id/settings')
  // "Only `workspace_admin` can view and edit Workspace Settings … Project Member cannot access
  // Workspace Settings" (Settings/Audit SRS). The WRITE was already gated `workspace:edit`; the read
  // carried nothing, and a route with no metadata is OPEN — so any member could read the workspace's
  // timezone, locale, working days and preliminary-estimate config. The only consumer is the
  // admin-only Workspace Settings tab, so this restores the contract without moving the UI.
  @RequirePermission('workspace:view')
  @ApiOperation({ summary: 'Get workspace settings' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: WorkspaceSettingsResponseDto })
  @ApiCommonErrors(401, 404)
  async getSettings(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WorkspaceSettingsResponseDto> {
    this.assertActive(user, id);
    const settings = await this.workspaceService.getSettings(id);
    return toSettingsDto(settings);
  }

  @Patch(':id/settings')
  @RequirePermission('workspace:edit')
  @ApiOperation({ summary: 'Update workspace settings' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: WorkspaceSettingsResponseDto })
  @ApiCommonErrors(400, 401, 404, 422)
  async updateSettings(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkspaceSettingsDto,
  ): Promise<WorkspaceSettingsResponseDto> {
    this.assertActive(user, id);
    const settings = await this.workspaceService.updateSettings(id, dto, user.sub);
    return toSettingsDto(settings);
  }
}

// ── Authenticated invitation accept ──────────────────────────────────────────
// Accepting an invitation requires the recipient to be authenticated first.
// The frontend flow: receive email → log in / register → POST /invitations/accept.

@ApiTags('invitations')
@Controller('invitations')
export class InvitationController {
  constructor(private readonly workspaceService: WorkspaceService) {}

  @Post('accept')
  @AuthorizedInService(
    'the invitation token identifies the row and acceptance is bound to the invited email, case-insensitively',
    // Re-pointed from `invitation.service.spec.ts`, which pinned an ORPHANED fork of this flow that
    // no module ever provided — a citation to a spec that proved nothing about this route. The
    // `describe('acceptInvitation')` block here drives `WorkspaceService.acceptInvitation`, the
    // method the handler below actually calls, and asserts both directions: the forwarded-link
    // refusal (`INVITATION_EMAIL_MISMATCH`) and the differently-cased-mailbox accept.
    'workspace.service.spec.ts',
  )
  @Auth()
  @HttpCode(204)
  @ApiOperation({ summary: 'Accept a workspace invitation (authenticated user only)' })
  @ApiBearerAuth('access-token')
  @ApiResponse({ status: 204, description: 'Invitation accepted' })
  @ApiCommonErrors(400, 401, 404, 422)
  async acceptInvitation(
    @Body() dto: AcceptInvitationDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.workspaceService.acceptInvitation(dto.token, user.sub);
  }
}
