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
    const statuses: number[] = [];
    for (let i = 0; i < 320; i++) {
      const res = await get({
        authorization: `Bearer rly_guess${String(i).padStart(3, '0')}_${'x'.repeat(40)}`,
        'cf-connecting-ip': ip,
      });
      statuses.push(res.statusCode);
    }
    expect(
      statuses.slice(0, 300).every((s) => s === 401),
      'the first 300 are plain refusals',
    ).toBe(true);
    expect(
      statuses.slice(300).every((s) => s === 429),
      'then the address is limited',
    ).toBe(true);

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

    let aliceLimited = 0;
    for (let i = 0; i < 110; i++) {
      if ((await get(headers(alice), '/v1/auth/me')).statusCode === 429) aliceLimited += 1;
    }

    expect(aliceLimited, 'one user spending DEFAULT (100/min) is limited').toBeGreaterThan(0);
    expect(
      (await get(headers(bob), '/v1/auth/me')).statusCode,
      "...and does not spend someone else's",
    ).toBe(200);
  });
});
