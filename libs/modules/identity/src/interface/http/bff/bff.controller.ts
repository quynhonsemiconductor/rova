import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
// `reply.generateCsrf` is a type augmentation contributed by @fastify/csrf-protection.
// The API registers that plugin in its bootstrap, but the WORKER build compiles this
// module too (it imports the identity module) without ever touching the bootstrap — so
// without this type-only import the augmentation is absent from the worker's program and
// `nest build worker` fails with TS2339. Type-only: no runtime import is emitted.
import type {} from '@fastify/csrf-protection';
import '@fastify/cookie';
import { Auth, AppConfigService, Public, RateLimit, UnauthorizedException } from '@platform';
import { AuthMetrics } from '@quynhonsemiconductor/observability';
import { clientIp } from '@quynhonsemiconductor/platform-http';
import type { JwtPayload } from '@platform';
import {
  AuthService,
  BffService,
  readCookie,
  SSO_CONNECTION_REPOSITORY,
  type ISsoConnectionRepository,
} from '@quynhonsemiconductor/identity';
import { AccessService, SelfScoped } from '@modules/access';
import { WorkspaceService } from '@modules/workspace';
import { CurrentUser } from '../decorators/current-user.decorator';
import { UserProfileResponseDto } from '../dto/auth-response.dto';
import { DevLoginDto, LoginSsoDto, LoginStartDto, SwitchWorkspaceDto } from '../dto/login.dto';
import {
  BFF_SESSION_COOKIE,
  BFF_STATE_COOKIE,
  BFF_STATE_COOKIE_MAX_AGE_SECONDS,
} from './bff.constants';

/**
 * Backend-for-Frontend auth surface. Runs the Entra Authorization-Code + PKCE
 * flow server-side and issues an opaque `__Host-` session cookie so tokens
 * never reach the browser. This is rally's only authentication surface.
 *
 * Excluded from Swagger: these are browser-redirect endpoints, not a JSON API.
 */
@ApiExcludeController()
@Controller('bff')
export class BffController {
  constructor(
    private readonly bff: BffService,
    private readonly authService: AuthService,
    private readonly accessService: AccessService,
    private readonly workspaceService: WorkspaceService,
    private readonly config: AppConfigService,
    @Inject(SSO_CONNECTION_REPOSITORY) private readonly ssoRepo: ISsoConnectionRepository,
    private readonly authMetrics: AuthMetrics,
  ) {}

