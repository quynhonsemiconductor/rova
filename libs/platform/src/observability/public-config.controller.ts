import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators';
import { SkipRateLimit } from '../rate-limit/rate-limit.decorator';
import { AppConfigService } from '../config/app-config.service';

/**
 * Public runtime config the frontend needs before login.
 *
 * THE PROBES ARE NOT HERE ANY MORE. `/livez`, `/readyz` and the legacy `/v1/healthz` and `/v1/readyz` are served
 * by `enableHealth()` from `@quynhonsemiconductor/platform-runtime` (see `apps/api/src/bootstrap/app.bootstrap.ts`),
 * as raw Fastify routes. This controller used to carry them, and a controller is the wrong place for a contract
 * with the kubelet and the load balancer: it inherits the global prefix (`/v1/livez` is a rejected manifest), the
 * global guards and the rate limiter, and every path it declares lands in the OpenAPI document and the committed
 * web client. What stays is the one route that IS an API: the config the SPA reads before sign-in.
 */
@ApiTags('config')
@Controller()
export class PublicConfigController {
  constructor(private readonly config: AppConfigService) {}

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
}
