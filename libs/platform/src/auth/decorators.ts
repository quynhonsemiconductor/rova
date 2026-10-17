import {
  SetMetadata,
  applyDecorators,
  UseGuards,
  createParamDecorator,
  ExecutionContext,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiResponse } from '@nestjs/swagger';
import { Public as IdentityPublic } from '@quynhonsemiconductor/identity/nest';
import { IS_PUBLIC_KEY } from './public-key';
import { SessionAuthGuard } from './session-auth.guard';
import type { JwtPayload } from './principal';

export { IS_PUBLIC_KEY };

/**
 * Mark a route as unauthenticated.
 *
 * Sets BOTH keys: rova's own (read by {@link SessionAuthGuard}, the rate limiter, the route audit and `ApiTokenGuard`)
 * and identity's, which its global `SessionGuard` reads. Setting only ours would answer 401 on the health probes before
 * our guard is ever reached.
 */
export const Public = () => applyDecorators(SetMetadata(IS_PUBLIC_KEY, true), IdentityPublic());

/**
 * Extract the authenticated principal from the request.
 * Only use on routes protected by @Auth() or SessionAuthGuard.
 *
 * @example
 * async getMe(@CurrentUser() user: JwtPayload) { ... }
 */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): JwtPayload => {
  const request = ctx.switchToHttp().getRequest<{ user: JwtPayload }>();
  return request.user;
});

// ── Swagger error-response shortcuts ────────────────────────────────────────

/**
 * 412 is here because `PreconditionFailedException` is this codebase's most common refusal — the state
 * of the target is wrong for a request that is otherwise well-formed and authorized — and the union
 * omitted it, so those routes had to document themselves as 422 or say nothing.
 */
type HttpErrorCode = 400 | 401 | 403 | 404 | 409 | 412 | 422 | 429;

const HTTP_ERROR_DESCRIPTIONS: Record<HttpErrorCode, string> = {
  400: 'Bad Request — validation error or malformed input',
  401: 'Unauthorized — missing or invalid authentication',
  403: 'Forbidden — insufficient permissions',
  404: 'Not Found',
  409: 'Conflict — duplicate record or state conflict',
  412: 'Precondition Failed — the target is not in a state that allows this',
  422: 'Unprocessable — business rule violation',
  429: 'Too Many Requests — rate limit exceeded',
};

/**
 * Attach standard @ApiResponse decorators in one call.
 *
 * @example
 * // Authenticated write with conflict risk:
 * @ApiCommonErrors(400, 401, 403, 404, 409)
 */
export const ApiCommonErrors = (...codes: HttpErrorCode[]) =>
  applyDecorators(
    ...codes.map((c) => ApiResponse({ status: c, description: HTTP_ERROR_DESCRIPTIONS[c] })),
  );

/**
 * Authentication only: turn the caller's identity session (or API token) into `request.user` and annotate Swagger. It
 * carries NO authorization: a route under `@Auth()` alone is open to every authenticated caller, which is correct only for
 * surfaces that are self-scoped by construction (`me/*`, `notifications/*`, addressed by `user.sub`) or that run around a
 * session existing (`auth/*`).
 *
 * For anything that resolves a workspace or project resource, use `@AuthPolicy()` on the controller plus
 * `@RequirePermission(...)` from `@modules/access`, which is the single authorization decision point.
 *
 * The scheme names: `session` is the cookie, `access-token` is the API token (`Authorization: Bearer rly_...`); the name
 * is kept so the generated client and every `@ApiBearerAuth('access-token')` stay as they were.
 */
export const Auth = () =>
  applyDecorators(
    UseGuards(SessionAuthGuard),
    ApiCookieAuth('session'),
    ApiBearerAuth('access-token'),
  );
