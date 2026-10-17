import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JwtAuthGuard } from './jwt.guard';
import type { AuthTokenCache } from '@quynhonsemiconductor/identity';
import type { BffSessionResolver } from './bff-session-resolver';
import {
  requestContextStorage,
  type RequestContext,
  type SecurityMetrics,
} from '@quynhonsemiconductor/observability';
import { BFF_SESSION_COOKIE } from './bff-session-resolver';
import type { JwtPayload } from './jwt.strategy';

type MockReq = {
  headers: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string | undefined>;
  ip: string;
  user?: JwtPayload;
  bffSid?: string;
};

function ctxFor(req: MockReq): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const CLAIMS = {
  sub: 'user-1',
  jti: 'jti-1',
  sessionId: 'sess-1',
  workspaceId: 'ws-1',
  contextId: 'ws-1',
  permissions: [],
} as unknown as JwtPayload;

const seeded = (): RequestContext => ({
  workspaceId: undefined,
  userId: undefined,
  sessionId: undefined,
  correlationId: 'corr-1',
  traceparent: undefined,
});
/** Run `fn` inside a request context, as `enableCorrelationId` seeds one, and hand back the store. */
const inRequest = async (fn: () => Promise<unknown>): Promise<RequestContext> => {
  const store = seeded();
  await requestContextStorage.run(store, fn);
  return store;
};

describe('JwtAuthGuard — BFF session-cookie path', () => {
  let authCache: {
    isTokenDenied: ReturnType<typeof vi.fn>;
    isUserRevoked: ReturnType<typeof vi.fn>;
  };
  let resolver: {
    enabled: boolean;
    resolve: ReturnType<typeof vi.fn>;
  };
  let securityMetrics: {
    recordFailOpen: ReturnType<typeof vi.fn>;
  };
  let guard: JwtAuthGuard;
  let superCanActivate: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    authCache = {
      isTokenDenied: vi.fn().mockResolvedValue(false),
      isUserRevoked: vi.fn().mockResolvedValue(false),
    };
    resolver = {
      enabled: true,
      resolve: vi.fn().mockResolvedValue(CLAIMS),
    };
    securityMetrics = { recordFailOpen: vi.fn() };
    guard = new JwtAuthGuard(
      authCache as unknown as AuthTokenCache,
      securityMetrics as unknown as SecurityMetrics,
      resolver as unknown as BffSessionResolver,
    );
    // Neutralise the passport Bearer path so "falls through" cases are observable.
    superCanActivate = vi
      .spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate')
      .mockResolvedValue(true);
  });

  it('authenticates from the session cookie when enabled and no Bearer token', async () => {
    const req: MockReq = { headers: {}, cookies: { [BFF_SESSION_COOKIE]: 'sid-1' }, ip: '1.1.1.1' };

    const store = await inRequest(async () => {
      await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
    });

    expect(resolver.resolve).toHaveBeenCalledWith('sid-1', '1.1.1.1');
    expect(superCanActivate).not.toHaveBeenCalled();
    expect(req.user).toBe(CLAIMS);
    expect(req.bffSid).toBe('sid-1');
    // The principal is in the request context (the contract with platform-http >= 5), id and all.
    expect(store).toMatchObject({ userId: 'user-1', sessionId: 'sess-1', workspaceId: 'ws-1' });
    expect(authCache.isTokenDenied).toHaveBeenCalledWith('jti-1');
  });

  it('throws 401 when the session cannot be resolved', async () => {
    resolver.resolve.mockResolvedValue(null);
    const req: MockReq = { headers: {}, cookies: { [BFF_SESSION_COOKIE]: 'sid-x' }, ip: '1.1.1.1' };
    await expect(guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws 401 when the resolved session is on the denylist', async () => {
    authCache.isUserRevoked.mockResolvedValue(true);
    const req: MockReq = { headers: {}, cookies: { [BFF_SESSION_COOKIE]: 'sid-1' }, ip: '1.1.1.1' };
    await expect(guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('prefers the Bearer path when an Authorization header is present', async () => {
    const req: MockReq = {
      headers: { authorization: 'Bearer abc.def.ghi' },
      cookies: { [BFF_SESSION_COOKIE]: 'sid-1' },
      ip: '1.1.1.1',
      user: { jti: 'jti-b', sub: 'user-b' } as unknown as JwtPayload,
    };

    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);

    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(superCanActivate).toHaveBeenCalled();
    expect(authCache.isTokenDenied).toHaveBeenCalledWith('jti-b');
  });

  it('skips the session path entirely when the resolver is disabled', async () => {
    resolver.enabled = false;
    const req: MockReq = {
      headers: {},
      cookies: { [BFF_SESSION_COOKIE]: 'sid-1' },
      ip: '1.1.1.1',
      user: { jti: 'jti-c', sub: 'user-c' } as unknown as JwtPayload,
    };

    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);

    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(superCanActivate).toHaveBeenCalled();
  });

  it('works with no resolver bound (legacy JWT-only wiring)', async () => {
    const legacyGuard = new JwtAuthGuard(
      authCache as unknown as AuthTokenCache,
      securityMetrics as unknown as SecurityMetrics,
    );
    const req: MockReq = {
      headers: {},
      cookies: { [BFF_SESSION_COOKIE]: 'sid-1' },
      ip: '1.1.1.1',
      user: { jti: 'jti-d', sub: 'user-d' } as unknown as JwtPayload,
    };

    await expect(legacyGuard.canActivate(ctxFor(req))).resolves.toBe(true);
    expect(superCanActivate).toHaveBeenCalled();
  });
});

