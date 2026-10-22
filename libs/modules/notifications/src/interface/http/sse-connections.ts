/**
 * The open notification streams of this process, so a shutdown can end them.
 *
 * WHY THIS EXISTS. `NotificationSseController` hijacks the reply (`reply.hijack()`): Fastify no longer owns the
 * response, and it never ends. `fastify.close()` (the HTTP drain in `enableGracefulShutdown`) waits for every
 * in-flight request, and a hijacked stream is in flight for as long as the browser tab is open. So one signed-in tab
 * held the drain to `SHUTDOWN_TIMEOUT_MS` (25 s): every deploy logged "Shutdown did not finish", exited 1, and skipped
 * `app.close()` (the pool and Valkey were never closed). Reproduced with fastify 5.12.5.
 *
 * WHAT IT DOES. {@link registerSseShutdown} adds a Fastify `preClose` hook (it runs when `close()` is called, before
 * Fastify waits for anything). The hook sends each open stream the documented `reconnect` event and ends it, so the
 * browser's EventSource reconnects (to another replica: this one has stopped being ready) and replays from its last
 * delivered id (`Last-Event-ID`), and the drain finishes in milliseconds.
 */
import { Injectable } from '@nestjs/common';
import type { FastifyInstance } from 'fastify';

/** The part of a Node response a stream needs closed. */
export interface SseSink {
  readonly writable: boolean;
  write(chunk: string): unknown;
  end(): unknown;
}

/** The retry hint the `reconnect` event carries (the same 3 s the controller uses when a visibility check fails). */
export const SSE_RECONNECT_RETRY_MS = 3000;

@Injectable()
export class SseConnections {
  private readonly open = new Set<SseSink>();

  /** Track a stream. Returns the function that forgets it (call it when the response closes). */
  add(sink: SseSink): () => void {
    this.open.add(sink);
    return () => {
      this.open.delete(sink);
    };
  }

  get size(): number {
    return this.open.size;
  }

  /**
   * Tell every open stream to reconnect, then end it. Never throws: one stream whose socket is already gone must
   * not stop the rest from being closed, and this runs inside a shutdown.
   */
  closeAll(): number {
    let closed = 0;
    for (const sink of [...this.open]) {
      try {
        if (sink.writable) {
          sink.write(
            `event: reconnect\ndata: ${JSON.stringify({ retryMs: SSE_RECONNECT_RETRY_MS })}\n\n`,
          );
          sink.end();
          closed += 1;
        }
      } catch {
        // already torn down
      }
    }
    this.open.clear();
    return closed;
  }
}

/**
 * Wire {@link SseConnections} into Fastify's close. Call it once, before `listen()` (a hook cannot be added to an
 * instance that is already ready), next to `enableHealth` and `enableGracefulShutdown`.
 */
export function registerSseShutdown(fastify: FastifyInstance, connections: SseConnections): void {
  fastify.addHook('preClose', () => {
    connections.closeAll();
  });
}
