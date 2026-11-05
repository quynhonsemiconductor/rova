import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { RateLimitMetrics, rateLimitRouteLabel } from './rate-limit.metrics';

const request = (over: Partial<FastifyRequest> = {}): FastifyRequest =>
  ({ url: '/v1/work-items/019f8a00-0000-7000-8000-000000000001', ...over }) as FastifyRequest;

describe('RateLimitMetrics', () => {
  it('uses the matched route TEMPLATE when Fastify has one, never the concrete URL', () => {
    const req = request({
      routeOptions: { url: '/v1/work-items/:id' },
    } as unknown as Partial<FastifyRequest>);
    expect(rateLimitRouteLabel(req)).toBe('/v1/work-items/:id');
  });

  it('falls back to a normalised path when no template is available', () => {
    expect(rateLimitRouteLabel(request())).toBe('/v1/work-items/:id');
    expect(rateLimitRouteLabel(request({ url: '/v1/projects?limit=100' }))).toBe('/v1/projects');
  });

  it('records a refusal without throwing, whatever the meter does', () => {
    const metrics = new RateLimitMetrics();
    expect(() =>
      metrics.recordRejected({ tier: 'DEFAULT', route: '/v1/projects', keyedBy: 'user' }),
    ).not.toThrow();
  });
});
