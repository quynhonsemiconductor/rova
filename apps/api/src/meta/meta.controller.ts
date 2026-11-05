import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppConfigService } from '@platform';
import { SharedRead } from '@modules/access';
import { MetaResponseDto } from './meta.dto';

/**
 * The version this API process is running, for the SPA's user menu.
 *
 * Cheap and session-only: no database read, no permission resolution beyond the session guard, and
 * the DEFAULT rate-limit tier (no stricter tier — a page that reloads it must not be throttled).
 *
 * The values come from what the CHART injected (`APP_VERSION`, `APP_COMMIT`) plus the deployment
 * environment (`DEPLOYMENT_ENV`), never from a build-time constant: the image is built once and
 * promoted by digest, so a compiled version string could only be the wrong one. `SERVICE_VERSION`
 * is the fallback for a chart older than the one that injects `APP_VERSION`; it is already derived
 * from the image tag through `OTEL_RESOURCE_ATTRIBUTES`, so it is the same fact.
 *
 * `NODE_ENV` is not a substitute for `DEPLOYMENT_ENV` — it is `production` in develop too,
 * deliberately.
 */
@ApiTags('meta')
@Controller('meta')
export class MetaController {
  constructor(private readonly config: AppConfigService) {}

  @Get()
  @SharedRead(
    'the running version and deployment environment: no row, no owner, every signed-in caller',
  )
  @ApiOperation({ summary: 'Return the API version, commit and deployment environment' })
  @ApiOkResponse({ type: MetaResponseDto })
  getMeta(): MetaResponseDto {
    return {
      version:
        this.config.get('APP_VERSION')?.trim() ||
        this.config.get('SERVICE_VERSION')?.trim() ||
        'dev',
      commit: this.config.get('APP_COMMIT')?.trim() || null,
      env: this.config.get('DEPLOYMENT_ENV')?.trim() || 'development',
    };
  }
}
