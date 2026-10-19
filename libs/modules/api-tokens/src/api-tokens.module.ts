import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessModule } from '@modules/access';

import { ApiTokensService } from './application/api-tokens.service';
import { ApiTokenDrizzleRepository } from './infrastructure/persistence/api-token.drizzle-repository';
import { ApiTokensAdminController } from './interface/http/api-tokens-admin.controller';
import { ApiTokensController } from './interface/http/api-tokens.controller';
import { ApiTokenGuard } from './interface/http/api-token.guard';
import { RejectApiTokenAuthGuard } from './interface/http/reject-api-token-auth.guard';

/**
 * Machine credentials.
 *
 * `ApiTokenGuard` is a GLOBAL guard (`APP_GUARD`) and must be registered BEFORE identity's global `SessionGuard`, which
 * means this module must be imported before the identity module in `AppModule` (global guards run in module
 * registration order). It authenticates `Authorization: Bearer rly_...` and tells `SessionGuard` to stand aside; see the
 * guard for what that buys and why the order is load-bearing. The worker does not import this module's guard path.
 *
 * `ApiTokensService` is exported for offboarding: deactivating a user must revoke their tokens the same way it revokes
 * their sessions, or their automation keeps working for up to a year.
 *
 * `@Global` so `WorkspaceService` can inject the service without importing this module.
 */
@Global()
@Module({
  imports: [AccessModule],
  controllers: [ApiTokensController, ApiTokensAdminController],
  providers: [
    ApiTokensService,
    ApiTokenDrizzleRepository,
    RejectApiTokenAuthGuard,
    { provide: APP_GUARD, useClass: ApiTokenGuard },
  ],
  exports: [ApiTokensService],
})
export class ApiTokensModule {}
