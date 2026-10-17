import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { SessionAuthGuard } from './session-auth.guard';

const USER = '0194a000-0000-7000-8000-0000000000aa';
const SESSION = '0194a000-0000-7000-8000-0000000000bb';
const WORKSPACE = '0194a000-0000-7000-8000-000000000003';

const ctx = (req: Record<string, unknown>): ExecutionContext =>
  ({
    getHandler: () => () => undefined,
    getClass: () => class Route {},
    switchToHttp: () => ({ getRequest: () => req }),
  }) as unknown as ExecutionContext;

const guard = (isPublic = false) =>
  new SessionAuthGuard({
    getAllAndOverride: () => (isPublic ? true : undefined),
  } as unknown as Reflector);

describe('SessionAuthGuard', () => {
  it('turns the identity session into the principal; the workspace is the session context', () => {
    const req: Record<string, unknown> = {
      session: {
        session: { id: SESSION, contextId: WORKSPACE },
        user: { id: USER },
      },
    };
    expect(guard().canActivate(ctx(req))).toBe(true);
    expect(req['user']).toEqual({
      sub: USER,
      sessionId: SESSION,
      workspaceId: WORKSPACE,
      permissions: [],
    });
  });

  it('a session with no workspace has an empty workspaceId, never undefined or a stray value', () => {
    for (const contextId of [null, undefined, '', 'not-a-uuid']) {
      const req: Record<string, unknown> = {
        session: { session: { id: SESSION, contextId }, user: { id: USER } },
      };
      expect(guard().canActivate(ctx(req))).toBe(true);
      expect((req['user'] as { workspaceId: string }).workspaceId).toBe('');
    }
  });

  it('lets a request through that an API token already authenticated, and does not overwrite it', () => {
    const principal = {
      sub: USER,
      sessionId: 'token',
      workspaceId: WORKSPACE,
      permissions: [],
      apiTokenId: 'token',
    };
    const req: Record<string, unknown> = { user: principal, apiTokenId: 'token' };
    expect(guard().canActivate(ctx(req))).toBe(true);
    expect(req['user']).toBe(principal);
  });

  it('refuses a route that reaches it with no session and no token', () => {
    expect(() => guard().canActivate(ctx({}))).toThrow(UnauthorizedException);
    // a request.user with no apiTokenId is not an authentication
    expect(() => guard().canActivate(ctx({ user: { sub: USER } }))).toThrow(UnauthorizedException);
  });

  it('does not authenticate a @Public() route', () => {
    const req: Record<string, unknown> = {};
    expect(guard(true).canActivate(ctx(req))).toBe(true);
    expect(req).not.toHaveProperty('user');
  });
});
