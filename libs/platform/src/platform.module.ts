import { Global, Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { AppConfigService } from './config/app-config.service';
import { DatabaseModule } from './database/database.module';
import { CacheModule } from '@quynhonsemiconductor/platform-cache';
import { RequestContextService } from './context/request-context';
import { SessionAuthGuard } from './auth/session-auth.guard';
// Metric instruments come from the shared package so every product emits the same
// names with the same bounded labels.
import {
  DbPoolMetrics,
  HttpMetrics,
  JobMetrics,
  QueueMetrics,
  SecurityMetrics,
  AuthMetrics,
} from '@quynhonsemiconductor/observability';
import { OutboxService } from './outbox/outbox.service';
import { AuditProducer } from './audit/audit-producer.service';
import { EmailService } from './email/email.service';
import { EmailSchedulerService } from './email/email-scheduler.service';
import { EmailDeliveryService } from './email/email-delivery.service';
import { EMAIL_PROVIDER } from './email/email.provider';
import { SesEmailProvider } from './email/providers/ses.provider';
import { DevEmailProvider } from './email/providers/dev.provider';
import { ResendEmailProvider } from './email/providers/resend.provider';
import { GraphEmailProvider } from './email/providers/graph.provider';
import { SmtpEmailProvider } from './email/providers/smtp.provider';
import { NotificationSchedulerService } from './notifications/notification-scheduler.service';
import { NotificationPubSubService } from './notifications/notification-pubsub.service';
import { ExclusiveJob } from '@quynhonsemiconductor/platform-runtime';
import { PublicConfigController } from './observability/public-config.controller';
import { IdempotencyInterceptor } from './http/idempotency.interceptor';
import { HttpLoggingInterceptor } from './http/http-logging.interceptor';
import { ResilienceModule } from './resilience/resilience.module';
import { StorageService } from './storage/storage.service';

@Global()
@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    // Shared Valkey/Redis cache primitive (@quynhonsemiconductor/platform-cache). Rova runs
    // in `required` mode: a REDIS_URL must be configured for the process to boot.
    CacheModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        url: config.get('REDIS_URL'),
        keyPrefix: config.get('REDIS_KEY_PREFIX'),
        mode: 'required' as const,
      }),
    }),

    ResilienceModule,
  ],
  controllers: [PublicConfigController],
  providers: [
    ExclusiveJob,
    RequestContextService,
    HttpMetrics,
    JobMetrics,
    QueueMetrics,
    DbPoolMetrics,
    SecurityMetrics,
    // `auth_login_total{method,outcome}`: the sign-in counter the `auth-login-failure-rate` alert and the dashboard read. Fed by
    // the identity module's security-event sink (a sign-in no longer passes through a controller of ours).
    AuthMetrics,
    // The route-level half of authentication (`@Auth()`): identity's global SessionGuard authenticates, this turns the
    // session (or an API token) into `request.user`.
    SessionAuthGuard,
    // NOT here: the global RateLimitGuard. It must run AFTER identity's SessionGuard, and a guard declared in a module
    // that is imported earlier runs first, so it lives in `RateLimitModule`, imported after the identity module.
    OutboxService,
    AuditProducer,
    // Email provider — selected via EMAIL_PROVIDER env var ('graph' | 'smtp' | 'ses' | 'resend' | 'dev').
    // 'smtp' is development only (Mailpit); env.schema and platform-mail both refuse it when NODE_ENV=production.
    // All providers share the same IEmailProvider interface; swap without touching business logic.
    // SES: needs MAIL_FROM_EMAIL + IAM ses:SendEmail role (cheapest at scale).
    // Resend: needs RESEND_API_KEY + verified domain (best DX, auto-DKIM, recommended for Phase 0).
    // dev: logs to stdout, no real sending (default).
    {
      provide: EMAIL_PROVIDER,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => {
        const provider = config.get('EMAIL_PROVIDER');
        if (provider === 'graph') {
          // Built lazily and only ever USED by the worker (the API writes outbox rows and never sends); the worker's email relay calls
          // `assertReady()` at start, so a missing variable stops the deploy rather than dead-lettering the first invitation.
          return new GraphEmailProvider({
            sender: config.get('MAIL_GRAPH_SENDER') ?? '',
            tenantId: config.get('ENTRA_TENANT_ID'),
            clientId: config.get('MAIL_GRAPH_CLIENT_ID'),
            certificate: config.get('MAIL_GRAPH_CERTIFICATE'),
            federatedTokenFile: config.get('MAIL_GRAPH_FEDERATED_TOKEN_FILE'),
            nodeEnv: config.get('NODE_ENV'),
          });
        }
        if (provider === 'smtp') {
          // Built lazily, like graph: the worker's email relay calls `assertReady()` at start, so a missing variable stops the process.
          return new SmtpEmailProvider({
            host: config.get('MAIL_SMTP_HOST') ?? '',
            port: config.get('MAIL_SMTP_PORT') ?? 1025,
            from: config.get('MAIL_FROM_EMAIL') ?? '',
            nodeEnv: config.get('NODE_ENV'),
          });
        }
        if (provider === 'ses') return new SesEmailProvider(config);
        if (provider === 'resend') return new ResendEmailProvider(config);
        return new DevEmailProvider(config);
      },
    },
    EmailService,
    EmailSchedulerService,
    EmailDeliveryService,
    NotificationSchedulerService,
    NotificationPubSubService,
    IdempotencyInterceptor,
    HttpLoggingInterceptor,
    StorageService,
  ],
  exports: [
    AppConfigModule,
    DatabaseModule,
    CacheModule,
    ExclusiveJob,
    RequestContextService,
    HttpMetrics,
    JobMetrics,
    QueueMetrics,
    DbPoolMetrics,
    SecurityMetrics,
    AuthMetrics,
    SessionAuthGuard,
    OutboxService,
    AuditProducer,
    EmailService,
    EmailSchedulerService,
    EmailDeliveryService,
    NotificationSchedulerService,
    NotificationPubSubService,
    IdempotencyInterceptor,
    HttpLoggingInterceptor,
    ResilienceModule,
    StorageService,
  ],
})
export class PlatformModule {}
