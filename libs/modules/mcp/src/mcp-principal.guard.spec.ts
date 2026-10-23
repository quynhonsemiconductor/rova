import { type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { requestContextStorage } from '@quynhonsemiconductor/observability';
import { McpPrincipalGuard } from './mcp-principal.guard';
import { consumeMcpCallToken, mintMcpCallToken, MCP_CALL_TOKEN_HEADER } from './mcp-principal';

const USER = '0194a000-0000-7000-8000-0000000000aa';
const WORKSPACE = '0194a000-0000-7000-8000-000000000003';
const SESSION = 'mcp:req-1';

const ctx = (req: Record<string, unknown>): ExecutionContext =>
  ({
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => class Route {},
    switchToHttp: () => ({ getRequest: () => req }),
  }) as unknown as ExecutionContext;

const guard = (isPublic = false) =>
  new McpPrincipalGuard({
    getAllAndOverride: () => (isPublic ? true : undefined),
  } as unknown as Reflector);

const principal = { userId: USER, workspaceId: WORKSPACE, sessionId: SESSION };

/** `setRequestPrincipal` writes into this store; the request pipeline seeds it per request. */
function inRequestContext<T>(fn: () => T): T {
  return requestContextStorage.run(
    {
      workspaceId: undefined,
      userId: undefined,
      sessionId: undefined,
      correlationId: 'spec-correlation-id',
      traceparent: undefined,
    },
    fn,
  );
}

describe('McpPrincipalGuard', () => {
  it('consumes the call token into the principal the session path reads, and records it', () => {
    const req: Record<string, unknown> = {
      headers: { [MCP_CALL_TOKEN_HEADER]: mintMcpCallToken(principal) },
    };
    let recorded: Record<string, unknown> | undefined;
    inRequestContext(() => {
      expect(guard().canActivate(ctx(req))).toBe(true);
      // the request context (rate limit keying, access log) names the person too
      recorded = { ...requestContextStorage.getStore() };
    });
    expect(req['user']).toEqual({
      sub: USER,
      sessionId: SESSION,
      workspaceId: WORKSPACE,
      permissions: [],
    });
    expect(recorded).toMatchObject({ userId: USER, sessionId: SESSION, workspaceId: WORKSPACE });
  });

  it('the token is single-use: a replay carries no principal', () => {
    const token = mintMcpCallToken(principal);
    expect(consumeMcpCallToken(token)).toEqual(principal);
    expect(consumeMcpCallToken(token)).toBeUndefined();

    const req: Record<string, unknown> = { headers: { [MCP_CALL_TOKEN_HEADER]: token } };
    expect(guard().canActivate(ctx(req))).toBe(true);
    expect(req['user']).toBeUndefined();
  });

  it('an unknown or malformed token is no context; a network request cannot forge one', () => {
    for (const token of [undefined, '', 'forged.token.value', `${'A'.repeat(64)}`]) {
      const req: Record<string, unknown> = {
        headers: { [MCP_CALL_TOKEN_HEADER]: token, 'cf-access-jwt-assertion': 'forged' },
      };
      expect(guard().canActivate(ctx(req))).toBe(true);
      expect(req['user']).toBeUndefined();
    }
  });

  it('an in-process request with NO token at all is not authenticated by the guard', () => {
    const req: Record<string, unknown> = { headers: {} };
    expect(inRequestContext(() => guard().canActivate(ctx(req)))).toBe(true);
    // the guard passes through, the request stays unauthenticated: identity's SessionGuard
    // (not in this unit) answers 401 — pinned in mcp.route.spec.ts against a live app.
    expect(req['user']).toBeUndefined();
  });

  it('does not override a request an API token already authenticated', () => {
    const tokenPrincipal = {
      sub: USER,
      sessionId: 'token-1',
      workspaceId: WORKSPACE,
      permissions: [],
    };
    const req: Record<string, unknown> = {
      apiTokenId: 'token-1',
      user: tokenPrincipal,
      headers: { [MCP_CALL_TOKEN_HEADER]: mintMcpCallToken(principal) },
    };
    expect(guard().canActivate(ctx(req))).toBe(true);
    expect(req['user']).toBe(tokenPrincipal);
  });

  it('does not authenticate a @Public() route', () => {
    const req: Record<string, unknown> = {
      headers: { [MCP_CALL_TOKEN_HEADER]: mintMcpCallToken(principal) },
    };
    expect(guard(true).canActivate(ctx(req))).toBe(true);
    expect(req['user']).toBeUndefined();
  });
});
