/**
 * The access log and the idempotency fingerprint use `clientIp()` as well. Both used to read `x-real-ip`,
 * `x-forwarded-for` or `req.ip` themselves: the log recorded cloudflared's address for every visitor, and the
 * idempotency fingerprint of two unauthenticated callers with the same User-Agent was the same.
 */
import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import {
  requestContextStorage,
  type HttpMetrics,
  type RequestContext,
} from '@quynhonsemiconductor/observability';
import { HttpLoggingInterceptor } from './http-logging.interceptor';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import type { AppConfigService } from '../config/app-config.service';

const TUNNEL = '172.16.0.9';

function ctx(req: Record<string, unknown>, status = 200): ExecutionContext {
  const http = { getRequest: () => req, getResponse: () => ({ statusCode: status }) };
  return { getType: () => 'http', switchToHttp: () => http } as unknown as ExecutionContext;
}

const base = (visitor: string) => ({
  method: 'POST',
  url: '/v1/work-items',
  query: {},
  headers: { 'cf-connecting-ip': visitor, 'user-agent': 'curl/8', 'idempotency-key': 'k1' },
  ip: TUNNEL,
  socket: { remoteAddress: TUNNEL },
  routeOptions: { url: '/v1/work-items' },
});

describe('HttpLoggingInterceptor — the ip it logs', () => {
  it("is the visitor's address, never the tunnel's and never a forged x-real-ip", async () => {
    const lines: unknown[] = [];
    vi.spyOn(Logger.prototype, 'log').mockImplementation((line: unknown) => void lines.push(line));
    const interceptor = new HttpLoggingInterceptor(
      { get: () => false } as unknown as AppConfigService,
      { record: vi.fn() } as unknown as HttpMetrics,
    );
    const req = {
      ...base('203.0.113.7'),
      headers: { ...base('x').headers, 'cf-connecting-ip': '203.0.113.7', 'x-real-ip': '6.6.6.6' },
    };

    await new Promise<void>((resolve) =>
      interceptor
        .intercept(ctx(req), { handle: () => of('ok') } as CallHandler)
        .subscribe({ complete: resolve }),
    );

    const logged = JSON.stringify(lines);
    expect(logged).toContain('203.0.113.7');
    expect(logged).not.toContain(TUNNEL);
    expect(logged).not.toContain('6.6.6.6');
  });
});

describe('IdempotencyInterceptor — an unauthenticated caller is told apart by address', () => {
  async function redisKeyFor(visitor: string): Promise<string> {
    const get = vi.fn().mockResolvedValue(null);
    const cache = {
      isAvailable: true,
      instance: { get, set: vi.fn().mockResolvedValue('OK') },
    };
    const interceptor = new IdempotencyInterceptor(cache as never);
    await new Promise<void>((resolve) =>
      interceptor
        .intercept(ctx(base(visitor)), { handle: () => of({}) } as CallHandler)
        .subscribe({ complete: resolve }),
    );
    return String(get.mock.calls[0]?.[0]);
  }

  it('two callers behind the same tunnel with the same User-Agent get DIFFERENT keys', async () => {
    const a = await redisKeyFor('203.0.113.7');
    const b = await redisKeyFor('198.51.100.20');
    expect(a).not.toBe(b);
  });

  it('the same caller gets the same key twice (a retry still finds its answer)', async () => {
    expect(await redisKeyFor('203.0.113.7')).toBe(await redisKeyFor('203.0.113.7'));
  });
});

/**
 * WHO is calling (platform-http >= 5): both interceptors read the principal from the request context,
 * which the authenticating guard writes with `setRequestPrincipal`. `req.user` is not consulted.
 */
const principalContext = (userId: string): RequestContext => ({
  workspaceId: 'ws-1',
  userId,
  sessionId: 'sess-1',
  correlationId: 'corr-1',
  traceparent: undefined,
});

describe('the user comes from the request context, not from req.user', () => {
  async function idempotencyKey(req: Record<string, unknown>, store?: RequestContext) {
    const get = vi.fn().mockResolvedValue(null);
    const cache = { isAvailable: true, instance: { get, set: vi.fn().mockResolvedValue('OK') } };
    const interceptor = new IdempotencyInterceptor(cache as never);
    const run = () =>
      new Promise<void>((resolve) =>
        interceptor
          .intercept(ctx(req), { handle: () => of({}) } as CallHandler)
          .subscribe({ complete: resolve }),
      );
    await (store ? requestContextStorage.run(store, run) : run());
    return String(get.mock.calls[0]?.[0]);
  }

  it('the idempotency key is scoped by the principal', async () => {
    const key = await idempotencyKey(base('203.0.113.7'), principalContext('user-7'));
    expect(key.startsWith('idem:user-7:')).toBe(true);
  });

  it('with no request context (setRequestPrincipal was a no-op), req.user still scopes it: two users behind one NAT never share an entry', async () => {
    const a = await idempotencyKey({ ...base('203.0.113.7'), user: { sub: 'user-a' } });
    const b = await idempotencyKey({ ...base('203.0.113.7'), user: { sub: 'user-b' } });
    expect(a.startsWith('idem:user-a:')).toBe(true);
    expect(b.startsWith('idem:user-b:')).toBe(true);
    expect(a).not.toBe(b);
  });

  it('the principal wins over req.user when both are there', async () => {
    const key = await idempotencyKey(
      { ...base('203.0.113.7'), user: { sub: 'from-req' } },
      principalContext('from-context'),
    );
    expect(key.startsWith('idem:from-context:')).toBe(true);
  });

  it('the access log carries the principal as userId, on success and on error', async () => {
    const lines: unknown[] = [];
    vi.spyOn(Logger.prototype, 'log').mockImplementation((line: unknown) => void lines.push(line));
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((line: unknown) => void lines.push(line));
    vi.spyOn(Logger.prototype, 'error').mockImplementation(
      (line: unknown) => void lines.push(line),
    );
    const interceptor = new HttpLoggingInterceptor(
      { get: () => false } as unknown as AppConfigService,
      { record: vi.fn() } as unknown as HttpMetrics,
    );
    const run = (handler: CallHandler) =>
      requestContextStorage.run(
        principalContext('user-7'),
        () =>
          new Promise<void>((resolve) =>
            interceptor
              .intercept(ctx(base('203.0.113.7')), handler)
              .subscribe({ complete: resolve, error: () => resolve() }),
          ),
      );
    await run({ handle: () => of('ok') });
    await run({ handle: () => throwError(() => new Error('boom')) });

    const logged = lines.map((l) => JSON.stringify(l));
    expect(logged.filter((l) => l.includes('"userId":"user-7"')).length).toBe(2);
  });

  it('the access log has no userId for a request that never authenticated, even if req.user is set', async () => {
    const lines: unknown[] = [];
    vi.spyOn(Logger.prototype, 'log').mockImplementation((line: unknown) => void lines.push(line));
    const interceptor = new HttpLoggingInterceptor(
      { get: () => false } as unknown as AppConfigService,
      { record: vi.fn() } as unknown as HttpMetrics,
    );
    await new Promise<void>((resolve) =>
      interceptor
        .intercept(ctx({ ...base('203.0.113.7'), user: { sub: 'user-7' } }), {
          handle: () => of('ok'),
        } as CallHandler)
        .subscribe({ complete: resolve }),
    );
    expect(JSON.stringify(lines)).not.toContain('user-7');
  });
});
