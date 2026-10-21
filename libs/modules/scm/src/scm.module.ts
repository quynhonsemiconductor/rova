import { Module } from '@nestjs/common';
import { SECRET_RESOLVER, SecretsManagerSecretResolver } from '@platform';
import { AccessModule } from '@modules/access';
import { ScmService } from './application/scm.service';
import { ScmLinkerService } from './application/scm-linker.service';
import { ScmBackfillService } from './application/scm-backfill.service';
import { ScmInstallationService } from './application/scm-installation.service';
import { ScmController } from './interface/http/scm.controller';
import { ScmWebhookController } from './interface/http/scm-webhook.controller';
import { ScmDrizzleRepository } from './infrastructure/persistence/scm.drizzle-repository';
import { GithubAppAuthService } from './infrastructure/github/github-app-auth.service';
import { SCM_STORE } from './domain/ports/scm.store';

@Module({
  imports: [AccessModule],
  controllers: [ScmController, ScmWebhookController],
  providers: [
    ScmService,
    ScmLinkerService,
    ScmBackfillService,
    ScmInstallationService,
    GithubAppAuthService,
    { provide: SCM_STORE, useClass: ScmDrizzleRepository },
    // GithubAppAuthService resolves the App private key at runtime via
    // SECRET_RESOLVER. The API gets it from the @Global IdentityModule, but the
    // worker (backfill) does not import IdentityModule — so provide it module-
    // locally here to make ScmModule self-sufficient in both apps. Without it the
    // worker throws "SECRET_RESOLVER unavailable" and every backfill job stalls.
    { provide: SECRET_RESOLVER, useClass: SecretsManagerSecretResolver },
  ],
  // ScmLinkerService + SCM_STORE are exported so the worker relay can drive linking;
  // ScmBackfillService + ScmInstallationService so the relays can run them.
  exports: [ScmService, ScmLinkerService, ScmBackfillService, ScmInstallationService, SCM_STORE],
})
export class ScmModule {}
