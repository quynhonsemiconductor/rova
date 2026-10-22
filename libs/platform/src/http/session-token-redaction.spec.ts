import { describe, expect, it } from 'vitest';
import { isSessionBody, redactSessionTokens } from './session-token-redaction';

const session = {
  id: 's1',
  token: 'abc',
  userId: 'u1',
  expiresAt: '2026-10-18T00:00:00Z',
  contextId: 'w1',
};

describe('redactSessionTokens', () => {
  it('removes the token from get-session, keeping the rest', () => {
    const out = JSON.parse(
      String(redactSessionTokens(JSON.stringify({ session, user: { id: 'u1' } }))),
    );
    expect(out.session).not.toHaveProperty('token');
    expect(out.session).toMatchObject({ id: 's1', userId: 'u1', contextId: 'w1' });
    expect(out.user).toEqual({ id: 'u1' });
  });

  it('removes it from every session of list-sessions', () => {
    const out = JSON.parse(
      String(
        redactSessionTokens(JSON.stringify([session, { ...session, id: 's2', token: 'def' }])),
      ),
    );
    expect(out.map((s: Record<string, unknown>) => 'token' in s)).toEqual([false, false]);
  });

  it('leaves a token field that is not a session alone', () => {
    const body = JSON.stringify({ token: 'x', url: '/y' });
    expect(redactSessionTokens(body)).toBe(body);
  });

  it('passes through what is not JSON, and buffers', () => {
    expect(redactSessionTokens('not json "token"')).toBe('not json "token"');
    expect(redactSessionTokens(null)).toBeNull();
    expect(
      JSON.parse(String(redactSessionTokens(Buffer.from(JSON.stringify({ session }))))).session,
    ).not.toHaveProperty('token');
  });

  it('applies to exactly the two session reads', () => {
    for (const url of [
      '/api/auth/get-session',
      '/api/auth/get-session?x=1',
      '/api/auth/list-sessions',
      '/api/auth/get-session/',
    ]) {
      expect(isSessionBody(url), url).toBe(true);
    }
    for (const url of ['/api/auth/sign-out', '/api/auth/get-session-extra', '/v1/auth/me']) {
      expect(isSessionBody(url), url).toBe(false);
    }
  });
});
