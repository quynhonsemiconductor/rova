import { describe, expect, it, vi } from 'vitest';
import { lastValueFrom, of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { CacheService } from '@quynhonsemiconductor/platform-cache';
import {
  IdempotencyInterceptor,
  hashBody,
} from '../libs/platform/src/http/idempotency.interceptor';

const KEY = 'k-1';

function request(body: unknown, headers: Record<string, string> = {}) {
  return {
    method: 'POST',
    url: '/v1/probe',
    body,
    headers: { 'idempotency-key': KEY, ...headers },
    user: { sub: 'user-1' },
    ip: '127.0.0.1',
  };
}

function context(req: object): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

function nextWith(response: unknown, spy = vi.fn()) {
  const handler: CallHandler = {
    handle: () => {
      spy();
      return of(response);
    },
  };
  return { handler, spy };
}

function interceptorWith(cache: {
  get: (key: string) => Promise<string | null>;
  set: (...args: unknown[]) => Promise<unknown>;
  del: (key: string) => Promise<unknown>;
}) {
  const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
  return new IdempotencyInterceptor({ instance: cache } as unknown as CacheService, reflector);
}

const redisKey = 'idem:user-1:POST:/v1/probe:k-1';

describe('IdempotencyInterceptor — body reuse, in-flight, cache failure', () => {
  it('replays a cached response only for the SAME body', async () => {
    const first = { ok: true, handled: 1 };
    const cache = {
      get: async () => JSON.stringify({ v: 1, hash: hashBody({ a: 1 }), response: first }),
      set: vi.fn(async () => 'OK'),
      del: vi.fn(async () => 1),
    };
    const interceptor = interceptorWith(cache);
    const { handler, spy } = nextWith({ ok: true, handled: 2 });

    await expect(
      lastValueFrom(interceptor.intercept(context(request({ a: 1 })), handler)),
    ).resolves.toEqual(first);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses the same key with a DIFFERENT body: 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const cache = {
      get: async () => JSON.stringify({ v: 1, hash: hashBody({ a: 1 }), response: { ok: true } }),
      set: vi.fn(async () => 'OK'),
      del: vi.fn(async () => 1),
    };
    const interceptor = interceptorWith(cache);
    const { handler, spy } = nextWith({ ok: true });

    await expect(
      lastValueFrom(interceptor.intercept(context(request({ a: 2 })), handler)),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', httpStatus: 422 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('answers a concurrent duplicate with 409 IDEMPOTENCY_IN_FLIGHT', async () => {
    const cache = {
      get: async () => null,
      set: vi.fn(async () => null), // SET NX lost the race
      del: vi.fn(async () => 1),
    };
    const interceptor = interceptorWith(cache);
    const { handler, spy } = nextWith({ ok: true });

    await expect(
      lastValueFrom(interceptor.intercept(context(request({ a: 1 })), handler)),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_IN_FLIGHT', httpStatus: 409 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('a cache READ failure passes through (the request runs, nothing is cached)', async () => {
    const cache = {
      get: async () => {
        throw new Error('valkey down');
      },
      set: vi.fn(async () => 'OK'),
      del: vi.fn(async () => 1),
    };
    const interceptor = interceptorWith(cache);
    const { handler, spy } = nextWith({ ok: true });

    await expect(
      lastValueFrom(interceptor.intercept(context(request({ a: 1 })), handler)),
    ).resolves.toEqual({ ok: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('a first call takes the in-flight lock, caches {v,hash,response}, and releases the lock', async () => {
    const cache = {
      get: async () => null,
      set: vi.fn(async () => 'OK'),
      del: vi.fn(async () => 1),
    };
    const interceptor = interceptorWith(cache);
    const { handler, spy } = nextWith({ ok: true });

    await lastValueFrom(interceptor.intercept(context(request({ a: 1 })), handler));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledWith(
      `${redisKey}:inflight`,
      hashBody({ a: 1 }),
      'EX',
      30,
      'NX',
    );
    expect(cache.set).toHaveBeenCalledWith(
      redisKey,
      JSON.stringify({ v: 1, hash: hashBody({ a: 1 }), response: { ok: true } }),
      'EX',
      86_400,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(cache.del).toHaveBeenCalledWith(`${redisKey}:inflight`);
  });

  it('a cache WRITE failure does not fail the request', async () => {
    const cache = {
      get: async () => null,
      set: vi.fn(async () => {
        throw new Error('valkey down');
      }),
      del: vi.fn(async () => 1),
    };
    const interceptor = interceptorWith(cache);
    const { handler } = nextWith({ ok: true });

    await expect(
      lastValueFrom(interceptor.intercept(context(request({ a: 1 })), handler)),
    ).resolves.toEqual({ ok: true });
  });
});
