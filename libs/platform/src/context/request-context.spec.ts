import { describe, expect, it } from 'vitest';
import { withJobContext } from '@quynhonsemiconductor/observability';
import { RequestContextService, requestContextStorage } from './request-context';

/**
 * Guards the single-store invariant.
 *
 * The observability package ships its own AsyncLocalStorage. If rova also had one,
 * HTTP requests would seed rova's store while the package's pino mixin read the
 * package's, and every request log line would quietly lose `workspaceId`, `userId`
 * and `correlationId`. Nothing throws in that world — the fields are simply absent,
 * which is why it needs a test rather than a comment.
 */
describe('request context wiring', () => {
  it('shares one store with the package, so job context and request context agree', () => {
    let seenByRally: string | undefined;

    // withJobContext writes to the PACKAGE's storage...
    void withJobContext('probe', () => {
      // ...and rova's re-exported storage must observe the same values.
      seenByRally = requestContextStorage.getStore()?.correlationId;
    });

    expect(seenByRally).toMatch(/^probe:/);
  });

  it('exposes the service reading that same store', () => {
    const service = new RequestContextService();

    void withJobContext('probe', () => {
      expect(service.getCorrelationId()).toMatch(/^probe:/);
    });
  });

  it('lets the guard populate auth context onto a job-seeded store', () => {
    // The Bearer/BFF guards call setAuthContext after the middleware (or a job)
    // has established the store; both halves must be looking at the same object.
    const service = new RequestContextService();

    void withJobContext('probe', () => {
      service.setAuthContext('ws-1', 'user-1', 'sess-1');
      expect(requestContextStorage.getStore()).toMatchObject({
        workspaceId: 'ws-1',
        userId: 'user-1',
        sessionId: 'sess-1',
      });
    });
  });
});
