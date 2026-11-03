import { beforeEach, describe, expect, it } from 'vitest';
import { APP_GUARD } from '@nestjs/core';
import { type ExecutionContext } from '@nestjs/common';
import {
  markMcpBridged,
  MCP_CALL_TOKEN_HEADER,
  mintMcpCallToken,
  PermissionDeniedException,
} from '@platform';
import { McpWriteGuard } from './write.guard';
import { McpPrincipalGuard } from './principal.guard';
import { McpModule } from './mcp.module';
import { mcpReadRouteKey, mcpWriteRouteKey, setMcpWritesEnabled } from './write-policy';

interface FakeRequest {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  routeOptions?: { url?: string };
}

function contextFor(request: FakeRequest): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/** A bridged request, as McpPrincipalGuard leaves it after consuming a live call token. */
function bridged(request: FakeRequest): FakeRequest {
  markMcpBridged(request);
  return request;
}

/** A live token as the transport mints it — never consumed, as on a @Public route. */
function liveTokenHeader(): Record<string, string> {
  return {
    [MCP_CALL_TOKEN_HEADER]: mintMcpCallToken({
      userId: '0194a000-0000-7000-8000-0000000000aa',
      workspaceId: '0194a000-0000-7000-8000-000000000003',
      sessionId: 'mcp:guard',
    }),
  };
}

const READS = new Set([mcpReadRouteKey('/v1/work-items'), mcpReadRouteKey('/v1/projects')]);
const WRITES = new Set([mcpWriteRouteKey('POST', '/v1/work-items')]);

describe('McpWriteGuard (REST-side belt for MCP writes)', () => {
  beforeEach(() => setMcpWritesEnabled(false));

  it('leaves a request that is NOT MCP-bridged alone — the web and API tokens are not narrowed', () => {
    const guard = new McpWriteGuard(READS, WRITES);
    expect(
      guard.canActivate(contextFor({ method: 'POST', routeOptions: { url: '/v1/projects' } })),
    ).toBe(true);
  });

  it('fails CLOSED for a @Public route that skips the principal guard (token still live)', () => {
    setMcpWritesEnabled(true);
    const guard = new McpWriteGuard(READS, WRITES);
    // NOT marked bridged: the principal guard returns early on a public route, so the token is
    // never consumed. A carried live token is still proof this request came from MCP.
    const req: FakeRequest = {
      method: 'POST',
      headers: liveTokenHeader(),
      routeOptions: { url: '/v1/scm/webhook/:provider' },
    };
    expect(() => guard.canActivate(contextFor(req))).toThrow(PermissionDeniedException);
  });

  it('still allows a public GET that carries a live token', () => {
    const guard = new McpWriteGuard(READS, WRITES);
    const req: FakeRequest = {
      method: 'GET',
      headers: liveTokenHeader(),
      routeOptions: { url: '/v1/projects' },
    };
    expect(guard.canActivate(contextFor(req))).toBe(true);
  });

  it('fails closed on a GET to a route outside the READ allowlist', () => {
    const guard = new McpWriteGuard(READS, WRITES);
    const req = bridged({ method: 'GET', routeOptions: { url: '/v1/audit-logs' } });
    expect(() => guard.canActivate(contextFor(req))).toThrow(PermissionDeniedException);
  });

  it('registers the guards in order: principal first, write gate second', () => {
    const providers = Reflect.getMetadata('providers', McpModule) as Array<{
      provide?: unknown;
      useClass?: unknown;
    }>;
    const guards = providers.filter((p) => p.provide === APP_GUARD).map((p) => p.useClass);
    expect(guards).toEqual([McpPrincipalGuard, McpWriteGuard]);
  });

  it('allows an MCP-bridged GET even with writes off', () => {
    const guard = new McpWriteGuard(READS, WRITES);
    const req = bridged({ method: 'GET', routeOptions: { url: '/v1/work-items' } });
    expect(guard.canActivate(contextFor(req))).toBe(true);
  });

  it('refuses an MCP-bridged write while MCP_WRITES_ENABLED is off', () => {
    const guard = new McpWriteGuard(READS, WRITES);
    const req = bridged({ method: 'POST', routeOptions: { url: '/v1/work-items' } });
    expect(() => guard.canActivate(contextFor(req))).toThrow(PermissionDeniedException);
  });

  it('refuses a bridged write to a route not on the allowlist, even with writes on', () => {
    setMcpWritesEnabled(true);
    const guard = new McpWriteGuard(READS, WRITES);
    const req = bridged({ method: 'DELETE', routeOptions: { url: '/v1/projects/:id' } });
    expect(() => guard.canActivate(contextFor(req))).toThrow(PermissionDeniedException);
  });

  it('allows a bridged write that matches the allowlist by METHOD + route template', () => {
    setMcpWritesEnabled(true);
    const guard = new McpWriteGuard(READS, WRITES);
    const req = bridged({ method: 'post', routeOptions: { url: '/v1/work-items' } });
    expect(guard.canActivate(contextFor(req))).toBe(true);
  });

  it('does not guess: no matched route template is refused', () => {
    setMcpWritesEnabled(true);
    const guard = new McpWriteGuard(READS, WRITES);
    const req = bridged({ method: 'POST' });
    expect(() => guard.canActivate(contextFor(req))).toThrow(PermissionDeniedException);
  });

  it('names the refusal with a stable code and no catalogue detail', () => {
    setMcpWritesEnabled(true);
    const guard = new McpWriteGuard(READS, WRITES);
    const req = bridged({ method: 'DELETE', routeOptions: { url: '/v1/projects/:id' } });
    try {
      guard.canActivate(contextFor(req));
      expect.unreachable('expected a refusal');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('MCP_WRITE_NOT_ALLOWED');
    }
  });
});
