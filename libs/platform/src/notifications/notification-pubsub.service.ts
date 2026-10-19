/**
 * NotificationPubSubService — Valkey pub/sub bridge for the notification pipeline.
 *
 * Used in two roles:
 *
 *   API process:
 *     - Publishes  `relay:wake`   after schedule() — wakes the Worker relay immediately.
 *     - Subscribes `user:{id}`    per SSE connection — pushes events to the browser.
 *
 *   Worker process:
 *     - Subscribes `relay:wake`   → calls NotificationRelayService.relay() immediately
 *                                   instead of waiting for the 5s cron tick.
 *     - Publishes  `user:{id}`    after a notification is written to in_app_notifications
 *                                   → SSE controller pushes it to the browser in real time.
 *
 * Why a dedicated subscriber connection?
 *   ioredis subscriber mode (after SUBSCRIBE) cannot run regular Redis commands
 *   on the same connection. CacheService holds the "command" connection used for
 *   cache, rate-limit, and denylist.  This service creates a second, subscriber-only
 *   ioredis connection that is never used for anything else.
 *
 * Channel naming:
 *   `${REDIS_KEY_PREFIX}notifications:relay:wake`
 *   `${REDIS_KEY_PREFIX}notifications:email:relay:wake`
 *   `${REDIS_KEY_PREFIX}notifications:guest-invite:relay:wake`
 *   `${REDIS_KEY_PREFIX}notifications:user:{recipientId}`
 *   The prefix isolates staging / production environments sharing the same Valkey node.
 *   NOTE: ioredis does NOT apply keyPrefix to pub/sub channels automatically — we
 *   apply it manually inside ns().
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../config/app-config.service';
import { valkeyUrlOf } from '../config/env.schema';
import { CacheService } from '@quynhonsemiconductor/platform-cache';

export interface NotificationPubSubPayload {
  notificationId: string;
  recipientId: string;
  type: string;
  title: string;
  body?: string;
  resourceType?: string;
  resourceId?: string;
}

@Injectable()
export class NotificationPubSubService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationPubSubService.name);

  /** Dedicated subscriber-mode connection — cannot be used for regular commands. */
  private subscriber!: Redis;

  /**
   * Per-channel handler sets.  When a channel has zero handlers, we UNSUBSCRIBE
   * so Valkey stops pushing messages for it.
   */
  private readonly handlers = new Map<string, Set<(message: string) => void>>();

  constructor(
    private readonly config: AppConfigService,
    /** CacheService client — used for PUBLISH (still accepts commands in sub mode). */
    private readonly cache: CacheService,
  ) {}

  onModuleInit(): void {
    const url = valkeyUrlOf({
      VALKEY_URL: this.config.get('VALKEY_URL'),
      REDIS_URL: this.config.get('REDIS_URL'),
    });
    this.subscriber = new Redis(url, {
      // No keyPrefix option — pub/sub channels are not key commands; we namespace
      // via ns() so every channel already includes the environment prefix.
      enableReadyCheck: true,
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });

    this.subscriber.on('message', (channel: string, message: string) => {
      this.handlers.get(channel)?.forEach((h) => h(message));
    });

    this.subscriber.on('error', (err: unknown) =>
      this.logger.error({ err }, 'Notification pub/sub subscriber error'),
    );

    this.logger.log('Notification pub/sub subscriber connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscriber.quit();
  }

  // ── Channel helpers ───────────────────────────────────────────────────────

  /** Channel the Worker subscribes to when it should check notification_outbox immediately. */
  relayWakeChannel(): string {
    return this.ns('relay:wake');
  }

  /** Channel the Worker subscribes to when it should check email_outbox immediately. */
  emailRelayWakeChannel(): string {
    return this.ns('email:relay:wake');
  }

  /**
   * Channel the Worker subscribes to when it should check guest_invite_outbox immediately.
   *
   * Third instance of the same pattern rather than a new mechanism, and it earns its place because
   * the INVITATION EMAIL now waits on that relay: the email is scheduled only once Entra
   * provisioning has resolved, so the guest relay's cadence is what the invitee experiences.
   */
  guestInviteRelayWakeChannel(): string {
    return this.ns('guest-invite:relay:wake');
  }

  /** Channel the API subscribes to per-user for pushing real-time SSE events. */
  userChannel(recipientId: string): string {
    return this.ns(`user:${recipientId}`);
  }

  private ns(suffix: string): string {
    const prefix = (this.config.get('REDIS_KEY_PREFIX') as string | undefined) ?? '';
    return `${prefix}notifications:${suffix}`;
  }

  // ── Publisher (uses CacheService command connection) ─────────────────────

  /**
   * Published by NotificationSchedulerService after writing to notification_outbox.
   * Wakes the Worker relay so delivery latency is near-zero instead of ≤5s.
   */
  async wakeRelay(): Promise<void> {
    await this.cache.instance.publish(this.relayWakeChannel(), '');
  }

  /**
   * Published by EmailSchedulerService after writing to email_outbox.
   * Mirrors wakeRelay() for consistent near-zero email delivery latency.
   */
  async wakeEmailRelay(): Promise<void> {
    await this.cache.instance.publish(this.emailRelayWakeChannel(), '');
  }

  /**
   * Published by GuestInviteSchedulerService after writing to guest_invite_outbox.
   *
   * Same shape as wakeEmailRelay(), and needed for the same reason: while
   * `ENTRA_GUEST_INVITE_ENABLED` is on, the invitation email is scheduled by that relay, so its
   * 10s cron would otherwise be latency the INVITEE feels. Best-effort — the cron is the fallback.
   */
  async wakeGuestInviteRelay(): Promise<void> {
    await this.cache.instance.publish(this.guestInviteRelayWakeChannel(), '');
  }

  /**
   * Published by NotificationRelayService after a notification is written to
   * in_app_notifications.  Signals all SSE connections for this user to push
   * the new event to the browser without any client-side polling.
   */
  async notifyUser(payload: NotificationPubSubPayload): Promise<void> {
    await this.cache.instance.publish(
      this.userChannel(payload.recipientId),
      JSON.stringify(payload),
    );
  }

  // ── Subscriber ───────────────────────────────────────────────────────────

  /**
   * Subscribe to a pub/sub channel.
   * Multiple handlers can be registered for the same channel — they share one
   * Valkey SUBSCRIBE.  Returns an async unsubscribe function; call it on cleanup
   * (SSE disconnect, module destroy) to free resources and UNSUBSCRIBE from Valkey.
   */
  async subscribe(
    channel: string,
    handler: (message: string) => void,
  ): Promise<() => Promise<void>> {
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set());
      await this.subscriber.subscribe(channel);
      this.logger.debug({ channel }, 'Subscribed to Valkey channel');
    }
    this.handlers.get(channel)!.add(handler);

    return async () => {
      const set = this.handlers.get(channel);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) {
        this.handlers.delete(channel);
        await this.subscriber.unsubscribe(channel);
        this.logger.debug({ channel }, 'Unsubscribed from Valkey channel');
      }
    };
  }

  /** Subscribe to relay wake signals.  Returns unsubscribe fn. */
  subscribeRelayWake(handler: () => void): Promise<() => Promise<void>> {
    return this.subscribe(this.relayWakeChannel(), handler);
  }

  /** Subscribe to email relay wake signals.  Returns unsubscribe fn. */
  subscribeEmailRelayWake(handler: () => void): Promise<() => Promise<void>> {
    return this.subscribe(this.emailRelayWakeChannel(), handler);
  }

  /** Subscribe to guest-invite relay wake signals.  Returns unsubscribe fn. */
  subscribeGuestInviteRelayWake(handler: () => void): Promise<() => Promise<void>> {
    return this.subscribe(this.guestInviteRelayWakeChannel(), handler);
  }

  /** Subscribe to a specific user's notification events.  Returns unsubscribe fn. */
  subscribeUser(
    recipientId: string,
    handler: (payload: NotificationPubSubPayload) => void,
  ): Promise<() => Promise<void>> {
    return this.subscribe(this.userChannel(recipientId), (message) => {
      try {
        handler(JSON.parse(message) as NotificationPubSubPayload);
      } catch {
        this.logger.warn({ message }, 'Unparseable notification pub/sub message — ignored');
      }
    });
  }
}
