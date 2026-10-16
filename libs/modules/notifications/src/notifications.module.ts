import { Module } from '@nestjs/common';
import { AccessModule } from '@modules/access';
import { NotificationsService } from './application/notifications.service';
import { NotificationPreferencesService } from './application/notification-preferences.service';
import { NotificationsController } from './interface/http/notifications.controller';
import { NotificationSseController } from './interface/http/notification-sse.controller';
import { SseConnections } from './interface/http/sse-connections';
import { NotificationPreferencesController } from './interface/http/notification-preferences.controller';
import { NotificationDrizzleRepository } from './infrastructure/persistence/notification.drizzle-repository';
import { NotificationPreferenceDrizzleRepository } from './infrastructure/persistence/notification-preference.drizzle-repository';
import { NOTIFICATION_REPOSITORY } from './domain/ports/notification.repository';
import { NOTIFICATION_PREFERENCE_REPOSITORY } from './domain/ports/notification-preference.repository';

@Module({
  // AccessModule: NotificationsService applies the reader's CURRENT per-Project access to the feed
  // (SRS §7 :199-200) through `AccessService.listReadableProjectIds`. The worker imports this module
  // too, and already pulls AccessModule in through AuditModule / ReportingModule / ScmModule.
  imports: [AccessModule],
  controllers: [
    NotificationsController,
    NotificationSseController,
    NotificationPreferencesController,
  ],
  providers: [
    NotificationsService,
    NotificationPreferencesService,
    SseConnections,
    { provide: NOTIFICATION_REPOSITORY, useClass: NotificationDrizzleRepository },
    {
      provide: NOTIFICATION_PREFERENCE_REPOSITORY,
      useClass: NotificationPreferenceDrizzleRepository,
    },
  ],
  exports: [NotificationsService, NotificationPreferencesService, SseConnections],
})
export class NotificationsModule {}
