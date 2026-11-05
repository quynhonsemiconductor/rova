/**
 * WHOSE bucket a request lands in, against the real `RateLimitGuard` and the real `clientIp()`.
 *
 * Behind the Cloudflare Tunnel `req.ip` is cloudflared's own address, so keying by it put EVERY visitor in one bucket:
 * `STRICT` (20 per minute) and `DEFAULT` (100 per minute) were the whole company's. The guard now
 * keys by `clientIp()`. What these tests pin is the property, not the plumbing: two visitors behind the same
 * tunnel address get different buckets, a forged header does not choose a bucket, a verified edge address does.
 *
 * The THRESHOLDS are rova's own (RATE_LIMIT_TIERS) and are asserted unchanged here: adopting `clientIp()` moves
 * who is counted, never how many.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { requestContextStorage, type RequestContext } from '@quynhonsemiconductor/observability';
import { KEYED_BY_ADDRESS } from '@quynhonsemiconductor/platform-http';
import { RateLimitGuard } from './rate-limit.guard';
import { PRE_AUTH_RESERVATIONS, type PreAuthReservation } from './pre-auth-rate-limit.guard';
import {
  RATE_LIMIT_METADATA_KEY,
  RATE_LIMIT_TIERS,
  SKIP_RATE_LIMIT_KEY,
} from './rate-limit.constants';

const TUNNEL = '172.16.0.9'; // cloudflared: what req.ip is for every visitor

interface Req {
  headers: Record<string, string | undefined>;
  ip: string;
  method: string;
  url: string;
  socket: { remoteAddress: string };
  cookies?: Record<string, string>;
  user?: { sub: string };
}

const request = (over: Partial<Req> = {}): Req => ({
  headers: {},
  ip: TUNNEL,
  method: 'POST',
  url: '/v1/bff/dev-login',
  socket: { remoteAddress: TUNNEL },
  ...over,
});

function context(req: Req, handlerTier?: string): ExecutionContext {
  const handler = () => undefined;
  if (handlerTier) Reflect.defineMetadata(RATE_LIMIT_METADATA_KEY, handlerTier, handler);
  return {
    getHandler: () => handler,
    getClass: () => class Controller {},
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({ header: vi.fn() }),
    }),
  } as unknown as ExecutionContext;
}

describe('RateLimitGuard — the bucket is the CLIENT, not the tunnel', () => {
  let keys: string[];
  let consumed: Array<{ limit: number; window: number }>;
  let refund: ReturnType<typeof vi.fn>;
  let rejected: ReturnType<typeof vi.fn>;
  let guard: RateLimitGuard;

  beforeEach(() => {
    keys = [];
    consumed = [];
    refund = vi.fn().mockResolvedValue(undefined);
    rejected = vi.fn();
    const cache = {
      consumeRateLimit: vi.fn((key: string, limit: number, window: number) => {
        keys.push(key);
        consumed.push({ limit, window });
        return Promise.resolve({ allowed: true, remaining: limit - 1, resetAt: 0 });
      }),
      refundRateLimit: refund,
    };
    const metrics = { recordFailOpen: vi.fn() };
    delete process.env['DISABLE_RATE_LIMIT'];
    guard = new RateLimitGuard(
      new Reflector(),
      cache as never,
      metrics as never,
      {
        recordRejected: rejected,
      } as never,
    );
  });

  it('gives two visitors behind the same tunnel address DIFFERENT buckets', async () => {
    await guard.canActivate(
      context(request({ headers: { 'cf-connecting-ip': '203.0.113.7' } }), 'STRICT'),
    );
    await guard.canActivate(
      context(request({ headers: { 'cf-connecting-ip': '198.51.100.20' } }), 'STRICT'),
    );

    expect(keys).toEqual(['STRICT:ip:203.0.113.7', 'STRICT:ip:198.51.100.20']);
    expect(keys.join()).not.toContain(TUNNEL);
  });

  it('keys by cf-connecting-ip even when a forged x-forwarded-for / x-real-ip is sent', async () => {
    await guard.canActivate(
      context(
        request({
          headers: {
            'cf-connecting-ip': '203.0.113.7',
            'x-forwarded-for': '1.2.3.4',
            'x-real-ip': '5.6.7.8',
          },
        }),
        'STRICT',
      ),
    );
    expect(keys).toEqual(['STRICT:ip:203.0.113.7']);
  });

  it('does NOT fall back to x-forwarded-for when cf-connecting-ip is absent (platform-http 5.0.2)', async () => {
    // Until 5.0.2 the header chain's FIRST entry was the fallback, so any caller without
    // cf-connecting-ip could name its own address — and so pick its own bucket. Now the socket
    // (cloudflared's address here) is the honest answer.
    await guard.canActivate(
      context(
        request({ headers: { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8' } }),
        'STRICT',
      ),
    );
    expect(keys).toEqual([`STRICT:ip:${TUNNEL}`]);
    expect(keys.join()).not.toContain('1.2.3.4');
  });

  const principalStore = (userId?: string): RequestContext => ({
    workspaceId: undefined,
    userId,
    sessionId: userId ? 'sess-1' : undefined,
    correlationId: 'corr-1',
    traceparent: undefined,
  });

  it('an authenticated user is keyed by user id, not address: the principal comes from the request context', async () => {
    const req = request({ headers: { 'cf-connecting-ip': '203.0.113.7' } });
    await requestContextStorage.run(principalStore('user-1'), () =>
      guard.canActivate(context(req)),
    );
    expect(keys).toEqual(['DEFAULT:uid:user-1']);
    expect((req as unknown as Record<symbol, unknown>)[KEYED_BY_ADDRESS]).toBeUndefined();
  });

  it('req.user alone is NOT a principal (platform-http 5): the caller is keyed by address, and the request is marked so a guard that authenticates later can say it ran too late', async () => {
    const req = request({
      headers: { 'cf-connecting-ip': '203.0.113.7' },
      user: { sub: 'user-1' },
    });
    await requestContextStorage.run(principalStore(), () => guard.canActivate(context(req)));
    expect(keys).toEqual(['DEFAULT:ip:203.0.113.7']);
    expect((req as unknown as Record<symbol, unknown>)[KEYED_BY_ADDRESS]).toBe(true);
  });

  it("keeps rova's own thresholds: the guard changed WHO is counted, not how many", async () => {
    await guard.canActivate(context(request({ headers: { 'cf-connecting-ip': '1.1.1.1' } })));
    await guard.canActivate(
      context(request({ headers: { 'cf-connecting-ip': '1.1.1.1' } }), 'STRICT'),
    );
    expect(consumed).toEqual([
      { limit: 1200, window: 60 },
      { limit: 20, window: 60 },
    ]);
    expect(RATE_LIMIT_TIERS.DEFAULT).toEqual({ limit: 1200, windowSeconds: 60 });
    expect(RATE_LIMIT_TIERS.STRICT).toEqual({ limit: 20, windowSeconds: 60 });
    // AUTH_ME is gone on purpose: SPA-bootstrap reads ride DEFAULT, never a tighter per-user tier.
    expect('AUTH_ME' in RATE_LIMIT_TIERS).toBe(false);
  });

  it('an AUTHENTICATED request gives back the address slot the pre-auth guard reserved', async () => {
    const req = request({ headers: { 'cf-connecting-ip': '203.0.113.7' } });
    const reservation: PreAuthReservation = {
      key: 'PRE_AUTH:ip:203.0.113.7',
      id: 'slot-7',
      settled: false,
    };
    (req as unknown as Record<symbol, unknown>)[PRE_AUTH_RESERVATIONS] = [reservation];

    await requestContextStorage.run(principalStore('user-1'), () =>
      guard.canActivate(context(req)),
    );

    expect(refund).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledWith('PRE_AUTH:ip:203.0.113.7', 'slot-7');
    expect(reservation.settled).toBe(true);
    // the user's own bucket is still consumed: the refund moves the COUNT, not the budget
    expect(keys).toEqual(['DEFAULT:uid:user-1']);
  });

  it('a request that never authenticates KEEPS its slot: a forged cookie must still cost its address', async () => {
    const req = request({ headers: { 'cf-connecting-ip': '203.0.113.7' } });
    const reservation: PreAuthReservation = {
      key: 'PRE_AUTH:ip:203.0.113.7',
      id: 'slot-8',
      settled: false,
    };
    (req as unknown as Record<symbol, unknown>)[PRE_AUTH_RESERVATIONS] = [reservation];

    await requestContextStorage.run(principalStore(), () => guard.canActivate(context(req)));

    expect(refund).not.toHaveBeenCalled();
    expect(reservation.settled).toBe(false);
    expect(keys).toEqual(['DEFAULT:ip:203.0.113.7']);
  });

  it('a failed refund is LOGGED and the request is still admitted', async () => {
    refund.mockRejectedValue(new Error('valkey down'));
    const logger = (guard as unknown as { logger: { error: (...a: unknown[]) => void } }).logger;
    const logError = vi.spyOn(logger, 'error');
    const req = request({ headers: { 'cf-connecting-ip': '203.0.113.7' } });
    (req as unknown as Record<symbol, unknown>)[PRE_AUTH_RESERVATIONS] = [
      {
        key: 'PRE_AUTH:ip:203.0.113.7',
        id: 'slot-9',
        settled: false,
      } satisfies PreAuthReservation,
    ];

    const allowed = await requestContextStorage.run(principalStore('user-1'), () =>
      guard.canActivate(context(req)),
    );
    // The refund is awaited, so no setImmediate dance is needed and the log is there.
    expect(allowed).toBe(true);
    expect(refund).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalled();
    logError.mockRestore();
  });

  it('a 429 to a signed-in user is LOGGED with user/route and COUNTED as a user-keyed refusal', async () => {
    const cache = {
      consumeRateLimit: vi.fn().mockResolvedValueOnce({
        allowed: false,
        remaining: 0,
        resetAt: Math.floor(Date.now() / 1000) + 30,
      }),
      refundRateLimit: refund,
    };
    const gaugeGuard = new RateLimitGuard(
      new Reflector(),
      cache as never,
      { recordFailOpen: vi.fn() } as never,
      { recordRejected: rejected } as never,
    );
    const logger = (gaugeGuard as unknown as { logger: { warn: (...a: unknown[]) => void } })
      .logger;
    const logWarn = vi.spyOn(logger, 'warn');
    const req = request({
      headers: { 'cf-connecting-ip': '203.0.113.7' },
      url: '/v1/work-items/019f8a00-0000-7000-8000-000000000001',
    });

    await expect(
      requestContextStorage.run(principalStore('user-1'), () =>
        gaugeGuard.canActivate(context(req)),
      ),
    ).rejects.toThrow(/Rate limit exceeded/);

    expect(rejected).toHaveBeenCalledWith({
      tier: 'DEFAULT',
      route: '/v1/work-items/:id',
      keyedBy: 'user',
    });
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', route: '/v1/work-items/:id', tier: 'DEFAULT' }),
      'Rate limit exceeded',
    );
    logWarn.mockRestore();
  });

  it('honours @SkipRateLimit() (probes and metrics scrapes)', async () => {
    const handler = () => undefined;
    Reflect.defineMetadata(SKIP_RATE_LIMIT_KEY, true, handler);
    const skippedContext = {
      getHandler: () => handler,
      getClass: () => class Controller {},
      switchToHttp: () => ({
        getRequest: () => request(),
        getResponse: () => ({ header: vi.fn() }),
      }),
    } as unknown as ExecutionContext;

    expect(await guard.canActivate(skippedContext)).toBe(true);
    expect(keys).toEqual([]);
  });

  it('fails OPEN when the cache cannot answer, and says so (the outage alarm reads the tag)', async () => {
    const metrics = { recordFailOpen: vi.fn() };
    const cache = {
      consumeRateLimit: vi.fn().mockRejectedValue(new Error('valkey down')),
      refundRateLimit: refund,
    };
    const failingGuard = new RateLimitGuard(
      new Reflector(),
      cache as never,
      metrics as never,
      {
        recordRejected: rejected,
      } as never,
    );
    await expect(
      requestContextStorage.run(principalStore('user-1'), () =>
        failingGuard.canActivate(
          context(request({ headers: { 'cf-connecting-ip': '203.0.113.7' } })),
        ),
      ),
    ).resolves.toBe(true);
    expect(metrics.recordFailOpen).toHaveBeenCalledWith('rate_limit');
  });

  it('an authenticated request with NO pre-auth reservation refunds nothing (and still runs)', async () => {
    const req = request({ headers: { 'cf-connecting-ip': '203.0.113.7' } });
    const allowed = await requestContextStorage.run(principalStore('user-1'), () =>
      guard.canActivate(context(req)),
    );
    expect(allowed).toBe(true);
    expect(refund).not.toHaveBeenCalled();
    expect(keys).toEqual(['DEFAULT:uid:user-1']);
  });

  it('DISABLE_RATE_LIMIT bypasses the guard (dev/CI)', async () => {
    process.env['DISABLE_RATE_LIMIT'] = 'true';
    const disabledGuard = new RateLimitGuard(
      new Reflector(),
      { consumeRateLimit: vi.fn(), refundRateLimit: refund } as never,
      { recordFailOpen: vi.fn() } as never,
      { recordRejected: rejected } as never,
    );
    expect(await disabledGuard.canActivate(context(request()))).toBe(true);
    delete process.env['DISABLE_RATE_LIMIT'];
  });

  it('a 429 from the USER bucket KEEPS the address slot: the per-IP floor is not a bypass', async () => {
    // The user's own budget is exhausted.
    const cache = {
      consumeRateLimit: vi.fn().mockResolvedValueOnce({
        allowed: false,
        remaining: 0,
        resetAt: Math.floor(Date.now() / 1000) + 30,
      }),
      refundRateLimit: refund,
    };
    const strictGuard = new RateLimitGuard(
      new Reflector(),
      cache as never,
      {
        recordFailOpen: vi.fn(),
      } as never,
      { recordRejected: rejected } as never,
    );
    const req = request({ headers: { 'cf-connecting-ip': '203.0.113.7' } });
    (req as unknown as Record<symbol, unknown>)[PRE_AUTH_RESERVATIONS] = [
      {
        key: 'PRE_AUTH:ip:203.0.113.7',
        id: 'slot-10',
        settled: false,
      } satisfies PreAuthReservation,
    ];

    await expect(
      requestContextStorage.run(principalStore('user-1'), () =>
        strictGuard.canActivate(context(req)),
      ),
    ).rejects.toThrow(/Rate limit exceeded/);

    expect(refund).not.toHaveBeenCalled();
    expect(
      (
        (req as unknown as Record<symbol, unknown>)[PRE_AUTH_RESERVATIONS] as PreAuthReservation[]
      )[0].settled,
    ).toBe(false);
  });
});
