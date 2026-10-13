/**
 * The access log and the idempotency fingerprint use `clientIp()` as well. Both used to read `x-real-ip`,
 * `x-forwarded-for` or `req.ip` themselves: the log recorded cloudflared's address for every visitor, and the
 * idempotency fingerprint of two unauthenticated callers with the same User-Agent was the same.
 */
import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { HttpMetrics } from '@quynhonsemiconductor/observability';
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
