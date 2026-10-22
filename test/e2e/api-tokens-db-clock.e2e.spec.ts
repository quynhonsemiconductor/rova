/**
 * API token expiry, last-use and revocation are decided and stamped on the DATABASE clock.
 *
 * The rule (QNSC architecture, "Time"): the database clock is the only clock for stored data. Host time is
 * allowed for in-process timeouts, rate-limit windows, logs and metrics, never for an expiry compared with a
 * stored timestamp, and never for a value written into a timestamp column.
 *
 * The skew. `vi.setSystemTime` moves the HOST clock only (`toFake: ['Date']`). The database keeps the real
 * time. So each test below sets the host ~100 days away from the database and asserts what the database says:
 *
 *   - host AHEAD by 100 days: a token valid by database time must still verify. The 90-day token looks
 *     expired to a host-clock check, so on main this fails with 401.
 *   - host BEHIND by 100 days: a token expired by database time must be refused. On main the host thinks
 *     it has 100 days left, so this fails with 200.
 *   - last-used, revoked_at and the minted expires_at must be within minutes of the database's now(), not
 *     100 days off. On main each is written from the host clock, so each assertion fails.
 *
 * "Expired" is made by moving the row's own expires_at in the database (`now() - 1 minute`), because the
 * database clock is the one that has to move.
 */
import 'reflect-metadata';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { DRIZZLE, SESSION_COOKIE, type DrizzleDB } from '@platform';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { apiTokens } from '../../db/schema/identity';
import { AppModule } from '../../apps/api/src/app.module';
import { signInAs } from './support/session';

const PROBE_ROUTE = '/audit-logs';
const ADMIN_EMAIL = 'admin@qnsc.dev';
const HUNDRED_DAYS_MS = 100 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const NINETY_DAYS_S = 90 * 24 * 60 * 60;
/** Generous: the database and the test runner share a machine, and the stamp only has to be near the DB clock. */
const DB_NEAR_SECONDS = 300;

