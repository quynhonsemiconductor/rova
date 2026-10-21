import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { clientIp, currentUserId, KEYED_BY_ADDRESS } from '@quynhonsemiconductor/platform-http';
import { RateLimitedException } from '../errors/exceptions';
import {
  RATE_LIMIT_METADATA_KEY,
  RATE_LIMIT_TIERS,
  SKIP_RATE_LIMIT_KEY,
  type RateLimitTier,
} from './rate-limit.constants';

import { failOpenLog, SecurityMetrics } from '@quynhonsemiconductor/observability';

/**
 * Global rate-limit guard backed by Valkey (Redis-compatible) sliding window.
 *
 * Registered as APP_GUARD in PlatformModule so it applies to every route.
 * Behaviour can be overridden per-route:
 *   @RateLimit('STRICT')      — tighter tier
 *   @SkipRateLimit()          — bypass entirely (health probes, etc.)
 *
 * Key strategy
 * ────────────
 * Pre-auth (login, public routes): keyed by client IP.
 *   key = "{tier}:ip:{clientIp(req)}"
 *
 * Post-auth (the request context holds a principal: identity's global SessionGuard, or ApiTokenGuard, ran BEFORE
 * this one and called `setRequestPrincipal`; `RateLimitModule` is imported after both for that reason):
 * keyed by authenticated user ID — fairer for enterprise users behind NAT
 * or shared corporate egress IPs.
 *   key = "{tier}:uid:{userId}"
 *
 * Response headers (RFC 6585 / IETF draft-ietf-httpapi-ratelimit-headers)
 * ────────────────────────────────────────────────────────────────────────
 *   RateLimit-Limit     — the window ceiling
 *   RateLimit-Remaining — requests left in the current window
 *   RateLimit-Reset     — Unix timestamp when the window resets
 *   Retry-After         — seconds to wait (only on 429)
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  /** Skip all rate-limiting when DISABLE_RATE_LIMIT=true (dev / CI only). */
  private readonly disabled = process.env['DISABLE_RATE_LIMIT'] === 'true';

  constructor(
    private readonly reflector: Reflector,
    private readonly cache: CacheService,
    private readonly securityMetrics: SecurityMetrics,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // ── Dev bypass: DISABLE_RATE_LIMIT=true ─────────────────────────────────
    if (this.disabled) return true;

    // ── @SkipRateLimit() check ───────────────────────────────────────────────
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    // ── Resolve tier (decorator > default) ──────────────────────────────────
    const tier =
      this.reflector.getAllAndOverride<RateLimitTier>(RATE_LIMIT_METADATA_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'DEFAULT';

    const { limit, windowSeconds } = RATE_LIMIT_TIERS[tier];

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();

    // The CLIENT's address, by `clientIp()` and never `req.ip`: behind the Cloudflare Tunnel `req.ip` is cloudflared's
    // own address, so every visitor shared ONE bucket (and AUTH_LOGIN's 5 attempts per 15 minutes were the whole
    // company's). `clientIp()` returns the verified signed edge address when EDGE_CLIENT_IP_SECRET is set, else
    // `cf-connecting-ip`, else the first X-Forwarded-For entry, else the socket. One answer per request, so the
    // access log and idempotency agree with it.
    const ip = clientIp(req);
    const userId = currentUserId();

    // ── Build tracking key ───────────────────────────────────────────────────
    // Prefer authenticated user ID so corporate NAT users aren't penalised for each other. Fall back to IP for public routes.
    // The authenticated user comes from the request context (`setRequestPrincipal`), not from `req.user`.
    const identifier = userId ? `uid:${userId}` : `ip:${ip}`;
    // Remembered on the request: a guard that authenticates AFTER this one (identity's SessionGuard, when this guard is registered
    // in the wrong module) can tell the caller it ran too late.
    if (!userId) (req as unknown as Record<symbol, unknown>)[KEYED_BY_ADDRESS] = true;
    const key = `${tier}:${identifier}`;

    // ── Consume one token from the bucket ────────────────────────────────────
    let allowed: boolean;
    let remaining: number;
    let resetAt: number;

    try {
      ({ allowed, remaining, resetAt } = await this.cache.consumeRateLimit(
        key,
        limit,
        windowSeconds,
      ));
    } catch (err) {
      // Rate limiting is a protective control, not a hard dependency for serving
      // traffic. If Valkey is unavailable, fail open and surface the outage via
      // logs — tagged so the CloudWatch alarm in infra/live/* fires, because
      // "allowing every request" is invisible otherwise.
      this.logger.error(
        failOpenLog('rate_limit', { err, key, tier, ip, userId }),
        'Rate limit backend unavailable; allowing request',
      );
      this.securityMetrics.recordFailOpen('rate_limit');
      return true;
    }

    // Always set informational headers (clients can surface remaining budget)
    const setHeader = (name: string, value: string | number) =>
      void reply.header(name, String(value));

    setHeader('RateLimit-Limit', limit);
    setHeader('RateLimit-Remaining', remaining);
    setHeader('RateLimit-Reset', resetAt);

    if (!allowed) {
      const retryAfter = Math.max(resetAt - Math.floor(Date.now() / 1000), 1);
      setHeader('Retry-After', retryAfter);

      this.logger.warn({ key, tier, ip, userId }, 'Rate limit exceeded');

      throw new RateLimitedException(`Rate limit exceeded (${tier}). Retry after ${retryAfter}s.`);
    }

    return true;
  }
}
