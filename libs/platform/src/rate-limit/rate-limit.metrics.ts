import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { getMeter, normalizeRoute } from '@quynhonsemiconductor/observability';
import type { RateLimitTier } from './rate-limit.constants';

/** Who the refused bucket was counting: the signed-in person, or the client address. */
export type RateLimitKeyedBy = 'user' | 'address';

/**
 * The route TEMPLATE for logs and metrics, never the concrete URL.
 *
 * Nest/Fastify has already matched the route by the time a guard runs, so `routeOptions.url` is the
 * template (`/v1/work-items/:id`). `normalizeRoute` is the fallback for a test stub or a framework
 * change, and keeps an id out of a metric label.
 */
export function rateLimitRouteLabel(req: FastifyRequest): string {
  const matched = (req as unknown as { routeOptions?: { url?: string } }).routeOptions?.url;
  return matched ?? normalizeRoute(req.url);
}

/**
 * A 429 that reached a caller, by tier and route.
 *
 * `http.server.requests` groups every 4xx into one status class, so it cannot answer "was a
 * signed-in person throttled?". This counter can: `keyed_by="user"` is the one SA/G alerts on
 * (`sum(increase(rate_limit_rejected_total{keyed_by="user"}[5m])) > 0`), and `keyed_by="address"`
 * is the pre-auth floor doing its job. Labels are bounded by construction — `tier` is a closed
 * union and `route` is a template — so no user id or raw URL ever becomes a series.
 *
 * Prometheus name: `rate_limit_rejected_total{tier,route,keyed_by}`.
 */
@Injectable()
export class RateLimitMetrics {
  private readonly rejected = getMeter('rova-api').createCounter('rate.limit.rejected', {
    description: 'Requests refused by a rate-limit bucket, by tier, route and who was counted',
  });

  recordRejected(input: { tier: RateLimitTier; route: string; keyedBy: RateLimitKeyedBy }): void {
    // Telemetry must never be able to fail a request; an OTel no-op instrument makes this cheap.
    try {
      this.rejected.add(1, {
        tier: input.tier,
        route: input.route,
        keyed_by: input.keyedBy,
      });
    } catch {
      // deliberately swallowed: a refused request stays a refused request
    }
  }
}
