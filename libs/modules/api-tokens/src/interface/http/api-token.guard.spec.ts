import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { requestContextStorage, type RequestContext } from '@quynhonsemiconductor/observability';
import { describe, expect, it, vi } from 'vitest';
import type { ApiTokensService } from '../../application/api-tokens.service';
import { ApiTokenGuard } from './api-token.guard';

const USER = '0194a000-0000-7000-8000-0000000000aa';
const TOKEN_ID = '0194a000-0000-7000-8000-0000000000bb';
const WORKSPACE = '0194a000-0000-7000-8000-000000000003';

function ctx(req: Record<string, unknown>, type = 'http'): ExecutionContext {
  return {
    getType: () => type,
    getHandler: () => () => undefined,
    getClass: () => class Route {},
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const reflector = (isPublic = false) =>
  ({ getAllAndOverride: () => (isPublic ? true : undefined) }) as unknown as Reflector;

const tokens = (verified: unknown) =>
  ({ verify: vi.fn().mockResolvedValue(verified) }) as unknown as ApiTokensService;

const VERIFIED = {
  id: TOKEN_ID,
  userId: USER,
  workspaceId: WORKSPACE,
  scopes: ['work_item:view'],
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 1000),
};

const store = (): RequestContext => ({
  workspaceId: '',
  userId: '',
  sessionId: '',
  correlationId: 'corr-1',
  traceparent: undefined,
});

describe('ApiTokenGuard', () => {
  it('leaves a request that carries no API token to SessionGuard', async () => {
    const service = tokens(VERIFIED);
    const guard = new ApiTokenGuard(service, reflector());
    for (const authorization of [undefined, 'Bearer aaa.bbb.ccc', 'Basic abc', 'Bearer ']) {
      const req = { headers: authorization ? { authorization } : {} };
      expect(await guard.canActivate(ctx(req))).toBe(true);
      expect(req).not.toHaveProperty('user');
    }
    expect(service.verify).not.toHaveBeenCalled();
  });

  it('authenticates nobody on a @Public() route, even with a valid token', async () => {
    const service = tokens(VERIFIED);
    const req: Record<string, unknown> = {
      headers: { authorization: 'Bearer rly_abcdefgh_secret' },
    };
    expect(await new ApiTokenGuard(service, reflector(true)).canActivate(ctx(req))).toBe(true);
    expect(service.verify).not.toHaveBeenCalled();
    expect(req).not.toHaveProperty('user');
  });

  it('answers one 401 for every unusable token (unknown, expired, revoked, forged)', async () => {
    const guard = new ApiTokenGuard(tokens(null), reflector());
    const req = { headers: { authorization: 'Bearer rly_abcdefgh_secret' } };
    await expect(guard.canActivate(ctx(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('writes the principal, marks the request pre-authenticated WITH the user id, and records it in the request context', async () => {
    const guard = new ApiTokenGuard(tokens(VERIFIED), reflector());
    const req: Record<string | symbol, unknown> = {
      headers: { authorization: 'Bearer rly_abcdefgh_secret' },
    };
    const ctxStore = store();

    await requestContextStorage.run(ctxStore, async () => {
      expect(await guard.canActivate(ctx(req))).toBe(true);
    });

    expect(req['user']).toEqual({
      sub: USER,
      workspaceId: WORKSPACE,
      sessionId: TOKEN_ID,
      permissions: [],
      apiTokenId: TOKEN_ID,
      scopes: ['work_item:view'],
    });
    expect(req['apiTokenId']).toBe(TOKEN_ID);
    // The identity SessionGuard reads this symbol; the user id on it is what its ban check runs on.
    const mark = Object.getOwnPropertySymbols(req)
      .map((s) => req[s])
      .find((v) => typeof v === 'object' && v !== null && 'userId' in v);
    expect(mark).toEqual({ userId: USER });
    expect(ctxStore.userId).toBe(USER);
    expect(ctxStore.sessionId).toBe(TOKEN_ID);
  });

  it('still authenticates when there is no request context (the principal is just not recorded)', async () => {
    const guard = new ApiTokenGuard(tokens(VERIFIED), reflector());
    const req = { headers: { authorization: 'Bearer rly_abcdefgh_secret' } };
    expect(await guard.canActivate(ctx(req))).toBe(true);
    expect(req).toHaveProperty('user.sub', USER);
  });

  it('does nothing outside HTTP', async () => {
    const service = tokens(VERIFIED);
    expect(await new ApiTokenGuard(service, reflector()).canActivate(ctx({}, 'rpc'))).toBe(true);
    expect(service.verify).not.toHaveBeenCalled();
  });
});
