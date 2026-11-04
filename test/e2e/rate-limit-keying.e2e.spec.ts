/**
 * Where the rate limits sit in the guard chain, over the real HTTP stack (`bootstrapApp`).
 *
 * Global guards run in module order: `PreAuthRateLimitModule` (address-keyed, FIRST), `ApiTokensModule`, identity's `SessionGuard`,
 * then `RateLimitModule` (user-keyed). The last one can only count what authenticated, so before the first existed a flood of
 * requests with no credential, or a sweep of guessed `rly_` tokens, was counted by nothing: 160 bad tokens were 160 x 401 and
 * 0 x 429. These pin both halves: the sweep IS limited, and the user-keyed bucket still keys by USER (two people behind one address
 * do not share DEFAULT).
 *
 * The rest of the suite runs with rate limiting off (CI sets DISABLE_RATE_LIMIT); this spec turns it on for its own app and puts it back.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { createBootstrappedApp, signIn } from './support/session';

const previous = process.env['DISABLE_RATE_LIMIT'];
let app: NestFastifyApplication;

/** A fresh visitor address per test, so the buckets of one test cannot leak into the next. */
let seq = 0;
const visitor = () => `198.51.100.${(Date.now() + ++seq) % 250}`;

beforeAll(async () => {
  process.env['DISABLE_RATE_LIMIT'] = 'false';
  app = await createBootstrappedApp();
}, 60_000);

afterAll(async () => {
  await app?.close();
  if (previous === undefined) delete process.env['DISABLE_RATE_LIMIT'];
  else process.env['DISABLE_RATE_LIMIT'] = previous;
});

const get = (headers: Record<string, string>, url = '/v1/projects') =>
  app.inject({ method: 'GET', url, headers });

describe('rate limits around authentication', () => {
  it('limits a sweep of guessed API tokens from one address (it used to be 401 forever)', async () => {
    const ip = visitor();
    // The tier allows 300 guessed tokens a minute from one address. Spend 299 of them directly, through the store the guard writes to,
    // so the window starts now. Only the next two requests cross the wire: the 300th is refused as a plain 401 and the 301st is a 429.
    // A sweep of 320 real requests could outlast the 60 s window on a slow runner and never reach the 429; this cannot.
    const cache = app.get(CacheService);
    for (let i = 0; i < 299; i++) await cache.consumeRateLimit(`PRE_AUTH_TOKEN:ip:${ip}`, 300, 60);

    const guess = (n: number) =>
      get({
        authorization: `Bearer rly_guess${String(n).padStart(3, '0')}_${'x'.repeat(40)}`,
        'cf-connecting-ip': ip,
      });
    expect((await guess(300)).statusCode, 'the 300th guess is a plain refusal').toBe(401);
    expect((await guess(301)).statusCode, 'the 301st guess is limited').toBe(429);

    // another address is not affected
    expect(
      (await get({ authorization: 'Bearer rly_guess_other', 'cf-connecting-ip': visitor() }))
        .statusCode,
    ).toBe(401);
  });

  it('keeps the authenticated bucket keyed by USER: two people behind one address do not share DEFAULT', async () => {
    const ip = visitor();
    const alice = await signIn(app, 'admin@qnsc.dev');
    const bob = await signIn(app, 'dev@qnsc.dev');
    const headers = (cookie: string) => ({ cookie, 'cf-connecting-ip': ip });
    const cache = app.get(CacheService);

    // The store the guard writes to, spent directly: 599 of DEFAULT's 600 to start the window now.
    const me = await get(headers(alice), '/v1/auth/me');
    expect(me.statusCode, me.body).toBe(200);
    const aliceId = me.json<{ id: string }>().id;
    for (let i = 0; i < 599; i++) await cache.consumeRateLimit(`DEFAULT:uid:${aliceId}`, 600, 60);

    expect((await get(headers(alice), '/v1/projects')).statusCode, 'the 600th is admitted').toBe(
      200,
    );
    expect((await get(headers(alice), '/v1/projects')).statusCode, 'the 601st is limited').toBe(
      429,
    );
    expect(
      (await get(headers(bob), '/v1/projects')).statusCode,
      "...and does not spend someone else's",
    ).toBe(200);
  });

  it('GET /v1/auth/me has its own, lower ceiling so a retry loop cannot spend DEFAULT', async () => {
    const ip = visitor();
    const bob = await signIn(app, 'dev@qnsc.dev');
    const headers = { cookie: bob, 'cf-connecting-ip': ip };
    const cache = app.get(CacheService);

    // This read spends the first AUTH_ME slot; spend 118 more so the 120th is the next request.
    const me = await get(headers, '/v1/auth/me');
    expect(me.statusCode, me.body).toBe(200);
    const bobId = me.json<{ id: string }>().id;
    for (let i = 0; i < 118; i++) await cache.consumeRateLimit(`AUTH_ME:uid:${bobId}`, 120, 60);

    expect((await get(headers, '/v1/auth/me')).statusCode, 'the 120th is admitted').toBe(200);
    const limited = await get(headers, '/v1/auth/me');
    expect(limited.statusCode, 'the 121st is limited').toBe(429);
    expect(limited.headers['retry-after'], 'and says when to try again').toBeDefined();
    // The user's DEFAULT budget is untouched by the refusal.
    expect((await get(headers, '/v1/projects')).statusCode).toBe(200);
  });

  it('PRE_AUTH is a floor under UNVERIFIED traffic only: a signed-in request gives its address slot back', async () => {
    const sharedIp = visitor();
    const alice = await signIn(app, 'admin@qnsc.dev');
    const cache = app.get(CacheService);
    for (let i = 0; i < 30; i++) {
      expect(
        (await get({ cookie: alice, 'cf-connecting-ip': sharedIp }, '/v1/auth/me')).statusCode,
      ).toBe(200);
    }
    // The guard awaits the refund before answering, so the bucket is settled here.
    const afterSignedIn = await cache.consumeRateLimit(`PRE_AUTH:ip:${sharedIp}`, 1200, 60);
    expect(afterSignedIn.remaining, '30 signed-in requests left the address bucket empty').toBe(
      1199,
    );

    // A forged cookie never reaches a principal, so its slot STAYS on the address.
    const forgedIp = visitor();
    const forged = await get(
      { cookie: '__Secure-rova.session_token=forged', 'cf-connecting-ip': forgedIp },
      '/v1/projects',
    );
    expect(forged.statusCode, 'a forged session is refused').toBe(401);
    const afterForged = await cache.consumeRateLimit(`PRE_AUTH:ip:${forgedIp}`, 1200, 60);
    expect(afterForged.remaining, 'the unverified request kept its slot').toBe(1198);
  });
});
