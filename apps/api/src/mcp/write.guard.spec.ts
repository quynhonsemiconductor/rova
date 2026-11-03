import { describe, expect, it } from 'vitest';
import { type ExecutionContext } from '@nestjs/common';
import { AppConfigService, markMcpBridged, PermissionDeniedException } from '@platform';
import { McpWriteGuard } from './write.guard';
import { mcpWriteRouteKey } from './write-policy';

interface FakeRequest {
  method?: string;
  routeOptions?: { url?: string };
}

function contextFor(request: FakeRequest): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function configWith(writesEnabled: boolean): AppConfigService {
  return {
    get: (key: string) => (key === 'MCP_WRITES_ENABLED' ? writesEnabled : undefined),
  } as unknown as AppConfigService;
}

/** A bridged request, as McpPrincipalGuard leaves it after consuming a live call token. */
function bridged(request: FakeRequest): FakeRequest {
  markMcpBridged(request);
  return request;
}

const ROUTES = new Set([mcpWriteRouteKey('POST', '/v1/work-items')]);

describe('McpWriteGuard (REST-side belt for MCP writes)', () => {
  it('leaves a request that is NOT MCP-bridged alone — the web and API tokens are not narrowed', () => {
    const guard = new McpWriteGuard(configWith(false), ROUTES);
    expect(
      guard.canActivate(contextFor({ method: 'POST', routeOptions: { url: '/v1/projects' } })),
    ).toBe(true);
  });

  it('allows an MCP-bridged GET even with writes off', () => {
    const guard = new McpWriteGuard(configWith(false), ROUTES);
    const req = bridged({ method: 'GET', routeOptions: { url: '/v1/work-items' } });
    expect(guard.canActivate(contextFor(req))).toBe(true);
  });

  it('refuses an MCP-bridged write while MCP_WRITES_ENABLED is off', () => {
    const guard = new McpWriteGuard(configWith(false), ROUTES);
    const req = bridged({ method: 'POST', routeOptions: { url: '/v1/work-items' } });
    expect(() => guard.canActivate(contextFor(req))).toThrow(PermissionDeniedException);
  });

  it('refuses a bridged write to a route not on the allowlist, even with writes on', () => {
    const guard = new McpWriteGuard(configWith(true), ROUTES);
    const req = bridged({ method: 'DELETE', routeOptions: { url: '/v1/projects/:id' } });
    expect(() => guard.canActivate(contextFor(req))).toThrow(PermissionDeniedException);
  });

  it('allows a bridged write that matches the allowlist by METHOD + route template', () => {
    const guard = new McpWriteGuard(configWith(true), ROUTES);
    const req = bridged({ method: 'post', routeOptions: { url: '/v1/work-items' } });
    expect(guard.canActivate(contextFor(req))).toBe(true);
  });

  it('does not guess: no matched route template is refused', () => {
    const guard = new McpWriteGuard(configWith(true), ROUTES);
    const req = bridged({ method: 'POST' });
    expect(() => guard.canActivate(contextFor(req))).toThrow(PermissionDeniedException);
  });

  it('names the refusal with a stable code and no catalogue detail', () => {
    const guard = new McpWriteGuard(configWith(true), ROUTES);
    const req = bridged({ method: 'DELETE', routeOptions: { url: '/v1/projects/:id' } });
    try {
      guard.canActivate(contextFor(req));
      expect.unreachable('expected a refusal');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('MCP_WRITE_NOT_ALLOWED');
    }
  });
});
