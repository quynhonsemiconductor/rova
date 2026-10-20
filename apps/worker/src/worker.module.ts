import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PlatformModule } from '@platform';
import { AuditModule } from '@modules/audit';
import { NotificationsModule } from '@modules/notifications';
import { ReportingModule } from '@modules/reporting';
import { ScmModule } from '@modules/scm';
import { EntraGuestInviteClient } from '@modules/workspace';
import { EntraGuestInviteRelayService } from './identity/entra-guest-invite-relay.service';
import { AuditProjectionRelay } from './audit/audit-projection.relay';
import { SnapshotCronService } from './cron/snapshot.cron';
import { CleanupCronService } from './cron/cleanup.cron';
import { EmailRelayService } from './email/email-relay.service';
import { WorkerHeartbeatService } from './heartbeat/worker-heartbeat.service';
import { ApiTokensModule } from '@modules/api-tokens';
import { NotificationRelayService } from './notifications/notification-relay.service';
import { ScmWebhookRelayService } from './scm/scm-webhook-relay.service';
import { ScmBackfillRelayService } from './scm/scm-backfill-relay.service';

/**
 * Worker process module.
 * Imports only the bounded contexts that have relays or cron jobs.
 * Shares all platform infrastructure (DB, cache, outbox relay) with the API process.
 */
@Module({
  imports: [
    // Logging is NOT wired here: `createWorkerApp` (main.ts) registers the shared pino logger around this module.
    ScheduleModule.forRoot(),
    PlatformModule,

    // `WorkspaceService` (reached transitively through the module graph) injects
    // `ApiTokensService` to revoke tokens on member removal, and the module is @Global — but a
    // @Global module still has to be INSTANTIATED somewhere in the process. The API's root module
    // imports it; the worker resolved it only by module-init order, and inserting
    // EmailDeliveryService into the same constructor flipped that order and crash-looped the
    // worker at boot ("ApiTokensService at index [12]"). Import it here so the worker says what it
    // needs instead of relying on the graph's incidental shape.
    ApiTokensModule,

    // Contexts with relays / cron jobs
    AuditModule,
    NotificationsModule,
    ReportingModule,
    ScmModule,
  ],
  providers: [
    // Transactional outbox → audit_logs projection
    AuditProjectionRelay,
    // Email outbox relay → IEmailProvider
    EmailRelayService,
    WorkerHeartbeatService,
    // Notification outbox relay → in_app_notifications
    NotificationRelayService,
    // SCM webhook inbox relay → connections/changesets
    ScmWebhookRelayService,
    // SCM backfill jobs relay → GitHub App REST → connections/changesets
    ScmBackfillRelayService,
    // Entra B2B guest provisioning relay → Microsoft Graph → workspace_invitations
    //
    // The client is registered as a PLAIN PROVIDER rather than by importing WorkspaceModule: its
    // only dependencies (AppConfigService, ResilienceService) are global from PlatformModule, and
    // importing the module would instantiate three HTTP controllers in a process with no HTTP
    // adapter.
    EntraGuestInviteClient,
    EntraGuestInviteRelayService,
    // Scheduled cron jobs
    SnapshotCronService,
    CleanupCronService,
  ],
})
export class WorkerModule {}
