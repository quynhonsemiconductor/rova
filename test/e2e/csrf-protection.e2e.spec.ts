/**
 * End-to-end proof that CSRF protection is actually ENFORCED.
 *
 * Flow: none. Security infrastructure, like `sso-rbac.e2e.spec.ts` — it underpins
 * every business flow but proves no single one. Recorded explicitly so the
 * coverage matrix can tell "deliberately not a flow" from "untraced".
 *
 * The defect this pins: `@fastify/csrf-protection` was registered in
 * `app.bootstrap.ts` but its `csrfProtection` hook was never attached and no token
 * was ever issued, so the plugin protected nothing. The only thing stopping a
 * cross-site request was `SameSite=Strict` on the session cookie — a single
 * control that a future cookie tweak could silently remove, with no test failing.
 *
 * These specs boot the REAL `AppModule` **through `bootstrapApp`** (so the CSRF
 * hook, the `/v1` prefix and the cookie plugins are all live) and drive real HTTP
 * via `app.inject()`. They assert the enforcement, the session binding, and the
 * two deliberate exemptions.
 *
 * Prereqs: docker deps up (`docker compose -f docker-compose.dev.yml up -d`) and
 * the DB seeded (`pnpm db:seed`).
 */
import 'reflect-metadata';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, CSRF_SECRET_COOKIE } from '@platform';
import { AppModule } from '../../apps/api/src/app.module';
import { bootstrapApp } from '../../apps/api/src/bootstrap/app.bootstrap';

/**
 * Seeded developer account (db/seeds/demo.ts). Any active seeded user works — the
 * spec asserts CSRF behaviour, not authorization. Read from the seed rather than
 * hardcoded twice: the fixture domain moved from acme.dev to qnsc.dev on main and
 * this spec broke, so prefer the env override the seed itself honours.
 */
const SEEDED_EMAIL = process.env['E2E_SEEDED_EMAIL'] ?? 'dev@qnsc.dev';
// The origin the API trusts: CORS_ORIGINS of the env this run loaded (an isolated stack's own web port), else the schema default.
const TRUSTED_ORIGIN = process.env['CORS_ORIGINS'] ?? 'http://localhost:5173';

interface Session {
  /** Cookie header value carrying both the session id and the CSRF secret. */
  cookie: string;
  csrfToken: string;
}

describe('CSRF protection is enforced (real AppModule + bootstrapApp)', () => {
  let app: NestFastifyApplication;

  /** Pull one cookie's value out of a set-cookie header list. */
  function readCookie(setCookie: string | string[] | undefined, name: string): string | undefined {
    const all = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    for (const raw of all) {
      const [pair] = raw.split(';');
      const [key, ...rest] = pair.split('=');
      if (key.trim() === name) return rest.join('=');
    }
    return undefined;
  }

  /**
   * Sign in over HTTP via identity's test-login, then call /v1/auth/me to obtain the
   * CSRF token and the secret cookie it plants — exactly the sequence the SPA runs
   * on start.
   */
  async function signIn(): Promise<Session> {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/test-login',
      payload: { email: SEEDED_EMAIL },
    });
    expect(login.statusCode).toBe(200);

    const sid = readCookie(login.headers['set-cookie'], SESSION_COOKIE);
    expect(sid).toBeDefined();

    const me = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: `${SESSION_COOKIE}=${sid}` },
    });
    expect(me.statusCode).toBe(200);

    const csrfSecret = readCookie(me.headers['set-cookie'], CSRF_SECRET_COOKIE);
    expect(csrfSecret).toBeDefined();

    const { csrfToken } = me.json();
    expect(csrfToken).toBeTruthy();

    return {
      cookie: `${SESSION_COOKIE}=${sid}; ${CSRF_SECRET_COOKIE}=${csrfSecret}`,
      csrfToken: csrfToken!,
    };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // The CSRF hook lives in bootstrapApp, so a test that skips it proves nothing.
    await bootstrapApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('issues a session-bound CSRF token and the signed secret cookie from /v1/auth/me', async () => {
    const session = await signIn();
    expect(session.csrfToken).toMatch(/./);
  });

  it('rejects a cookie-authenticated POST with no CSRF token', async () => {
    const session = await signIn();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout-all',
      headers: { cookie: session.cookie },
    });

    // Before the fix this was a 204: the request succeeded with no token at all.
    // The plugin's FST_CSRF_INVALID_TOKEN is normalised to FORBIDDEN by the global
    // exception filter, so assert on the message it preserves.
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('Invalid csrf token');
  });

  it('accepts the same POST when the token is presented', async () => {
    const session = await signIn();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout-all',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
    });

    expect(res.statusCode).toBe(204);
  });

  it('rejects a token minted for a DIFFERENT session', async () => {
    // `userInfo` binds each token to the session that requested it, so a token
    // lifted from another session (or another user) is useless here.
    const victim = await signIn();
    const attacker = await signIn();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout-all',
      headers: { cookie: victim.cookie, 'x-csrf-token': attacker.csrfToken },
    });

    expect(res.statusCode).toBe(403);
  });

  it('rejects a garbage token', async () => {
    const session = await signIn();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout-all',
      headers: { cookie: session.cookie, 'x-csrf-token': 'not-a-real-token' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('does not require a token on a safe method', async () => {
    const session = await signIn();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: session.cookie },
    });

    expect(res.statusCode).toBe(200);
  });

  it("exempts identity's own surface (/api/auth/*), which runs before any session exists", async () => {
    // Sign-in is a POST with no CSRF token; a CSRF 403 here would make login impossible. Better Auth enforces its own
    // Origin check on this surface. With the session cookie PRESENT (the case the CSRF gate would otherwise catch) a
    // sign-out must reach identity, not be refused by our gate.
    const session = await signIn();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { cookie: session.cookie, origin: TRUSTED_ORIGIN },
      payload: {},
    });

    expect(res.statusCode).not.toBe(403);
    expect(res.body).not.toContain('Invalid csrf token');
  });

  it('leaves Bearer-authenticated requests untouched by the CSRF gate', async () => {
    // No ambient credential, so no CSRF exposure — machine clients must not be
    // forced to fetch a browser token. A bogus Bearer fails auth (401), NOT CSRF.
    // (A real `rly_` token is covered by api-tokens.e2e.spec.ts.)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout-all',
      headers: { authorization: 'Bearer not.a.real.token' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('csrf');
  });
});
