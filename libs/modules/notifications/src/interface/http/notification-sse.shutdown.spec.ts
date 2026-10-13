/**
 * A signed-in tab must not hold a deploy to its deadline.
 *
 * The REAL `NotificationSseController` (guard and services faked) behind a REAL Fastify server on a real socket, with a
 * real client holding the stream open, and the REAL `enableGracefulShutdown` draining it. Before the `preClose` hook,
 * `fastify.close()` waited for the hijacked stream until `SHUTDOWN_TIMEOUT_MS`, the shutdown logged "did not finish"
 * and exited 1 without closing the pool or Valkey (reproduced with fastify 5.12.5).
 *
 * Variant filename on purpose: `test/coverage-include.spec.ts` demands a coverage-include entry for a spec named after
 * an existing subject file.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { JwtAuthGuard } from '@platform';
import { NotificationPubSubService } from '@platform/notifications';
import { enableGracefulShutdown } from '@quynhonsemiconductor/platform-runtime';
import { NotificationSseController } from './notification-sse.controller';
import { NotificationsService } from '../../application/notifications.service';
import { SseConnections, registerSseShutdown } from './sse-connections';

const authenticated = {
  canActivate(context: { switchToHttp(): { getRequest(): { user?: unknown } } }) {
    context.switchToHttp().getRequest().user = { sub: 'user-1' };
    return true;
  },
};

interface Harness {
  app: NestFastifyApplication;
  port: number;
  connections: SseConnections;
  unsubscribe: ReturnType<typeof vi.fn>;
}

let harness: Harness | undefined;

async function boot(opts: { withHook: boolean }): Promise<Harness> {
  const unsubscribe = vi.fn().mockResolvedValue(undefined);
  const moduleRef = await Test.createTestingModule({
    controllers: [NotificationSseController],
    providers: [
      SseConnections,
      {
        provide: NotificationPubSubService,
        useValue: { subscribeUser: vi.fn().mockResolvedValue(unsubscribe) },
      },
      {
        provide: NotificationsService,
        useValue: {
          getUnreadCount: vi.fn().mockResolvedValue(3),
          listMissed: vi.fn().mockResolvedValue([]),
          isVisible: vi.fn().mockResolvedValue(true),
        },
      },
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue(authenticated)
    .compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });
  const connections = app.get(SseConnections);
  if (opts.withHook) registerSseShutdown(app.getHttpAdapter().getInstance(), connections);
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as AddressInfo).port;
  return { app, port, connections, unsubscribe };
}

/** Open the stream and resolve once the `connected` event has arrived; collect everything received. */
function openStream(
  port: number,
): Promise<{ received: () => string; ended: Promise<void>; req: http.ClientRequest }> {
  return new Promise((resolve, reject) => {
    let body = '';
    let signalEnded!: () => void;
    const ended = new Promise<void>((r) => (signalEnded = r));
    const req = http.get(
      { host: '127.0.0.1', port, path: '/notifications/stream', agent: false },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          if (body.includes('event: connected')) resolve({ received: () => body, ended, req });
        });
        res.on('end', signalEnded);
        res.on('close', signalEnded);
      },
    );
    req.on('error', reject);
  });
}

afterEach(async () => {
  await harness?.app.close().catch(() => undefined);
  harness = undefined;
});

describe('an open notification stream and a graceful shutdown', () => {
  it('is told to reconnect and the drain finishes at once, with exit code 0', async () => {
    harness = await boot({ withHook: true });
    const stream = await openStream(harness.port);
    expect(harness.connections.size).toBe(1);

    const exit = vi.fn();
    const shutdown = enableGracefulShutdown(harness.app, {
      signals: [],
      exit,
      env: { SHUTDOWN_ENDPOINT_DELAY_MS: '0', SHUTDOWN_TIMEOUT_MS: '6000' },
    });
    const startedAt = Date.now();
    await shutdown.shutdown('test');

    // The drain did not wait for the deadline (it used to take all 6 s here, then exit 1).
    expect(Date.now() - startedAt).toBeLessThan(2500);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    // The browser was told what to do: reconnect, after the documented 3 s, to another replica.
    await stream.ended;
    expect(stream.received()).toContain('event: reconnect');
    expect(stream.received()).toContain('"retryMs":3000');
    expect(harness.connections.size).toBe(0);
    harness = undefined; // enableGracefulShutdown closed the app
  });

  it('forgets a stream whose client went away, so a later shutdown has nothing to write to', async () => {
    harness = await boot({ withHook: true });
    const stream = await openStream(harness.port);
    expect(harness.connections.size).toBe(1);

    stream.req.destroy();
    await vi.waitFor(() => expect(harness!.connections.size).toBe(0));
    expect(harness.unsubscribe).toHaveBeenCalled(); // the Valkey subscription is released too
  });

  it('closeAll survives a stream that throws and still closes the others', () => {
    const connections = new SseConnections();
    const bad = {
      writable: true,
      write: () => {
        throw new Error('socket already destroyed');
      },
      end: vi.fn(),
    };
    const good = { writable: true, write: vi.fn(), end: vi.fn() };
    connections.add(bad);
    connections.add(good);

    expect(connections.closeAll()).toBe(1);
    expect(good.write).toHaveBeenCalledWith(expect.stringContaining('event: reconnect'));
    expect(good.end).toHaveBeenCalledOnce();
    expect(connections.size).toBe(0);
  });
});
