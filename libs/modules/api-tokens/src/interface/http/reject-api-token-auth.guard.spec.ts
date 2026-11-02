import { describe, expect, it } from 'vitest';
import { PermissionDeniedException, markMcpBridged } from '@platform';
import { RejectApiTokenAuthGuard } from './reject-api-token-auth.guard';

const guard = new RejectApiTokenAuthGuard();
const ctxOf = (req: Record<string, unknown>) =>
  ({
    switchToHttp: () => ({ getRequest: () => req }),
  }) as never as Parameters<RejectApiTokenAuthGuard['canActivate']>[0];

describe('RejectApiTokenAuthGuard', () => {
  it('refuses a request authenticated by an API token', () => {
    expect(() => guard.canActivate(ctxOf({ apiTokenId: 'token-1' }))).toThrow(
      PermissionDeniedException,
    );
  });

  it('refuses a request authenticated by the MCP bridge — an MCP session must not become a credential factory', () => {
    const req: Record<string, unknown> = { user: { sub: '0194a000-0000-7000-8000-0000000000aa' } };
    markMcpBridged(req);
    // the bridge carries no apiTokenId, so the token check above cannot see it; the marker can
    expect(() => guard.canActivate(ctxOf(req))).toThrow(/MCP sessions cannot create or manage/);
  });

  it('lets a session request through', () => {
    expect(guard.canActivate(ctxOf({}))).toBe(true);
  });
});