  // ── POST /bff/login/sso ────────────────────────────────────────────────────
  // Public: one-click "Sign in with Microsoft" shortcut. Starts the HOME
  // directory connection directly via the broker (no email typed) — the home
  // tenant's members AND its Entra guests all authenticate through it. Sets the
  // browser-bound `state` cookie and returns the IdP authorize URL for the SPA.
  @Post('login/sso')
  @Public()
  @RateLimit('AUTH_SSO_START')
  @HttpCode(200)
  async loginSso(
    @Body() dto: LoginSsoDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ authorizeUrl: string }> {
    const tenantId = this.config.get('ENTRA_TENANT_ID');
    const home = tenantId ? await this.ssoRepo.findByExternalTenantId('entra', tenantId) : null;
    if (!home) {
      throw new UnauthorizedException('SSO_NO_ACCESS', 'No access — contact your administrator');
    }
    const { authorizeUrl, state } = await this.bff.beginLoginById(dto.returnTo, home.id);
    reply.setCookie(BFF_STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax', // must survive the top-level redirect back from the IdP
      path: '/',
      maxAge: BFF_STATE_COOKIE_MAX_AGE_SECONDS,
    });
    return { authorizeUrl };
  }

  // ── POST /bff/login/start ──────────────────────────────────────────────────
  // Public: email-first entry for the multi-IdP broker. Resolves the email's
  // federated connection, sets the browser-bound `state` cookie, and returns the
  // IdP authorize URL for the SPA to redirect to. An unknown / unmatched email
  // surfaces as 401 `NO_CONNECTION` ("contact your administrator").
  @Post('login/start')
  @Public()
  @RateLimit('AUTH_IDP_LOOKUP')
  @HttpCode(200)
  async loginStart(
    @Body() dto: LoginStartDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ authorizeUrl: string }> {
    const { authorizeUrl, state } = await this.bff.beginLogin(dto.returnTo, dto.email);
    reply.setCookie(BFF_STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax', // must survive the top-level redirect back from the IdP
      path: '/',
      maxAge: BFF_STATE_COOKIE_MAX_AGE_SECONDS,
    });
    return { authorizeUrl };
  }

  // ── GET /bff/callback ────────────────────────────────────────────────────
  // Public: Entra redirects here with ?code&state. Verifies state, exchanges the
  // code, mints a session, sets the `__Host-` session cookie, and 302s to returnTo.
  @Get('callback')
  @Public()
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (!code || !state) {
      throw new UnauthorizedException('AUTH_TOKEN_INVALID', 'Missing authorization code or state');
    }

    const cookieState = readCookie(req, BFF_STATE_COOKIE);
    let result: { sid: string; returnTo: string };
    try {
      result = await this.bff.completeLogin({ code, state, cookieState, ip: clientIp(req) });
    } catch {
      // Never surface OIDC/internal detail to the browser on the login path — the
      // metric is what tells us login itself is degraded, since the 401 alone
      // cannot distinguish a broken IdP integration from a user retrying a stale link.
      this.authMetrics.recordLogin('sso', 'failure');
      throw new UnauthorizedException('AUTH_TOKEN_INVALID', 'Login could not be completed');
    }
    this.authMetrics.recordLogin('sso', 'success');

    reply.clearCookie(BFF_STATE_COOKIE, { path: '/' });
    reply.setCookie(BFF_SESSION_COOKIE, result.sid, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: this.bff.sessionTtlSeconds,
    });
    this.redirect(reply, result.returnTo);
  }

  // ── POST /bff/dev-login ──────────────────────────────────────────────────
  // DEV/E2E ONLY (404 in production): passwordless mint of a real server-side
  // session so the same-origin cookie flow can be exercised locally without an
  // Entra tenant. Unlike a bearer mint, this lands the session on the SERVER
  // (sets the `__Host-` session cookie) rather than handing tokens to the browser.
  @Post('dev-login')
  @Public()
  // The ONE route here that submits something secret and mints a session from it, so the
  // brute-force tier belongs on this one and not on the two SSO-initiation routes above. It had no
  // limit at all: 404 in production, but `NODE_ENV` defaults to `development` in `env.schema.ts`, so
  // a lost environment variable fails open to an unlimited passwordless-login oracle.
  @RateLimit('AUTH_LOGIN')
  @HttpCode(204)
  async devLogin(
    @Body() dto: DevLoginDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    if (!this.bff.devLoginAllowed) {
      throw new NotFoundException();
    }
    let sid: string;
    try {
      sid = await this.bff.devLogin(dto.email, clientIp(req));
    } catch (err) {
      this.authMetrics.recordLogin('dev', 'failure');
      throw err;
    }
    this.authMetrics.recordLogin('dev', 'success');
    reply.setCookie(BFF_SESSION_COOKIE, sid, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: this.bff.sessionTtlSeconds,
    });
  }

  // ── POST /bff/logout ─────────────────────────────────────────────────────
  // Authenticated via the shared guard's session-cookie path (@Auth). `bffSid`
  // is populated by JwtAuthGuard when it resolves the session.
  @Post('logout')
  @SelfScoped("destroys the caller's own server-side session")
  @HttpCode(204)
  @Auth()
  async logout(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest & { bffSid?: string },
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const sid = req.bffSid ?? readCookie(req, BFF_SESSION_COOKIE);
    if (sid) {
      await this.bff.logout(sid, user);
    }
    reply.clearCookie(BFF_SESSION_COOKIE, { path: '/' });
  }

  // ── POST /bff/switch-workspace ───────────────────────────────────────────
  // Session-cookie authenticated mirror of POST /v1/auth/switch-workspace.
  // Re-issues tokens for the target workspace and stores them on the SAME
  // session, so the browser keeps its existing session cookie and simply starts
  // resolving to the new workspace. No token is returned to the client.
  @Post('switch-workspace')
  @SelfScoped("switches the caller's own session to another of THEIR workspaces")
  @HttpCode(204)
  @Auth()
  async switchWorkspace(
    @Body() dto: SwitchWorkspaceDto,
    @Req() req: FastifyRequest & { bffSid?: string },
  ): Promise<void> {
    const sid = req.bffSid ?? readCookie(req, BFF_SESSION_COOKIE);
    if (!sid) {
      throw new UnauthorizedException('AUTH_TOKEN_INVALID', 'No active BFF session');
    }
    const claims = await this.bff.switchWorkspace(sid, dto.workspaceId, clientIp(req));
    if (!claims) {
      throw new UnauthorizedException('AUTH_TOKEN_INVALID', 'Session no longer exists');
    }
  }

  // ── GET /bff/me ──────────────────────────────────────────────────────────
  // Session-cookie authenticated mirror of GET /v1/auth/me.
  @Get('me')
  @SelfScoped("returns the caller's own principal")
  @Auth()
  async me(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<UserProfileResponseDto> {
    const [profile, { role, permissions }, memberships, settings] = await Promise.all([
      this.authService.getMe(user.sub),
      this.accessService.getUserRoleAndPermissions(user.sub, user.workspaceId),
      this.workspaceService.getMemberships(user.sub),
      this.workspaceService.getSettings(user.workspaceId).catch(() => null),
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
      // Mint the CSRF token here rather than from a dedicated endpoint: the SPA
      // already calls /bff/me on every start and page refresh, so the token's
      // lifecycle matches the session's with no extra round-trip. generateCsrf
      // also plants the signed secret cookie on first call.
      csrfToken: reply.generateCsrf({
        userInfo: req.cookies?.[BFF_SESSION_COOKIE] ?? '',
      }),
    };
  }

  /** Version-agnostic 302 redirect (avoids Fastify `reply.redirect` arg-order drift). */
  private redirect(reply: FastifyReply, url: string): void {
    reply.header('location', url).status(302).send();
  }
}
