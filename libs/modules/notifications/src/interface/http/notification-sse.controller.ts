/**
 * NotificationSseController — Server-Sent Events endpoint for real-time
 * in-app notification delivery.
 *
 * Architecture:
 *   Worker relay writes to in_app_notifications
 *     → publishes to Valkey  notifications:user:{userId}
 *       → NotificationPubSubService delivers message to all subscribed handlers
 *         → this controller writes SSE event to the browser
 *
 * Authorization: every path out of this controller — the `connected` unread count, the
 * `Last-Event-ID` replay and the live push — goes through NotificationsService, which applies the
 * reader's CURRENT per-Project access (SRS §7 :199-200). The stream and the Notification Center
 * therefore cannot disagree about which notifications exist.
 *
 * SSE event contract (for the frontend):
 *
 *   Connection established:
 *     event: connected
 *     data: { "unreadCount": <number> }
 *
 *   Replay on reconnect (when Last-Event-ID header is present):
 *     event: notification
 *     id: <notificationId>
 *     data: { "notificationId": "...", "type": "...", "title": "...",
 *             "body": "...", "resourceType": "...", "resourceId": "..." }
 *     (one event per missed notification, oldest first)
 *
 *   New notification dispatched:
 *     event: notification
 *     id: <notificationId>
 *     data: { "notificationId": "...", "type": "...", "title": "...",
 *              "body": "...", "resourceType": "...", "resourceId": "..." }
 *
 *   Heartbeat (every 25s — prevents proxy/LB from closing idle connections):
 *     : heartbeat
 *
 *   Reconnect hint (on server restart / graceful shutdown, or when a live push's access check
 *   fails and the event must be replayed rather than dropped — see the push queue below):
 *     event: reconnect
 *     data: { "retryMs": 3000 }
 *
 * Missed-event replay:
 *   The browser's EventSource API automatically sends the `Last-Event-ID`
 *   request header on reconnect using the last `id:` value it received.
 *   The controller replays all notifications newer than that ID (up to 30)
 *   before entering the live-push phase.  Notifications older than the replay
 *   window are reconciled via the unread-count badge shown on connect.
 *
 * Fastify notes:
 *   reply.hijack() transfers full response ownership to this handler so
 *   Fastify does not interfere with the long-lived streaming response.
 *   reply.raw is the underlying Node.js http.ServerResponse.
 */
import { Controller, Get, Logger, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Auth, ApiCommonErrors } from '@platform';
import type { JwtPayload } from '@platform';
import { CurrentUser } from '@modules/identity';
import { NotificationPubSubService } from '@platform/notifications';
import { NotificationsService } from '../../application/notifications.service';
import { SelfScoped } from '@modules/access';
import { SseConnections } from './sse-connections';

@ApiTags('notifications')
@Controller('notifications')
@Auth()
export class NotificationSseController {
  private readonly logger = new Logger(NotificationSseController.name);

  constructor(
    private readonly pubSub: NotificationPubSubService,
    private readonly notificationsService: NotificationsService,
    private readonly connections: SseConnections,
  ) {}