describe('API token expiry, last-use and revocation on the database clock (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DrizzleDB;

  function headersFor(credential: string): Record<string, string> {
    return credential.startsWith(`${SESSION_COOKIE}=`)
      ? { cookie: credential }
      : { authorization: `Bearer ${credential}` };
  }

  function withAuth(credential: string) {
    const headers = headersFor(credential);
    return {
      get: (url: string) => app.inject({ method: 'GET', url, headers }),
      post: (url: string, payload: Record<string, unknown>) =>
        app.inject({ method: 'POST', url, headers, payload }),
      delete: (url: string) => app.inject({ method: 'DELETE', url, headers }),
    };
  }

  async function sessionFor(email: string): Promise<string> {
    const { credential } = await signInAs(app, email);
    expect(credential, `test-login for ${email}`).toBeTruthy();
    return credential;
  }

  async function mint(session: string, name: string): Promise<{ id: string; token: string }> {
    const response = await withAuth(session).post('/me/api-tokens', { name });
    expect(response.statusCode, response.body).toBe(201);
    return JSON.parse(response.body) as { id: string; token: string };
  }

  /** Move the HOST clock only. The database clock is untouched, which is the whole point. */
  function skewHostBy(ms: number): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + ms);
  }

  /** The database's own view of a token row: seconds from database now() to each stored instant. */
  async function dbView(id: string) {
    const [row] = await db
      .select({
        lastUsedAt: apiTokens.lastUsedAt,
        revokedAt: apiTokens.revokedAt,
        lifetimeSeconds: sql<number>`extract(epoch from (${apiTokens.expiresAt} - now()))`,
        lastUsedLagSeconds: sql<number>`extract(epoch from (now() - ${apiTokens.lastUsedAt}))`,
        revokedLagSeconds: sql<number>`extract(epoch from (now() - ${apiTokens.revokedAt}))`,
      })
      .from(apiTokens)
      .where(eq(apiTokens.id, id))
      .limit(1);
    return row;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get<DrizzleDB>(DRIZZLE);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('a token valid by DATABASE time still verifies when the host clock is 100 days ahead', async () => {
    const session = await sessionFor(ADMIN_EMAIL);
    const created = await mint(session, 'db-clock valid');

    skewHostBy(HUNDRED_DAYS_MS);

    const probe = await withAuth(created.token).get(PROBE_ROUTE);
    expect(probe.statusCode, probe.body).toBe(200);
  });

  it('a token expired by DATABASE time is refused when the host clock is 100 days behind', async () => {
    const session = await sessionFor(ADMIN_EMAIL);
    const created = await mint(session, 'db-clock expired');

    // Expired by the database's clock: its own expires_at is in the database past.
    await db
      .update(apiTokens)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(apiTokens.id, created.id));

    // The host thinks it is 100 days earlier, so a host-clock check would call the token live.
    skewHostBy(-HUNDRED_DAYS_MS);

    const refused = await withAuth(created.token).get(PROBE_ROUTE);
    expect(refused.statusCode, refused.body).toBe(401);
  });

  it('a token expired by DATABASE time is refused when the host clock is 100 days ahead too', async () => {
    // Not a regression guard on its own: a host clock ahead also says "expired". Kept so the ahead-skew
    // case refuses the expired token as well as accepting the valid one.
    const session = await sessionFor(ADMIN_EMAIL);
    const created = await mint(session, 'db-clock expired ahead');
    await db
      .update(apiTokens)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(apiTokens.id, created.id));

    skewHostBy(HUNDRED_DAYS_MS);

    const refused = await withAuth(created.token).get(PROBE_ROUTE);
    expect(refused.statusCode, refused.body).toBe(401);
  });

  it('mints an expiry that is the database clock plus the lifetime, not the host clock plus it', async () => {
    // Signed in AFTER the skew: an identity session is itself stamped and checked against the host clock, so
    // one made before the skew would be refused for reasons this test is not about.
    skewHostBy(HUNDRED_DAYS_MS);
    const session = await sessionFor(ADMIN_EMAIL);
    const created = await mint(session, 'db-clock mint');

    const view = await dbView(created.id);
    // 90 days from database now(). On main the host clock wrote a value 100 days later than that.
    expect(Math.abs(Number(view.lifetimeSeconds) - NINETY_DAYS_S)).toBeLessThan(DB_NEAR_SECONDS);
  });

  it('stamps last-used with the database clock, not the host clock', async () => {
    const session = await sessionFor(ADMIN_EMAIL);
    const created = await mint(session, 'db-clock last-used');

    // One day, not 100: this case is about the last-used stamp and its throttle, not expiry. A day is still
    // far outside DB_NEAR_SECONDS, so a host-stamped last_used_at fails the assertion below.
    skewHostBy(ONE_DAY_MS);
    expect((await withAuth(created.token).get(PROBE_ROUTE)).statusCode).toBe(200);

    // The write is fire-and-forget by design, so wait for it to land rather than assume it has.
    let view = await dbView(created.id);
    for (let attempt = 0; attempt < 50 && view.lastUsedAt === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      view = await dbView(created.id);
    }

    expect(view.lastUsedAt).not.toBeNull();
    expect(Math.abs(Number(view.lastUsedLagSeconds))).toBeLessThan(DB_NEAR_SECONDS);
  });

  it('stamps revocation with the database clock, not the host clock', async () => {
    // Signed in after the skew, for the same reason as the mint case above.
    skewHostBy(HUNDRED_DAYS_MS);
    const session = await sessionFor(ADMIN_EMAIL);
    const created = await mint(session, 'db-clock revoke');

    const revoked = await withAuth(session).delete(`/me/api-tokens/${created.id}`);
    expect(revoked.statusCode, revoked.body).toBe(204);

    const view = await dbView(created.id);
    expect(view.revokedAt).not.toBeNull();
    expect(Math.abs(Number(view.revokedLagSeconds))).toBeLessThan(DB_NEAR_SECONDS);
  });
});
