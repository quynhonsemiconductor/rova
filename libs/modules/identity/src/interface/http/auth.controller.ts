import { Body, Controller, Get, HttpCode, Inject, Patch, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import '@fastify/cookie';
import type {} from '@fastify/csrf-protection';
import {
  Auth,
  ApiCommonErrors,
  ConflictException,
  NotFoundException,
  PermissionDeniedException,
  SESSION_COOKIE,
} from '@platform';
import type { JwtPayload } from '@platform';
import { revokeUserSessions, setContext, type Identity } from '@quynhonsemiconductor/identity';
import { AUTH } from '@quynhonsemiconductor/identity/nest';
import { AccessService, SelfScoped } from '@modules/access';
import { WorkspaceService } from '@modules/workspace';
import { AttachmentsService, USER_AVATAR_POLICY } from '@modules/attachments';
import { SwitchWorkspaceDto, UpdateProfileDto } from './dto/update-profile.dto';
import { UserProfileResponseDto } from './dto/auth-response.dto';
import {
  PresignAvatarDto,
  PresignAvatarResponseDto,
  ConfirmAvatarDto,
  ConfirmAvatarResponseDto,
} from './dto/avatar.dto';
import { CurrentUser } from './decorators/current-user.decorator';
import { UserDirectory, type Profile } from '../../infrastructure/auth/user-directory';
import { ProfileSync } from '../../infrastructure/auth/profile-sync';

/**
 * What is left of `/v1/auth`: the SPA's "who am I?", the profile, and the workspace switch.
 *
 * Signing in and out is identity 8's own surface, mounted at `/api/auth/*` (Better Auth: `sign-in/social`, the Microsoft
 * callback, `sign-out`); the Pages Function proxies it so it is same-origin with the SPA. The v7 routes (`/v1/bff/*`:
 * login, callback, dev-login, logout, switch-workspace, me) are gone with the BFF session they served.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly directory: UserDirectory,
    private readonly accessService: AccessService,
    private readonly workspaceService: WorkspaceService,
    private readonly attachments: AttachmentsService,
    private readonly profileSync: ProfileSync,
    @Inject(AUTH) private readonly auth: Identity,
  ) {}

  /** Everything the SPA shell needs to render: the profile, the effective permissions, the workspaces, a CSRF token. */
  @Get('me')
  @SelfScoped("returns the caller's own principal")
  @Auth()
  @ApiOperation({ summary: 'Return the authenticated user, their workspaces and permissions' })
  @ApiResponse({ status: 200, type: UserProfileResponseDto })
  @ApiCommonErrors(401)
  async me(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<UserProfileResponseDto> {
    const profile = await this.requireProfile(user.sub);
    const body = await this.render(user, profile);
    // Minted here rather than from a dedicated endpoint: the SPA already calls this on every start and page refresh, so
    // the token's lifecycle matches the session's with no extra round-trip, and `generateCsrf` plants the signed secret
    // cookie on the first call. Bound to the session cookie, so a token lifted from one session cannot be replayed in
    // another. An API-token caller has no cookie and needs none.
    const session = req.cookies?.[SESSION_COOKIE];
    return { ...body, csrfToken: session ? reply.generateCsrf({ userInfo: session }) : undefined };
  }

  /** Update the authenticated user's own editable profile fields. */
  @Patch('me')
  @SelfScoped("updates the caller's own profile")
  @Auth()
  @ApiOperation({ summary: 'Update authenticated user profile' })
  @ApiResponse({ status: 200, type: UserProfileResponseDto })
  @ApiCommonErrors(400, 401, 422)
  async updateProfile(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateProfileDto,
  ): Promise<UserProfileResponseDto> {
    const profile = await this.profileSync.updateProfile(user.sub, dto);
    return this.render(user, profile);
  }

  /**
   * Switch the session's active workspace. A service-side `setContext` rather than identity's own
   * `POST /api/auth/context/set`, so the switch keeps rova's CSRF gate and stamps `last_active_at` (which is what the next
   * sign-in's `initial()` returns). The caller must be an active member: identity asks `workspace_members` and answers
   * 403 `CONTEXT_FORBIDDEN` otherwise, changing nothing.
   */
  @Post('switch-workspace')
  @SelfScoped("switches the caller's own session to another of THEIR workspaces")
  @HttpCode(204)
  @Auth()
  @ApiOperation({ summary: 'Make another of your workspaces the active one' })
  @ApiCommonErrors(401, 403)
  async switchWorkspace(
    @CurrentUser() user: JwtPayload,
    @Body() dto: SwitchWorkspaceDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    if (user.apiTokenId) {
      throw new PermissionDeniedException(
        'API_TOKEN_CANNOT_SWITCH_WORKSPACE',
        'An API token is bound to its workspace. Use an interactive session.',
      );
    }
    const { headers } = await setContext(this.auth, {
      headers: new Headers(req.headers as Record<string, string>),
      contextId: dto.workspaceId,
    });
    // The staff preset has no cookie cache, so there is nothing to forward; the public preset would need it.
    for (const [name, value] of headers)
      if (name.toLowerCase() === 'set-cookie') reply.header(name, value);
    await this.workspaceService.touchMembership(user.sub, dto.workspaceId);
  }

  /** Presign a PUT URL to upload the current user's avatar. */
  @Post('me/avatar/presign')
  @SelfScoped("presigns an upload for the caller's own avatar")
  @Auth()
  @ApiOperation({ summary: 'Presign a PUT URL to upload the current user avatar' })
  @ApiResponse({ status: 201, type: PresignAvatarResponseDto })
  @ApiCommonErrors(400, 401, 409, 422)
  async presignAvatar(
    @CurrentUser() user: JwtPayload,
    @Body() dto: PresignAvatarDto,
  ): Promise<PresignAvatarResponseDto> {
    const { fileId, uploadUrl, requiredHeaders } = await this.attachments.presign(
      user,
      USER_AVATAR_POLICY,
      {
        filename: 'avatar',
        mimeType: dto.contentType,
        sizeBytes: dto.contentLength,
        checksumSha256: dto.checksumSha256,
      },
      0,
    );
    return { fileId, uploadUrl, requiredHeaders };
  }

  /** Confirm the uploaded avatar and store its public URL on the profile. */
  @Post('me/avatar/confirm')
  @SelfScoped("confirms the caller's own avatar upload")
  @Auth()
  @ApiOperation({ summary: 'Confirm the uploaded avatar and store it on the profile' })
  @ApiResponse({ status: 201, type: ConfirmAvatarResponseDto })
  @ApiCommonErrors(400, 401, 404, 409, 422)
  async confirmAvatar(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ConfirmAvatarDto,
  ): Promise<ConfirmAvatarResponseDto> {
    await this.attachments.confirm(user, dto.fileId, USER_AVATAR_POLICY);
    const { url, expiresInSeconds } = await this.attachments.getDownloadUrl(
      user,
      dto.fileId,
      USER_AVATAR_POLICY,
    );
    if (expiresInSeconds > 0) {
      throw new ConflictException(
        'AVATAR_STORAGE_UNCONFIGURED',
        'Avatar storage is not configured (no public CDN base URL).',
      );
    }
    await this.profileSync.updateProfile(user.sub, { avatarUrl: url });
    return { avatarUrl: url };
  }

  /** "Sign out everywhere": end every session of the caller. */
  @Post('logout-all')
  @SelfScoped("revokes the caller's own sessions")
  @Auth()
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke all sessions for the authenticated user' })
  @ApiResponse({ status: 204, description: 'All sessions revoked' })
  @ApiCommonErrors(401)
  async logoutAll(
    @CurrentUser() user: JwtPayload,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await revokeUserSessions(this.auth, user.sub);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  private async requireProfile(userId: string): Promise<Profile> {
    const profile = await this.directory.findById(userId);
    if (!profile) throw new NotFoundException('USER_NOT_FOUND', 'User not found');
    return profile;
  }

  private async render(user: JwtPayload, profile: Profile): Promise<UserProfileResponseDto> {
    // A session with no active workspace (a new guest not yet seated, a member whose only workspace was removed) is a valid session:
    // it has no role and no permissions, and `/v1/auth/me` must say so instead of querying a uuid column with ''.
    const [{ role, permissions }, memberships, settings] = await Promise.all([
      user.workspaceId
        ? this.accessService.getUserRoleAndPermissions(user.sub, user.workspaceId)
        : Promise.resolve({ role: '', permissions: [] as string[] }),
      this.workspaceService.getMemberships(user.sub),
      user.workspaceId
        ? this.workspaceService.getSettings(user.workspaceId).catch(() => null)
        : Promise.resolve(null),
    ]);
    return {
      id: profile.id,
      email: profile.email,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      locale: profile.locale,
      timezone: profile.timezone,
      phone: profile.phone ?? null,
      role,
      permissions,
      emailVerified: profile.emailVerified,
      createdAt: profile.createdAt.toISOString(),
      updatedAt: profile.updatedAt.toISOString(),
      memberships,
      workspaceDefaults: settings
        ? {
            timezone: settings.timezone,
            locale: settings.defaultLocale,
            dateFormat: settings.dateFormat,
          }
        : null,
    };
  }
}
