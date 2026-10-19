/**
 * ONE reset for the whole BE e2e run: truncate the delivery tables, then re-seed the two fixtures.
 *
 * Why this exists. Every `afterAll` in the suite closed the Nest app and cleaned NOTHING — 37 files,
 * zero teardown — while the files between them called `createProject` 84 times per run. So a dev
 * database grew by ~84 projects and their whole graph on every pass, forever. Two consequences, both
 * observed:
 *
 *   • `portfolio_items.rank` is `varchar(255)` and new ranks are derived by appending, so at ~1,900
 *     items the longest rank hit exactly 255 characters and EVERY subsequent insert failed with
 *     `value too long for type character varying(255)`. The suite could not run at all until the
 *     database was dropped by hand. That happened twice.
 *   • Tests read each other's leftovers. A list assertion that was true on a clean database becomes
 *     order-dependent once fifty other projects exist, and the failure surfaces in an unrelated file.
 *
 * Truncate rather than per-test teardown: teardown has to unwind foreign keys in the right order in
 * every file that creates anything, which is exactly the discipline that never held. One `TRUNCATE
 * ... CASCADE` at the start of the run is a single place to be correct.
 *
 * What is NOT truncated: `identity.*`, `access.*` and `workspace.*`. Users, roles, grants and the
 * workspace itself are the ground the fixtures stand on, `bootstrap.ts` reconciles them idempotently,
 * and dropping a role would take its assignments — including the per-project grants specs arrange
 * through `grantProjectAccess`.
 *
 * THE CACHE HAS TO GO TOO, and that is not obvious. `AccessService.effectiveAssignments` caches a
 * user's resolved grants in Valkey under `authz:assign:<workspace>:<user>` for five minutes. The
 * truncate restores the DATABASE and says nothing to the cache, so for five minutes after any run
 * the suite answers authorization questions from the PREVIOUS run's state.
 *
 * That is not theoretical: it was found by a spec that granted `dev@qnsc.dev` `access_level:'admin'`
 * on NXP. The reset put the row back to `editor`, and the very next spec still resolved `admin` and
 * was served a roster an Editor must be refused — a false PASS on an access-control assertion, which
 * is the worst direction for this class of test to be wrong in. Flushing here makes each run start
 * from the database it just seeded.
 */
import { Redis } from 'ioredis';
import { resetFixtureTables } from '../../../db/seeds/reset';

export default async function setup(): Promise<void> {
  // Deliberately opt-out-able: a developer bisecting one failing file may want the database left
  // exactly as it is. Default is to reset, because the default should be the correct thing.
  if (process.env.E2E_SKIP_RESET === 'true') return;

  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('E2E reset needs DATABASE_URL (or DATABASE_MIGRATION_URL).');

  // ONE table list, shared with `pnpm db:seed:test` (`db/seeds/reset.ts`). Two lists would drift, and
  // the suite would then run against a database shaped differently from a developer's.
  await resetFixtureTables(url);

  // Re-seed AFTER the truncate, in this process, so the first test file starts against the same two
  // projects a developer sees locally. Imported lazily: the seed opens its own pool and reads env,
  // and doing that at module load would run it even when the reset is skipped.
  const { seed } = await import('../../../db/seeds/seed');
  // `seed()` takes an optional connection URL and loads the FULL fixture set (both projects plus the
  // reference extras) — the same entry point `pnpm db:seed:test` uses, so the suite and a developer's
  // local database cannot drift apart.
  await seed(url);

  await flushPermissionCache();
}

/**
 * Drop every cached permission resolution, so the suite reads the database it just seeded.
 *
 * `FLUSHDB`, not a `SCAN` + `DEL` over `authz:assign:*`: the cache primitive is free to prefix its
 * keys, and a pattern that silently matches nothing would leave exactly the staleness this is here
 * to remove while looking like it worked. Everything in this database is derived — permission
 * resolutions, rate-limit counters, BFF sessions — and the e2e suite mints its own bearer tokens
 * through `AuthService.devLogin`, so none of it is state a test depends on surviving.
 *
 * Never fatal. If Valkey is down the suite should fail on the assertion that needs it, with that
 * spec's own message, rather than on an opaque error in global setup — and `AccessService` degrades
 * to the database on a cache miss, so a flush that did not happen costs correctness only for the
 * five-minute TTL, which is the situation this function improves rather than guarantees.
 */
async function flushPermissionCache(): Promise<void> {
  const redisUrl = process.env.VALKEY_URL ?? process.env.REDIS_URL;
  if (!redisUrl) return;

  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    await redis.flushdb();
  } catch (err) {
    // stderr directly, not console.warn: `no-console` is an error-level rule in this repo, and a
    // setup diagnostic is exactly the case it exists to keep out of application code.
    process.stderr.write(
      `[e2e] permission-cache flush failed (${String(err)}). Specs may read grants cached by an ` +
        `earlier run for up to 5 minutes.\n`,
    );
  } finally {
    redis.disconnect();
  }
}
