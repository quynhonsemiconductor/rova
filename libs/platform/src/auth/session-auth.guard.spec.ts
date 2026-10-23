import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { markMcpBridged } from '../mcp-call-token';
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
    expect(() => guard().canActivate(ctx({ user: {} }))).toThrow(UnauthorizedException);
  });

  it('refuses a bare request.user with NO bridge marker — presence of user is not proof', () => {
    // FAILING-FIRST (delta review): the belt once admitted any `request.user` with a sub, safe
    // only by guard ordering. The proof is the bridge marker, set solely by McpPrincipalGuard
    // after consuming a call token; nothing on the wire, no future interceptor, can set it.
    const req: Record<string, unknown> = { user: { sub: USER } };
    expect(() => guard().canActivate(ctx(req))).toThrow(UnauthorizedException);
  });

  it('admits a request.user written by the MCP principal bridge (marked, no session, no token id)', () => {
    // apps/api/src/mcp consumes an in-process call token, marks the request, and writes
    // `request.user` directly; the belt passes it through, exactly as it does ApiTokenGuard's.
    const req: Record<string, unknown> = { user: { sub: USER } };
    markMcpBridged(req);
    expect(guard().canActivate(ctx(req))).toBe(true);
  });

  it('does not authenticate a @Public() route', () => {
    const req: Record<string, unknown> = {};
    expect(guard(true).canActivate(ctx(req))).toBe(true);
    expect(req).not.toHaveProperty('user');
  });
});
