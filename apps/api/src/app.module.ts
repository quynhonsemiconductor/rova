import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { PlatformModule, RateLimitModule } from '@platform';
import { AuthModule } from '@modules/identity';
import { WorkspaceModule } from '@modules/workspace';
import { AccessModule } from '@modules/access';
import { ProjectsModule } from '@modules/projects';
import { WorkItemsModule } from '@modules/work-items';
import { IterationsModule } from '@modules/iterations';
import { ReleasesModule } from '@modules/releases';
import { WorkflowModule } from '@modules/workflow';
import { CollaborationModule } from '@modules/collaboration';
import { NotificationsModule } from '@modules/notifications';
import { AuditModule } from '@modules/audit';
import { ReportingModule } from '@modules/reporting';
import { TeamStatusModule } from '@modules/team-status';
import { MilestonesModule } from '@modules/milestones';
import { PortfolioModule } from '@modules/portfolio';
import { CapacityModule } from '@modules/capacity';
import { QualityModule } from '@modules/quality';
import { ScmModule } from '@modules/scm';
import { ApiTokensModule } from '@modules/api-tokens';
import { TestCasesModule } from '@modules/test-cases';
import { GlobalExceptionFilter } from '@quynhonsemiconductor/platform-http';
import { HttpLoggingInterceptor } from '@platform/http/http-logging.interceptor';
import { ZodValidationPipe } from 'nestjs-zod';
import { SanitizationPipe } from '@platform/pipes/sanitization.pipe';

@Module({
  imports: [
    // Logging is NOT wired here: `createHttpApp` (main.ts) registers the shared pino logger around this module.

    // Platform (config, db, auth, cache, outbox, observability)
    PlatformModule,

    // GLOBAL GUARD ORDER IS MODULE ORDER, and it is load-bearing. ApiTokenGuard (api tokens) authenticates `Bearer rly_...` and
    // tells identity's SessionGuard to stand aside, so ApiTokensModule comes BEFORE AuthModule (SessionGuard: sessions, the
    // ban check, the principal); RateLimitModule comes AFTER both so the limiter keys by the user they wrote. Pinned by
    // test/e2e/api-tokens.e2e.spec.ts and test/e2e/rate-limit-keying.e2e.spec.ts.
    ApiTokensModule,
    AuthModule,
    RateLimitModule,

    // Bounded contexts
    WorkspaceModule,
    AccessModule,
    ProjectsModule,
    WorkItemsModule,
    IterationsModule,
    ReleasesModule,
    WorkflowModule,
    CollaborationModule,
    NotificationsModule,
    AuditModule,
    ReportingModule,
    TeamStatusModule,
    MilestonesModule,
    PortfolioModule,
    CapacityModule,
    QualityModule,
    ScmModule,
    TestCasesModule,
  ],
  providers: [
    // Global exception filter → stable RFC-9457-style error envelope
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },

    // Global interceptor: structured HTTP access log (replaces pino-http autoLogging)
    { provide: APP_INTERCEPTOR, useClass: HttpLoggingInterceptor },

    // Global pipes — order matters: sanitize XSS BEFORE Zod validates shape
    { provide: APP_PIPE, useClass: SanitizationPipe },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
  ],
})
export class AppModule {}
