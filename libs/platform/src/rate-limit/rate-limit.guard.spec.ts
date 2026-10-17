/**
 * WHOSE bucket a request lands in, against the real `RateLimitGuard` and the real `clientIp()`.
 *
 * Behind the Cloudflare Tunnel `req.ip` is cloudflared's own address, so keying by it put EVERY visitor in one bucket:
 * `AUTH_LOGIN` (5 attempts per 15 minutes) and `DEFAULT` (100 per minute) were the whole company's. The guard now
 * keys by `clientIp()`. What these tests pin is the property, not the plumbing: two visitors behind the same
 * tunnel address get different buckets, a forged header does not choose a bucket, a verified edge address does.
 *
 * The THRESHOLDS are rova's own (RATE_LIMIT_TIERS) and are asserted unchanged here: adopting `clientIp()` moves
 * who is counted, never how many.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { requestContextStorage, type RequestContext } from '@quynhonsemiconductor/observability';
import { KEYED_BY_ADDRESS } from '@quynhonsemiconductor/platform-http';
import { signEdgeClientIp } from '@quynhonsemiconductor/platform-http/edge';
import { RateLimitGuard } from './rate-limit.guard';
import { RATE_LIMIT_METADATA_KEY, RATE_LIMIT_TIERS } from './rate-limit.constants';

const TUNNEL = '172.16.0.9'; // cloudflared: what req.ip is for every visitor
const SECRET = 'e'.repeat(48);

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
  let guard: RateLimitGuard;

  beforeEach(() => {
    keys = [];
    consumed = [];
    const cache = {
      consumeRateLimit: vi.fn((key: string, limit: number, window: number) => {
        keys.push(key);
        consumed.push({ limit, window });
        return Promise.resolve({ allowed: true, remaining: limit - 1, resetAt: 0 });
      }),
    };
    const metrics = { recordFailOpen: vi.fn() };
    delete process.env['DISABLE_RATE_LIMIT'];
    guard = new RateLimitGuard(new Reflector(), cache as never, metrics as never);
    delete process.env['EDGE_CLIENT_IP_SECRET'];
    delete process.env['EDGE_CLIENT_IP_SECRET_PREVIOUS'];
  });

  afterEach(() => {
    delete process.env['EDGE_CLIENT_IP_SECRET'];
  });

  it('gives two visitors behind the same tunnel address DIFFERENT buckets', async () => {
    await guard.canActivate(
      context(request({ headers: { 'cf-connecting-ip': '203.0.113.7' } }), 'AUTH_LOGIN'),
    );
    await guard.canActivate(
      context(request({ headers: { 'cf-connecting-ip': '198.51.100.20' } }), 'AUTH_LOGIN'),
    );

    expect(keys).toEqual(['AUTH_LOGIN:ip:203.0.113.7', 'AUTH_LOGIN:ip:198.51.100.20']);
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
        'AUTH_LOGIN',
      ),
    );
    expect(keys).toEqual(['AUTH_LOGIN:ip:203.0.113.7']);
  });

  it('with EDGE_CLIENT_IP_SECRET set, takes the VERIFIED signed address over cf-connecting-ip', async () => {
    // Behind a Pages Function cf-connecting-ip is a Cloudflare address shared by every visitor.
    process.env['EDGE_CLIENT_IP_SECRET'] = SECRET;
    const signed = await signEdgeClientIp({
      secret: SECRET,
      ip: '203.0.113.99',
      method: 'POST',
      path: '/v1/bff/dev-login',
    });

    await guard.canActivate(
      context(
        request({ headers: { 'cf-connecting-ip': '104.28.0.1', ...signed } }), // 104.28.0.1: Cloudflare's own
        'AUTH_LOGIN',
      ),
    );

    expect(keys).toEqual(['AUTH_LOGIN:ip:203.0.113.99']);
  });

  it('ignores a signed address that does not verify (wrong key), falling back to cf-connecting-ip', async () => {
    process.env['EDGE_CLIENT_IP_SECRET'] = SECRET;
    const forged = await signEdgeClientIp({
      secret: 'f'.repeat(48),
      ip: '203.0.113.99',
      method: 'POST',
      path: '/v1/bff/dev-login',
    });

    await guard.canActivate(
      context(
        request({ headers: { 'cf-connecting-ip': '198.51.100.20', ...forged } }),
        'AUTH_LOGIN',
      ),
    );

    expect(keys).toEqual(['AUTH_LOGIN:ip:198.51.100.20']);
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
      context(request({ headers: { 'cf-connecting-ip': '1.1.1.1' } }), 'AUTH_LOGIN'),
    );
    await guard.canActivate(
      context(request({ headers: { 'cf-connecting-ip': '1.1.1.1' } }), 'AUTH_SSO_START'),
    );
    await guard.canActivate(
      context(request({ headers: { 'cf-connecting-ip': '1.1.1.1' } }), 'AUTH_IDP_LOOKUP'),
    );

    expect(consumed).toEqual([
      { limit: 100, window: 60 },
      { limit: 5, window: 900 },
      { limit: 30, window: 900 },
      { limit: 10, window: 900 },
    ]);
    expect(RATE_LIMIT_TIERS.DEFAULT).toEqual({ limit: 100, windowSeconds: 60 });
    expect(RATE_LIMIT_TIERS.AUTH_LOGIN).toEqual({ limit: 5, windowSeconds: 900 });
  });
});
