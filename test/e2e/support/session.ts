/**
 * Sign in to the REAL API over HTTP, the way every authorization spec needs to.
 *
 * Nothing is stubbed. A session comes from identity 8's `POST /api/auth/test-login`, which loads only when
 * `IDENTITY_TEST_LOGIN=enabled` AND `NODE_ENV` is exactly `test` or `development` (identity refuses to boot otherwise), so a
 * spec authenticates as a real seeded user with a real session row, the real session cookie and real permission
 * resolution (`PolicyGuard` reads the database per request). It replaces `AuthService.devLogin` and `AuthService.ssoLogin`
 * of identity 7, which minted a JWT: there is no bearer JWT any more, the cookie is the credential.
 *
 * The credential is the cookie's `name=value` pair, ready for a `cookie` request header. The specs that build their app
 * with `Test.createTestingModule` have no CSRF hook (that is `bootstrapApp`'s), so a state-changing request needs no token
 * here; the specs that DO boot `bootstrapApp` and assert CSRF fetch it themselves from `GET /v1/auth/me`.
 */
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { SESSION_COOKIE } from '@platform';
import { WorkspaceService } from '@modules/workspace';
import { UserDirectory } from '@modules/identity';
import { WORKSPACE_ID } from '../../../db/seeds/constants';
import { AppModule } from '../../../apps/api/src/app.module';
import { bootstrapApp } from '../../../apps/api/src/bootstrap/app.bootstrap';
import { SSO_EMAIL_DOMAIN } from './sso-env';

/** Pull one cookie's `name=value` pair out of a `set-cookie` header (string or list). */
export function readCookie(
  setCookie: string | string[] | undefined,
  name: string,
): string | undefined {
  const all = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const raw of all) {
    const [pair] = raw.split(';');
    const [key] = pair.split('=');
    if (key.trim() === name) return pair.trim();
  }
  return undefined;
}

/**
 * Sign in as a user that already exists in `identity."user"` (the seeded fixtures mirror every profile there, with the same
 * id) and return the session cookie pair. Throws instead of returning a half-session: a spec that silently continued
 * unauthenticated would assert a 401/403 and pass for the wrong reason.
 */
export async function signIn(app: NestFastifyApplication, email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/test-login',
    payload: { email },
  });
  const cookie = readCookie(res.headers['set-cookie'], SESSION_COOKIE);
  if (res.statusCode !== 200 || !cookie) {
    throw new Error(
      `test-login failed for ${email}: ${res.statusCode} ${res.body}. ` +
        'Is the database seeded (`pnpm db:seed`)? Is IDENTITY_TEST_LOGIN=enabled, and NODE_ENV test?',
    );
  }
  return cookie;
}

/** The id of the signed-in user, read from the same test-login response. */
export async function signInAs(
  app: NestFastifyApplication,
  email: string,
): Promise<{ credential: string; userId: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test-login', payload: { email } });
  const credential = readCookie(res.headers['set-cookie'], SESSION_COOKIE);
  if (res.statusCode !== 200 || !credential) {
    throw new Error(`test-login failed for ${email}: ${res.statusCode} ${res.body}`);
  }
  return { credential, userId: res.json<{ user: { id: string } }>().user.id };
}

/**
 * A fresh, DEDICATED principal: identity user + profile (same id) + an active home-workspace membership, signed in AFTER
 * it is a member so the session starts in the workspace (`context.initial`). The replacement for identity 7's
 * `ssoLogin(JIT claims)` that specs used to mint a user to grant things to: granting a level to a shared fixture user is a
 * lasting edit that survives until the next reset and changes what later specs see.
 */
export async function provisionUser(
  app: NestFastifyApplication,
  label: string,
  displayName = `E2E ${label}`,
): Promise<{ userId: string; email: string; credential: string; accessToken: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@${SSO_EMAIL_DOMAIN}`;
  // 1. identity creates the user (a new uuidv7)...
  const created = await signInAs(app, email);
  // 2. ...the product gives it a profile with the SAME id and a seat in the home workspace...
  await app.get(UserDirectory).insertProfile({ id: created.userId, email, displayName });
  await app.get(WorkspaceService).enrollMember(WORKSPACE_ID, created.userId);
  // 3. ...and the session that counts is the one created once it is a member.
  const { credential } = await signInAs(app, email);
  // `accessToken` is `credential` under the name the converted specs already read.
  return { userId: created.userId, email, credential, accessToken: credential };
}

/**
 * The API exactly as `main.ts` boots it: `bootstrapApp` is the same function, so the helmet headers, the cookie plugin, the
 * ONE CSRF hook, CORS, `enableCorrelationId` (the request context the rate limit and the access log read the principal from)
 * and the `/v1` prefix are all present. The specs that build with `Test.createTestingModule` have none of them: use this one
 * when the thing under test depends on any (CSRF, the principal in the request context, the `/v1` routes).
 */
export async function createBootstrappedApp(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false, trustProxy: true }),
    { bufferLogs: true, logger: false, abortOnError: false },
  );
  await bootstrapApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
