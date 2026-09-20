import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators';
import { SkipRateLimit } from '../rate-limit/rate-limit.decorator';
import { InjectDrizzle } from '../database/drizzle.provider';
import type { DrizzleDB } from '../database/drizzle.provider';
import { sql } from 'drizzle-orm';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { AppConfigService } from '../config/app-config.service';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly cache: CacheService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Public runtime config the frontend needs before login — e.g. whether
   * workspace creation is open and whether SSO is available. Contains no secrets.
   */
  @Get('config')
  @Public()
  @SkipRateLimit()
  @ApiOperation({ summary: 'Public runtime config for the frontend (no secrets)' })
  @ApiResponse({
    status: 200,
    schema: {
      properties: {
        workspaceCreationOpen: { type: 'boolean', example: true },
        ssoEnabled: { type: 'boolean', example: true },
      },
    },
  })
  publicConfig() {
    return {
      // Any authenticated user can create a workspace and becomes its admin.
      workspaceCreationOpen: true,
      // SSO is available when an Entra app is configured.
      ssoEnabled: Boolean(this.config.get('ENTRA_TENANT_ID') && this.config.get('ENTRA_CLIENT_ID')),
    };
  }

  /**
   * Liveness probe for Kubernetes — is the process alive?
   *
   * SERVED AT `/livez`, NOT `/v1/livez`, and the exclusion that makes that true
   * lives in `apps/api/src/bootstrap/app.bootstrap.ts`. Two reasons it has to be
   * unprefixed, neither of them cosmetic:
   *
   *   1. `gitops/charts/qnsc-service` hardcodes the liveness path and does NOT
   *      expose it as a per-service value — deliberately, per §9j.
   *   2. `gitops/platform/policy/admission.yaml` is a ValidatingAdmissionPolicy
   *      that DENIES any Deployment whose liveness path is not exactly `/livez`.
   *      A prefixed path is not a worse option here; it is a rejected manifest.
   *
   * WHY IT DUPLICATES `healthz` RATHER THAN REPLACING IT. `/v1/healthz` is load
   * bearing on the ECS path — the ALB target group, the Dockerfile HEALTHCHECK
   * and the post-deploy smoke test all point at it — and §17b runs both platforms
   * at once. Removing it would break ECS while Kubernetes is still soaking.
   * They collapse into one when the ECS path goes, at Phase 5.
   *
   * ⚠ IT MUST NEVER TOUCH A DEPENDENCY. §9j: "if liveness checks the database and
   * the database slows down, Kubernetes kills every replica of every service at
   * once, and a slowdown becomes an outage." That is what `readyz` is for — it
   * checks Postgres and the cache, and a failing readiness probe removes one pod
   * from its Service instead of restarting all of them.
   */
  @Get('livez')
  @Public()
  @SkipRateLimit()
  @ApiOperation({ summary: 'Kubernetes liveness probe — process only, no dependencies' })
  @ApiResponse({
    status: 200,
    schema: { properties: { status: { type: 'string', example: 'ok' } } },
  })
  livez() {
    return { status: 'ok' };
  }

  /** Liveness probe — is the process alive? */
  @Get('healthz')
  @Public()
  @SkipRateLimit()
  @ApiOperation({ summary: 'Liveness probe — returns ok if process is alive' })
  @ApiResponse({
    status: 200,
    schema: { properties: { status: { type: 'string', example: 'ok' } } },
  })
  healthz() {
    return { status: 'ok' };
  }

  /** Readiness probe — can we serve traffic? (DB + cache reachable) */
  @Get('readyz')
  @Public()
  @SkipRateLimit()
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness probe — checks DB and cache connectivity' })
  @ApiResponse({
    status: 200,
    schema: {
      properties: { status: { type: 'string', example: 'ok' }, details: { type: 'object' } },
    },
  })
  async readyz() {
    return this.health.check([
      async () => {
        try {
          await this.db.execute(sql`SELECT 1`);
          return { postgres: { status: 'up' } };
        } catch (e) {
          return { postgres: { status: 'down', error: String(e) } };
        }
      },
      async () => {
        try {
          await this.cache.instance.ping();
          return { valkey: { status: 'up' } };
        } catch (e) {
          return { valkey: { status: 'down', error: String(e) } };
        }
      },
    ]);
  }
}
