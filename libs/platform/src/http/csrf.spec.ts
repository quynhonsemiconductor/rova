import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../auth/session-cookie';
import { requiresCsrfProtection } from './csrf';

/**
 * The CSRF policy is one pure predicate precisely so it can be pinned here.
 * Before this, the plugin was registered but never attached, so "is CSRF on?" had
 * no answer anywhere in the codebase or the test suite.
 */
describe('requiresCsrfProtection', () => {
  const sessionCookies = { [SESSION_COOKIE]: 'sid-1' };

  const req = (over: Partial<Parameters<typeof requiresCsrfProtection>[0]> = {}) => ({
    method: 'POST',
    url: '/v1/work-items',
    headers: {} as Record<string, string | string[] | undefined>,
    cookies: sessionCookies as Record<string, string | undefined>,
    ...over,
  });

  it('protects a cookie-authenticated state-changing request', () => {
    expect(requiresCsrfProtection(req())).toBe(true);
  });

  it.each(['GET', 'HEAD', 'OPTIONS', 'TRACE', 'get', 'head'])('skips safe method %s', (method) => {
    expect(requiresCsrfProtection(req({ method }))).toBe(false);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('protects unsafe method %s', (method) => {
    expect(requiresCsrfProtection(req({ method }))).toBe(true);
  });

  it('skips Bearer-authenticated requests', () => {
    // A caller that attaches a token by hand cannot be driven by an attacker's
    // page, so demanding a second token would only break machine clients.
    expect(requiresCsrfProtection(req({ headers: { authorization: 'Bearer abc.def.ghi' } }))).toBe(
      false,
    );
  });

  it('recognises a Bearer header regardless of case or padding', () => {
    expect(requiresCsrfProtection(req({ headers: { authorization: '  bEaReR tok' } }))).toBe(false);
  });

  it('still protects when the Authorization header is not a Bearer token', () => {
    expect(requiresCsrfProtection(req({ headers: { authorization: 'Basic abc' } }))).toBe(true);
  });

  it('skips requests with no session cookie — there is no ambient credential to forge', () => {
    expect(requiresCsrfProtection(req({ cookies: {} }))).toBe(false);
    expect(requiresCsrfProtection(req({ cookies: undefined }))).toBe(false);
  });

  it.each([
    '/api/auth/sign-in/social',
    '/api/auth/sign-out',
    '/api/auth/context/set',
    '/v1/scm/webhook',
    '/v1/scm/webhook/github',
  ])('exempts %s', (url) => {
    // identity's own surface runs before a session exists (Better Auth enforces its own Origin check there); the
    // webhook is called by GitHub with an HMAC signature, never by a browser.
    expect(requiresCsrfProtection(req({ url }))).toBe(false);
  });

  it('ignores the query string when matching exempt paths', () => {
    expect(requiresCsrfProtection(req({ url: '/api/auth/sign-in/social?returnTo=/home' }))).toBe(
      false,
    );
  });

  it('does not exempt a path that merely starts with an exempt prefix', () => {
    // `/api/authx` must NOT ride on the `/api/auth/...` exemption.
    expect(requiresCsrfProtection(req({ url: '/api/authx/sign-out' }))).toBe(true);
    expect(requiresCsrfProtection(req({ url: '/v1/scm/webhooks-admin' }))).toBe(true);
  });

  it('pins the session cookie name identity issues', () => {
    expect(SESSION_COOKIE).toBe('__Secure-rova.session_token');
  });
});
