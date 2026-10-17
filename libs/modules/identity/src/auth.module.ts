import { Global, Module } from '@nestjs/common';
import { IdentityModule } from '@quynhonsemiconductor/identity/nest';
import { PinoLogger } from 'nestjs-pino';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { AppConfigService, DRIZZLE, WORKSPACE_CONTEXT_REVOKER, type DrizzleDB } from '@platform';
import { AccessModule } from '@modules/access';
import { AuditModule } from '@modules/audit';
import { AttachmentsModule } from '@modules/attachments';
import { WorkspaceModule } from '@modules/workspace';
import { AuthController } from './interface/http/auth.controller';
import { createRovaIdentity } from './infrastructure/auth/create-rova-identity';
import { IdentityContextRevoker } from './infrastructure/auth/identity-context-revoker';
import { ProfileSync } from './infrastructure/auth/profile-sync';
import { SecurityEventAuditSink } from './infrastructure/auth/security-events.audit';
import { StaffSignInHandler } from './infrastructure/auth/staff-sign-in.handler';
import { UserDirectory } from './infrastructure/auth/user-directory';
import { WorkspaceContext } from './infrastructure/auth/workspace-context';

/** What the identity factory needs from the application, in a module `forRootAsync` can import. */
@Module({
  imports: [AccessModule, AuditModule, WorkspaceModule],
  providers: [UserDirectory, WorkspaceContext, StaffSignInHandler, SecurityEventAuditSink],
  exports: [UserDirectory, WorkspaceContext, StaffSignInHandler, SecurityEventAuditSink],
})
class IdentityBindingsModule {}

/**
 * Authentication on identity 8 (Better Auth, the `staff` preset, Microsoft Entra). API ONLY: the worker has no HTTP
 * server and never imports this module.
 *
 * `IdentityModule.forRootAsync` builds the instance once (`createRovaIdentity`), mounts its handler on `/api/auth/*` as an
 * encapsulated Fastify plugin, and registers identity's `SessionGuard` globally (`APP_GUARD`): every route needs a session
 * unless it is `@Public()` or carries an API token (`ApiTokenGuard`, registered BEFORE this module). rova's
 * `SessionAuthGuard` (route-level, mounted by `@Auth()` / `@AuthPolicy()`) then turns that session into the request
 * principal.
 *
 * Global so `WORKSPACE_CONTEXT_REVOKER`, which the workspace module uses, resolves wherever it is compiled; the worker
 * simply has no provider for it.
 */
@Global()
@Module({
  imports: [
    IdentityBindingsModule,
    AttachmentsModule,
    AccessModule,
    WorkspaceModule,
    IdentityModule.forRootAsync({
      imports: [IdentityBindingsModule],
      inject: [
        AppConfigService,
        DRIZZLE,
        CacheService,
        StaffSignInHandler,
        WorkspaceContext,
        SecurityEventAuditSink,
        PinoLogger,
      ],
      useFactory: (
        config: AppConfigService,
        db: DrizzleDB,
        cache: CacheService,
        staffSignIn: StaffSignInHandler,
        workspaceContext: WorkspaceContext,
        auditSink: SecurityEventAuditSink,
        logger: PinoLogger,
      ) =>
        createRovaIdentity({ config, db, cache, staffSignIn, workspaceContext, auditSink, logger }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    ProfileSync,
    IdentityContextRevoker,
    { provide: WORKSPACE_CONTEXT_REVOKER, useExisting: IdentityContextRevoker },
  ],
  exports: [WORKSPACE_CONTEXT_REVOKER, UserDirectory],
})
export class AuthModule {}
