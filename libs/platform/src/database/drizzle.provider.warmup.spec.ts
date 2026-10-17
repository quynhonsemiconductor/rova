import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { DrizzleProvider } from './drizzle.provider';
import type { AppConfigService } from '../config/app-config.service';
import type { DbPoolMetrics } from '@quynhonsemiconductor/observability';

/**
 * These cover the POOL WARM-UP, and the first case is the reason the rest exist.
 *
 * `new Pool({ min })` does not open connections. pg-pool touches the value in three
 * places only — the `|| 0` default in its constructor, and `_isAboveMin()`, which
 * only the idle-timeout reaper consults — so a fresh pool starts at zero clients
 * however `min` is configured. Since `/v1/healthz` answers 200 without touching a
 * dependency, the ALB admitted a task in that state and its first real request paid
 * TCP + TLS + SCRAM to RDS on a 0.25 vCPU task. At 1-4 requests/day that request was
 * the p99.
 *
 * Named `drizzle.provider.warmup.spec.ts` rather than `drizzle.provider.spec.ts` on
 * purpose: `test/coverage-include.spec.ts` requires every spec whose subject file
 * exists to be listed in `vitest.config.ts`'s coverage `include`, and this change is
 * scoped to `libs/**`, `apps/**` and `package.json`. A variant name is the escape
 * hatch that file documents (`*.workspace-isolation.spec.ts` and friends), so the
 * ratchet stays honest instead of being worked around.
 */

const POOL_MIN = 3;
const POOL_MAX = 20;

const config = {
  get: (k: string) =>
    (
      ({
        DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
        DATABASE_HOST: undefined,
        DATABASE_PORT: undefined,
        DATABASE_NAME: undefined,
        DATABASE_USER: undefined,
        DATABASE_PASSWORD: undefined,
        DATABASE_SSLMODE: 'disable',
        DATABASE_POOL_MIN: POOL_MIN,
        DATABASE_POOL_MAX: POOL_MAX,
        LOG_SQL: false,
      }) as Record<string, unknown>
    )[k],
} as unknown as AppConfigService;

const poolMetrics = { register: vi.fn() } as unknown as DbPoolMetrics;

/**
 * A pool stand-in that records the ORDER of connect/release, which is the property
 * the warm-up depends on: releasing each client before requesting the next hands the
 * same physical connection back every time, so the loop would warm one connection N
 * times and the test would still see N calls.
 */
function fakePool(behaviour: (n: number) => 'ok' | 'fail' = () => 'ok') {
  const events: string[] = [];
  let n = 0;
  return {
    events,
    releasedCount: () => events.filter((e) => e === 'release').length,
    connect: () => {
      const i = ++n;
      events.push('connect');
      if (behaviour(i) === 'fail') {
        return Promise.reject(new Error(`connect ${i} refused`));
      }
      return Promise.resolve({
        release: () => {
          events.push('release');
        },
      });
    },
  };
}

function withFakePool(provider: DrizzleProvider, fake: ReturnType<typeof fakePool>): void {
  (provider as unknown as { pool: unknown }).pool = fake;
}

describe('DrizzleProvider — pool configuration', () => {
  let provider: DrizzleProvider;

  beforeEach(() => {
    provider = new DrizzleProvider(config, poolMetrics);
  });

  it('starts with ZERO clients despite a positive min — the defect the warm-up exists for', () => {
    const pool = (provider as unknown as { pool: Pool }).pool;

    // pg-pool's own view of its configuration …
    expect((pool as unknown as { options: { min: number } }).options.min).toBe(POOL_MIN);
    // … and yet nothing has been opened. If a future pg-pool DOES pre-create from
    // `min`, this assertion fails and the warm-up can be reconsidered.
    expect(pool.totalCount).toBe(0);
    expect(pool.idleCount).toBe(0);
  });

  it('still passes min, because it governs idle reaping', () => {
    const options = (provider as unknown as { pool: { options: Record<string, unknown> } }).pool
      .options;

    // Kept deliberately: at 1-4 requests/day with idleTimeoutMillis 30s, a pool with
    // no floor would reap the warmed clients half a minute after boot and the next
    // request would be cold again. Removing `min` must fail a test, not pass review.
    expect(options.min).toBe(POOL_MIN);
    expect(options.max).toBe(POOL_MAX);
    expect(options.idleTimeoutMillis).toBe(30_000);
  });
});

describe('DrizzleProvider.onModuleInit — warm-up', () => {
  let provider: DrizzleProvider;

  beforeEach(() => {
    provider = new DrizzleProvider(config, poolMetrics);
  });

  it('opens DATABASE_POOL_MIN connections and releases every one', async () => {
    const fake = fakePool();
    withFakePool(provider, fake);

    await provider.onModuleInit();

    expect(fake.events.filter((e) => e === 'connect')).toHaveLength(POOL_MIN);
    expect(fake.releasedCount()).toBe(POOL_MIN);
  });

  it('acquires every client BEFORE releasing any', async () => {
    const fake = fakePool();
    withFakePool(provider, fake);

    await provider.onModuleInit();

    // All connects, then all releases. A connect appearing after the first release
    // means the loop is serial and re-warmed one connection N times.
    expect(fake.events).toEqual([
      ...Array<string>(POOL_MIN).fill('connect'),
      ...Array<string>(POOL_MIN).fill('release'),
    ]);
  });

  it('does not crash boot when the database is unreachable', async () => {
    const fake = fakePool(() => 'fail');
    withFakePool(provider, fake);
    const warn = vi.spyOn((provider as unknown as { logger: { warn: () => void } }).logger, 'warn');

    // A hard throw here would turn a slow or failing-over dependency into a boot
    // crash loop. The deploy pipeline gates on /v1/readyz, which DOES check the
    // database, so a genuinely broken database still fails the deploy.
    await expect(provider.onModuleInit()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('releases the clients that DID open when only some fail', async () => {
    // First succeeds, the rest are refused.
    const fake = fakePool((n) => (n === 1 ? 'ok' : 'fail'));
    withFakePool(provider, fake);

    await provider.onModuleInit();

    // Leaking the successful one would hold a connection for the process lifetime
    // and count against `max` forever.
    expect(fake.releasedCount()).toBe(1);
  });

  it('logs at LOG, not WARN, when the pool warms completely', async () => {
    const fake = fakePool();
    withFakePool(provider, fake);
    const logger = (provider as unknown as { logger: { warn: () => void; log: () => void } })
      .logger;
    const warn = vi.spyOn(logger, 'warn');
    const log = vi.spyOn(logger, 'log');

    await provider.onModuleInit();

    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });
});
