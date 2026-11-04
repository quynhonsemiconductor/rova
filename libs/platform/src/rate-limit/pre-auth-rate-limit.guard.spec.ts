import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PreAuthRateLimitGuard,
  PRE_AUTH_RESERVATION,
  refundPreAuthReservation,
  type PreAuthReservation,
} from './pre-auth-rate-limit.guard';
import { SKIP_RATE_LIMIT_KEY } from './rate-limit.constants';
import { consumeMcpCallToken, mintMcpCallToken, MCP_CALL_TOKEN_HEADER } from '../mcp-call-token';

const ctx = (
  headers: Record<string, string>,
  skip = false,
  req?: Record<symbol, unknown>,
): ExecutionContext => {
  const handler = () => undefined;
  if (skip) Reflect.defineMetadata(SKIP_RATE_LIMIT_KEY, true, handler);
  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => class Route {},
    switchToHttp: () => ({
      getRequest: () => {
        const defaultReq = {
          headers: { 'cf-connecting-ip': '203.0.113.7', ...headers },
          ip: '10.0.0.1',
          socket: {},
        };
        // With a caller-supplied request, mutate THAT object: the reservation is written back.
        return req ? Object.assign(req, defaultReq) : defaultReq;
      },
      getResponse: () => ({ header: vi.fn() }),
    }),
  } as unknown as ExecutionContext;
};

describe('PreAuthRateLimitGuard', () => {
  let buckets: Map<string, number>;
  let consume: ReturnType<typeof vi.fn>;
  let guard: PreAuthRateLimitGuard;

  beforeEach(() => {
    delete process.env['DISABLE_RATE_LIMIT'];
    buckets = new Map();
    let slot = 0;
    consume = vi.fn((key: string, limit: number) => {
      const n = (buckets.get(key) ?? 0) + 1;
      buckets.set(key, n);
      return Promise.resolve({
        allowed: n <= limit,
        remaining: 0,
        resetAt: Math.floor(Date.now() / 1000) + 30,
        id: `slot-${++slot}`,
      });
    });
    guard = new PreAuthRateLimitGuard(
      new Reflector(),
      { consumeRateLimit: consume } as never,
      {
        recordFailOpen: vi.fn(),
      } as never,
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it('counts every request by address, before anyone is authenticated', async () => {
    await guard.canActivate(ctx({}));
    expect(consume).toHaveBeenCalledWith('PRE_AUTH:ip:203.0.113.7', 1200, 60);
  });

  it('counts a request that presents an API token in a second, tighter bucket', async () => {
    await guard.canActivate(ctx({ authorization: 'Bearer rly_abcdefgh_secret' }));
    expect(consume).toHaveBeenCalledWith('PRE_AUTH_TOKEN:ip:203.0.113.7', 300, 60);
  });

  it('refuses the 301st token presentation from one address with a 429 and leaves another address alone', async () => {
    const withToken = ctx({ authorization: 'Bearer rly_zzzzzzzz_guess' });
    for (let i = 0; i < 300; i++) expect(await guard.canActivate(withToken)).toBe(true);
    await expect(guard.canActivate(withToken)).rejects.toThrow(
      /Rate limit exceeded \(PRE_AUTH_TOKEN\)/,
    );
    expect(
      await guard.canActivate(
        ctx({ authorization: 'Bearer rly_zzzzzzzz_guess', 'cf-connecting-ip': '198.51.100.9' }),
      ),
    ).toBe(true);
  });

  it('an MCP internal call (live call token) keys PRE_AUTH by PERSON, never by the shared loopback address', async () => {
    const principal = {
      userId: '0194a000-0000-7000-8000-0000000000aa',
      workspaceId: '0194a000-0000-7000-8000-000000000003',
      sessionId: 'mcp:req-1',
    };
    // two different people, both over loopback inject(): two separate PRE_AUTH buckets
    const victimToken = mintMcpCallToken(principal);
    await guard.canActivate(ctx({ [MCP_CALL_TOKEN_HEADER]: victimToken }));
    await guard.canActivate(
      ctx({
        [MCP_CALL_TOKEN_HEADER]: mintMcpCallToken({
          ...principal,
          userId: '0194a000-0000-7000-8000-0000000000ff',
        }),
      }),
    );
    expect(consume).toHaveBeenCalledWith(`PRE_AUTH:uid:${principal.userId}`, 1200, 60);
    expect(consume).toHaveBeenCalledWith(
      'PRE_AUTH:uid:0194a000-0000-7000-8000-0000000000ff',
      1200,
      60,
    );
    // and NO ip bucket was touched for either: loopback keying would share one floor
    expect([...buckets.keys()].filter((k) => k.includes(':ip:'))).toEqual([]);
    // the peek did not spend the token: the principal guard's consume still unlocks it
    expect(consumeMcpCallToken(victimToken)).toEqual(principal);
  });

  it('a spent or forged call token is no context: back to address keying', async () => {
    const spent = mintMcpCallToken({
      userId: '0194a000-0000-7000-8000-0000000000aa',
      workspaceId: '0194a000-0000-7000-8000-000000000003',
      sessionId: 'mcp:req-1',
    });
    expect(consumeMcpCallToken(spent)).toBeDefined();
    await guard.canActivate(ctx({ [MCP_CALL_TOKEN_HEADER]: spent }));
    expect(consume).toHaveBeenCalledWith('PRE_AUTH:ip:203.0.113.7', 1200, 60);
    expect([...buckets.keys()].filter((k) => k.startsWith('PRE_AUTH:uid'))).toEqual([]);
  });

  it('does not count a JWT-shaped bearer or a cookie request in the token bucket', async () => {
    await guard.canActivate(ctx({ authorization: 'Bearer aaa.bbb.ccc' }));
    expect([...buckets.keys()]).toEqual(['PRE_AUTH:ip:203.0.113.7']);
  });

  it('honours @SkipRateLimit() (the probes)', async () => {
    expect(await guard.canActivate(ctx({}, true))).toBe(true);
    expect(consume).not.toHaveBeenCalled();
  });

  it('reserves the address slot it took, and the post-auth guard refunds it exactly once', async () => {
    const req: Record<symbol, unknown> = {};
    await guard.canActivate(ctx({}, false, req));

    const reservation = req[PRE_AUTH_RESERVATION] as PreAuthReservation;
    expect(reservation).toMatchObject({ key: 'PRE_AUTH:ip:203.0.113.7', settled: false });
    expect(typeof reservation.id).toBe('string');

    const refund = vi.fn().mockResolvedValue(undefined);
    const log = { error: vi.fn() };
    refundPreAuthReservation({ refundRateLimit: refund } as never, log as never, req as never);
    refundPreAuthReservation({ refundRateLimit: refund } as never, log as never, req as never);
    expect(refund).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledWith('PRE_AUTH:ip:203.0.113.7', reservation.id);
  });

  it('a cache that returns no slot id leaves nothing to refund (DISABLE-style cache)', async () => {
    consume.mockResolvedValue({ allowed: true, remaining: 0, resetAt: 0 });
    const req: Record<symbol, unknown> = {};
    await guard.canActivate(ctx({}, false, req));
    expect(req[PRE_AUTH_RESERVATION]).toBeUndefined();
  });

  it('fails open on a cache outage', async () => {
    consume.mockRejectedValue(new Error('valkey down'));
    expect(await guard.canActivate(ctx({}))).toBe(true);
  });
});
