import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { RequestContextService } from '@platform/context/request-context';
import { PlatformModule } from '@platform';
import { IdentityModule } from '@modules/identity';
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
import { GlobalExceptionFilter, REQUEST_CONTEXT } from '@quynhonsemiconductor/platform-http';
import { HttpLoggingInterceptor } from '@platform/http/http-logging.interceptor';
import { ZodValidationPipe } from 'nestjs-zod';
import { SanitizationPipe } from '@platform/pipes/sanitization.pipe';

@Module({
  imports: [
    // Logging is NOT wired here: `createHttpApp` (main.ts) registers the shared pino logger around this module.

    // Platform (config, db, auth, cache, outbox, observability)
    PlatformModule,

    // Bounded contexts
    IdentityModule,
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
    ApiTokensModule,
    TestCasesModule,
  ],
  providers: [
    // Bind the shared filter's request-context port to rally's ALS-backed service.
    { provide: REQUEST_CONTEXT, useExisting: RequestContextService },

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