  @Get('stream')
  @SelfScoped("subscribes to the caller's own notification channel")
  @ApiOperation({
    summary: 'SSE stream — real-time notification events',
    description:
      'Opens a Server-Sent Events stream.  The client receives a `connected` event ' +
      'with the current unread count, then a `notification` event (with `id:` set) ' +
      'for every new in-app notification.  On reconnect the browser sends ' +
      '`Last-Event-ID` automatically; the server replays missed notifications ' +
      'before entering live-push mode.',
  })
  @ApiResponse({ status: 200, description: 'SSE stream (text/event-stream)' })
  @ApiCommonErrors(401)
  async stream(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // Transfer full response ownership to this handler so Fastify does not
    // attempt to send its own response or close the connection after the
    // async handler returns.
    reply.hijack();

    const raw = reply.raw;
    raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    raw.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    raw.setHeader('Connection', 'keep-alive');
    // Prevents Nginx, Caddy, and AWS ALB from buffering the stream.
    raw.setHeader('X-Accel-Buffering', 'no');
    raw.flushHeaders();

    // Tracked from the first moment, so a shutdown that begins while this stream is still being set up ends it too.
    // Forgotten when the response closes. See sse-connections.ts for why a shutdown must end open streams.
    const forget = this.connections.add(raw);
    raw.on('close', forget);

    // Send the current unread count immediately on connect so the client does
    // not need a separate GET /notifications/unread-count round-trip.
    const unreadCount = await this.notificationsService.getUnreadCount(user);
    // Ended by a shutdown, or gone, while the count was being read: nothing left to stream to.
    if (!raw.writable) return;
    writeEvent(raw, 'connected', { unreadCount });

    // Replay missed events when the client reconnects with Last-Event-ID.
    // The EventSource API sets this header automatically using the last `id:`
    // value it received.  We replay up to 30 notifications older than the
    // replay window; beyond that the unread-count badge is the reconciliation.
    const lastEventId = req.headers['last-event-id'] as string | undefined;
    if (lastEventId) {
      const missed = await this.notificationsService.listMissed(user, lastEventId);
      for (const n of missed) {
        if (!raw.writable) break;
        writeNotificationEvent(raw, {
          notificationId: n.id,
          recipientId: n.recipientId,
          type: n.type,
          title: n.title,
          body: n.body ?? undefined,
          resourceType: n.resourceType ?? undefined,
          resourceId: n.resourceId ?? undefined,
        });
      }
    }

    // A shutdown can end the stream while the replay was being read. Subscribing now would leak the subscription and
    // the heartbeat: the `close` listener that frees them is registered at the end of this method.
    if (!raw.writable) return;

    // Subscribe to Valkey pub/sub for this user's notifications.
    // Multiple browser tabs / devices each get their own subscription.
    //
    // Every pushed event is re-checked against the recipient's CURRENT Project access
    // (`isVisible`, SRS §7 :199-200) so the stream can never carry a title the Notification Center
    // and the unread badge both refuse to show. The check is asynchronous and the `id:` field is the
    // client's `Last-Event-ID` cursor, so the checks are SERIALISED through a promise chain: running
    // them concurrently could emit ids out of order and make a reconnect replay from the wrong
    // point. A denied answer still drops the event silently — that is the rule, not a failure.
    //
    // A FAILED check ENDS THE STREAM. It used to be swallowed (`.catch(() => undefined)`), and that
    // loses the notification permanently: `id:` — the client's cursor — only advances on a DELIVERED
    // event, and the replay is strictly `id > afterId`, so an event dropped here is newer than the
    // cursor the client will send and is never replayed on this stream. One transient Postgres or
    // Valkey blip therefore ate a notification with no trace. Ending the response instead makes the
    // browser reconnect from its last DELIVERED id (`useNotificationSse` keeps `lastEventId` across
    // reconnects) and `listMissed` replays the gap through the same access predicate, so nothing is
    // emitted on an unknown answer either way — the event is deferred, not disclosed.
    //
    // Retrying in place was NOT chosen: the fault may be an outage outliving any retry budget, the
    // chain is serialised so a retry stalls every later event behind it, and reconnect-with-replay is
    // recovery the client already implements. No new metric name either — this repo asserts that
    // every declared name is actually recorded — so the signal is a WARN log, which is the live
    // signal here anyway (`OTEL_ENABLED` is false everywhere).
    let pushQueue: Promise<void> = Promise.resolve();
    const unsubscribe = await this.pubSub.subscribeUser(user.sub, (payload) => {
      pushQueue = pushQueue
        .then(async () => {
          if (!raw.writable) return;
          if (!(await this.notificationsService.isVisible(user, payload.notificationId))) return;
          if (raw.writable) writeNotificationEvent(raw, payload);
        })
        // The catch itself stays: an unhandled rejection left on this chain would be a process-level
        // fault, and every event queued behind it must still be able to run.
        .catch((err: unknown) => {
          // `recipientId` is logged by hand here, against the usual rule, because this callback runs
          // in the Valkey subscriber and not in the request — the pino mixin's ALS context is not
          // available, so without it the line names no user.
          this.logger.warn(
            { err, notificationId: payload.notificationId, recipientId: payload.recipientId },
            'Notification visibility check failed; ending SSE stream so the client reconnects and replays from its last delivered id',
          );
          if (raw.writable) {
            // The documented reconnect hint (3s) rather than waiting out the client's 5s
            // stream-ended path; it carries no `id:`, so the cursor stays where it was.
            writeEvent(raw, 'reconnect', { retryMs: 3000 });
            raw.end();
          }
        });
    });

    // Ended while subscribing (same race): release what was just taken, because no `close` event will come.
    if (!raw.writable) {
      await unsubscribe().catch(() => undefined);
      return;
    }

    // Heartbeat every 25s.
    // - Keeps the TCP connection alive through proxies and load balancers.
    // - The browser's EventSource re-fires the 'open' event if it reconnects.
    // SSE comments ("...") are ignored by EventSource but keep the stream open.
    const heartbeat = setInterval(() => {
      if (!raw.writable) {
        clearInterval(heartbeat);
        return;
      }
      raw.write(': heartbeat\n\n');
    }, 25_000);

    // Graceful cleanup on client disconnect.
    raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe().catch(() => {});
    });
  }
}

interface NotificationPayload {
  notificationId: string;
  recipientId: string;
  type: string;
  title: string;
  body?: string;
  resourceType?: string;
  resourceId?: string;
}

/**
 * Write a `notification` SSE event with an `id:` field so the browser's
 * EventSource tracks the cursor and sends `Last-Event-ID` on reconnect.
 */
function writeNotificationEvent(raw: NodeJS.WritableStream, payload: NotificationPayload): void {
  raw.write(
    `event: notification\nid: ${payload.notificationId}\ndata: ${JSON.stringify(payload)}\n\n`,
  );
}

/** Write a generic typed SSE event (no cursor id — used for `connected`). */
function writeEvent(raw: NodeJS.WritableStream, event: string, data: unknown): void {
  raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
