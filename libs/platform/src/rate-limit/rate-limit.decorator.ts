import { SetMetadata, applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { RATE_LIMIT_METADATA_KEY, SKIP_RATE_LIMIT_KEY } from './rate-limit.constants';
import type { RateLimitTier } from './rate-limit.constants';

/**
 * Override the default rate-limit tier on a controller or route handler.
 *
 * @example
 * // Default for a route with no decorator — 100/min per user (per address on a public route)
 *
 * // Sensitive write — 20/min
 * @RateLimit('STRICT')
 * async deleteProject(...) {}
 */
export const RateLimit = (tier: RateLimitTier) =>
  applyDecorators(
    SetMetadata(RATE_LIMIT_METADATA_KEY, tier),
    // Auto-document the 429 response in Swagger
    ApiResponse({
      status: 429,
      description: 'Too Many Requests — rate limit exceeded. Check Retry-After header.',
    }),
  );

/**
 * Opt a route completely out of rate limiting.
 * Use only for infrastructure endpoints (health probes, metrics scrapes).
 *
 * @example
 * @SkipRateLimit()
 * @Get('healthz')
 * healthz() { return { status: 'ok' } }
 */
export const SkipRateLimit = () => SetMetadata(SKIP_RATE_LIMIT_KEY, true);
