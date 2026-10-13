/**
 * What `bootstrapApp` mounts for the load balancer, the kubelet and the request log, against a real Fastify server:
 * the four probe paths, `/readyz` going 503 with the database or during shutdown, and the correlation id rules that
 * replaced `AsyncLocalStorageMiddleware`. No port is bound (`inject`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { RequestContextService } from '@quynhonsemiconductor/observability';
import { enableCorrelationId } from '@quynhonsemiconductor/platform-http';
import { enableGracefulShutdown, healthRegistryOf } from '@quynhonsemiconductor/platform-runtime';
import { DATABASE_POOL_TOKEN } from '@platform/database/drizzle.provider';
import { enableProbes } from './app.bootstrap';

@Controller()
class EchoController {
  constructor(private readonly ctx: RequestContextService) {}
  @Get('echo')
  echo() {
    return { correlationId: this.ctx.getCorrelationId() };
  }
}

/** What the database pool does when `/readyz` pings it (`pool.query('SELECT 1')`). */
let query: () => Promise<unknown> = () => Promise.resolve({ rows: [] });

/**
 * `DatabaseModule` provides the real pool under this token; `enableHealth()` finds it there and adds its built-in
 * `database` check. The fake has the one method the ping uses.
 */
@Module({
  controllers: [EchoController],
  providers: [
    RequestContextService,
    {
      provide: DATABASE_POOL_TOKEN,
      useValue: { query: () => query(), options: { host: 'db.test', user: 'rova_app' } },
    },
  ],
})
class TestModule {}

let app: NestFastifyApplication | undefined;

async function boot(execute: () => Promise<unknown> = () => Promise.resolve([])) {
  query = execute;
  app = await NestFactory.create<NestFastifyApplication>(TestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('v1');
  enableCorrelationId(app);
  enableProbes(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const get = (url: string, headers: Record<string, string> = {}) =>
  app!.getHttpAdapter().getInstance().inject({ method: 'GET', url, headers });

describe('probes', () => {
  it.each(['/livez', '/v1/healthz'])('%s answers 200 and touches no dependency', async (path) => {
    const execute = vi.fn(() => Promise.reject(new Error('database is down')));
    await boot(execute);

    const res = await get(path);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(execute).not.toHaveBeenCalled(); // liveness must never check a dependency
  });

  it.each(['/readyz', '/v1/readyz'])('%s is 200 while the database answers', async (path) => {
    await boot();
    const res = await get(path);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', checks: { database: 'up' } });
  });

  it('/readyz is 503 and names the database when it is down, without leaking the cause', async () => {
    await boot(() => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:5432')));
    const res = await get('/readyz');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'error', checks: { database: 'down' } });
    expect(res.body).not.toContain('10.0.0.5'); // the endpoint is unauthenticated
  });

  it('/readyz is 503 as soon as shutdown begins, while /livez stays 200 for the endpoint-removal delay', async () => {
    await boot();
    const shutdown = enableGracefulShutdown(app!, {
      signals: [],
      exit: () => undefined,
      env: { SHUTDOWN_ENDPOINT_DELAY_MS: '300', SHUTDOWN_TIMEOUT_MS: '5000' },
    });
    expect((await get('/readyz')).statusCode).toBe(200);

    const done = shutdown.shutdown('test');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(healthRegistryOf(app!)?.shuttingDown).toBe(true);
    expect((await get('/readyz')).statusCode).toBe(503);
    expect((await get('/livez')).statusCode).toBe(200);
    await done;
    app = undefined; // enableGracefulShutdown closed it
  });

  it('are not under the Nest global prefix: /v1/livez is not a route', async () => {
    await boot();
    expect((await get('/v1/livez')).statusCode).toBe(404);
  });
});

describe('correlation id (replaces AsyncLocalStorageMiddleware)', () => {
  it('generates one, echoes it, and the request context carries the SAME value', async () => {
    await boot();
    const res = await get('/v1/echo');
    const header = res.headers['x-correlation-id'];
    expect(typeof header).toBe('string');
    expect(res.json()).toEqual({ correlationId: header });
  });

  it('keeps a caller-supplied id', async () => {
    await boot();
    const res = await get('/v1/echo', { 'x-correlation-id': 'req-abc.123:xyz' });
    expect(res.headers['x-correlation-id']).toBe('req-abc.123:xyz');
    expect(res.json()).toEqual({ correlationId: 'req-abc.123:xyz' });
  });

  // THE TWO DIFFERENCES FROM THE OLD MIDDLEWARE, pinned so they are decisions rather than accidents.
  it('now accepts a SHORT id and a dotted/colon one (old rule: 8-64 characters of [A-Za-z0-9_-])', async () => {
    await boot();
    for (const id of ['abc', 'svc:req.42']) {
      const res = await get('/v1/echo', { 'x-correlation-id': id });
      expect(res.headers['x-correlation-id'], id).toBe(id);
    }
  });

  it('no longer falls back to X-Request-Id (the old middleware did)', async () => {
    await boot();
    const res = await get('/v1/echo', { 'x-request-id': 'upstream-request-id-1' });
    expect(res.headers['x-correlation-id']).not.toBe('upstream-request-id-1');
  });

  it('replaces an id that could inject (whitespace, quotes) instead of echoing it', async () => {
    await boot();
    const res = await get('/v1/echo', { 'x-correlation-id': 'a b"c' });
    expect(res.headers['x-correlation-id']).not.toContain(' ');
    expect(res.headers['x-correlation-id']).not.toContain('"');
  });
});
