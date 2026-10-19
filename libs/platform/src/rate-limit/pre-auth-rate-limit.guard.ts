import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { failOpenLog, SecurityMetrics } from '@quynhonsemiconductor/observability';
import { clientIp } from '@quynhonsemiconductor/platform-http';
import { bearerValue, isApiTokenValue } from '../auth/api-token-principal';
import { RateLimitedException } from '../errors/exceptions';
import { RATE_LIMIT_TIERS, SKIP_RATE_LIMIT_KEY } from './rate-limit.constants';

/**
 * The rate limit that runs BEFORE anyone is authenticated, keyed by the client's address.
 *
 * `RateLimitGuard` keys an authenticated request by user, so it must run AFTER the authenticating guards (ApiTokenGuard, identity's
 * SessionGuard). The consequence is a blind spot it cannot fix from there: a request that fails authentication answers 401 from
 * those guards and never reaches it, so a flood of requests with no credential, or a sweep of guessed `rly_` tokens, was counted by
 * nothing (160 bad tokens: 160 x 401, 0 x 429). This guard is the cheap floor under it, registered FIRST (`PreAuthRateLimitModule`
 * is imported before `ApiTokensModule`). It touches no database: one Valkey increment per bucket.
 *
 * Two buckets: every request (PRE_AUTH), and requests presenting an API token (PRE_AUTH_TOKEN, tighter: each one costs a lookup and a
 * guess is free to repeat). The user-keyed DEFAULT bucket stays where it is, after authentication, so a corporate NAT's users are
 * still not penalised for each other. Honours `@SkipRateLimit()` (probes) and `DISABLE_RATE_LIMIT`; fails open on a cache outage
 * with the same tagged log as RateLimitGuard, so the existing alarm sees it.
 */
@Injectable()
export class PreAuthRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(PreAuthRateLimitGuard.name);
  private readonly disabled = process.env['DISABLE_RATE_LIMIT'] === 'true';

  constructor(
    private readonly reflector: Reflector,
    private readonly cache: CacheService,
    private readonly securityMetrics: SecurityMetrics,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.disabled || context.getType() !== 'http') return true;
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const ip = clientIp(req);

    const bearer = bearerValue(req.headers['authorization']);
    const tiers: Array<'PRE_AUTH' | 'PRE_AUTH_TOKEN'> =
      bearer && isApiTokenValue(bearer) ? ['PRE_AUTH', 'PRE_AUTH_TOKEN'] : ['PRE_AUTH'];

    for (const tier of tiers) {
      const { limit, windowSeconds } = RATE_LIMIT_TIERS[tier];
      const key = `${tier}:ip:${ip}`;
      let outcome: { allowed: boolean; remaining: number; resetAt: number };
      try {
        outcome = await this.cache.consumeRateLimit(key, limit, windowSeconds);
      } catch (err) {
        this.logger.error(
          failOpenLog('rate_limit', { err, key, tier, ip }),
          'Rate limit backend unavailable; allowing request',
        );
        this.securityMetrics.recordFailOpen('rate_limit');
        return true;
      }
      if (!outcome.allowed) {
        const retryAfter = Math.max(outcome.resetAt - Math.floor(Date.now() / 1000), 1);
        void reply.header('Retry-After', String(retryAfter));
        this.logger.warn({ key, tier, ip }, 'Rate limit exceeded');
        throw new RateLimitedException(
          `Rate limit exceeded (${tier}). Retry after ${retryAfter}s.`,
        );
      }
    }
    return true;
  }
}