describe('JwtAuthGuard — the principal in the request context', () => {
  const base = () => {
    const authCache = {
      isTokenDenied: vi.fn().mockResolvedValue(false),
      isUserRevoked: vi.fn().mockResolvedValue(false),
    };
    const securityMetrics = { recordFailOpen: vi.fn() };
    return { authCache, securityMetrics };
  };
  const guardWith = (claims: unknown) => {
    const { authCache, securityMetrics } = base();
    const resolver = { enabled: true, resolve: vi.fn().mockResolvedValue(claims) };
    return new JwtAuthGuard(
      authCache as unknown as AuthTokenCache,
      securityMetrics as unknown as SecurityMetrics,
      resolver,
    );
  };
  const request = (): MockReq => ({
    headers: {},
    cookies: { [BFF_SESSION_COOKIE]: 'sid-1' },
    ip: '1.1.1.1',
  });

  it('records the API-token path too: the token id is the session id', async () => {
    const { authCache, securityMetrics } = base();
    const apiTokenResolver = {
      enabled: true,
      resolve: vi.fn().mockResolvedValue({
        sub: 'user-9',
        jti: 'tok-1',
        sessionId: 'tok-1',
        workspaceId: 'ws-9',
        apiTokenId: 'tok-1',
      }),
    };
    const guard = new JwtAuthGuard(
      authCache as unknown as AuthTokenCache,
      securityMetrics as unknown as SecurityMetrics,
      undefined,
      apiTokenResolver,
    );
    const req = { headers: { authorization: 'Bearer rly_abcdef' }, ip: '1.1.1.1' } as MockReq;
    const store = await inRequest(async () => {
      await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
    });
    expect(store).toMatchObject({ userId: 'user-9', sessionId: 'tok-1', workspaceId: 'ws-9' });
  });

  it('a principal value the context refuses never fails the request: the unchecked write is used and the class is logged', async () => {
    // A control character in the session id is refused by setRequestPrincipal.
    const guard = guardWith({ ...CLAIMS, sessionId: 'sess\n1' });
    const warn = vi.spyOn((guard as unknown as { logger: { warn: () => void } }).logger, 'warn');
    const store = await inRequest(async () => {
      await expect(guard.canActivate(ctxFor(request()))).resolves.toBe(true);
    });
    expect(store.userId).toBe('user-1');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).toContain('TypeError');
  });

  it('writes nothing outside a request context, and still authenticates', async () => {
    const guard = guardWith(CLAIMS);
    expect(requestContextStorage.getStore()).toBeUndefined();
    await expect(guard.canActivate(ctxFor(request()))).resolves.toBe(true);
    expect(requestContextStorage.getStore()).toBeUndefined();
  });

  it('logs ONE error, once per process, when there is no request context to record the principal in', async () => {
    (JwtAuthGuard as unknown as { warnedNoContext: boolean }).warnedNoContext = false;
    const guard = guardWith(CLAIMS);
    const error = vi.spyOn(
      (guard as unknown as { logger: { error: (message: string) => void } }).logger,
      'error',
    );
    await guard.canActivate(ctxFor(request()));
    await guard.canActivate(ctxFor(request()));
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('enableCorrelationId');
    // and inside a request context it says nothing
    (JwtAuthGuard as unknown as { warnedNoContext: boolean }).warnedNoContext = false;
    const quiet = guardWith(CLAIMS);
    const spy = vi.spyOn(
      (quiet as unknown as { logger: { error: (message: string) => void } }).logger,
      'error',
    );
    await inRequest(async () => {
      await quiet.canActivate(ctxFor(request()));
    });
    expect(spy).not.toHaveBeenCalled();
  });
});
