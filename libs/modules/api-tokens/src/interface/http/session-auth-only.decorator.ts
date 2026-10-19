import { applyDecorators, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth } from '@nestjs/swagger';

import { SessionAuthGuard } from '@platform';

import { RejectApiTokenAuthGuard } from './reject-api-token-auth.guard';

/**
 * Authenticate, then refuse API-token principals. Use instead of `@Auth()` on any route that manages
 * credentials.
 *
 * ONE `UseGuards` call with both guards, in this order, deliberately. Guards inside a single array run
 * in array order, so the rejection sees the principal the authentication guard just set. The obvious
 * arrangement — `@UseGuards(RejectApiTokenAuthGuard)` on the controller and `@Auth()` on each route —
 * does NOT work: Nest runs controller-level guards BEFORE route-level ones, so the rejection ran before
 * anything had authenticated, read an unset `apiTokenId`, and allowed every token through. A token could
 * mint another token, which makes a leak permanent. Caught by `api-tokens.e2e.spec.ts`; invisible to a
 * unit test, because each guard is correct on its own.
 */
export const SessionAuthOnly = () =>
  applyDecorators(
    UseGuards(SessionAuthGuard, RejectApiTokenAuthGuard),
    ApiCookieAuth('session'),
    ApiBearerAuth('access-token'),
  );
