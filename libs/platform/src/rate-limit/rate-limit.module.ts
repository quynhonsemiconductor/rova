import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RateLimitGuard } from './rate-limit.guard';

/**
 * The global rate-limit guard, in a module of its own.
 *
 * `RateLimitGuard` keys an authenticated request by user id, which it reads from the request context's principal. That
 * principal is written by identity's global `SessionGuard` (and by the API-token guard), so this guard MUST run after
 * them. Global guards run in the order their modules are registered, and a guard declared in the root module (or in
 * `PlatformModule`, which is imported first) runs BEFORE every imported module's. So the guard lives here and
 * `AppModule` imports this module after the identity and API-token modules; an e2e spec pins the order. Use
 * `@RateLimit('TIER')` to override on a route, `@SkipRateLimit()` to opt out.
 */
@Module({ providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }] })
export class RateLimitModule {}
