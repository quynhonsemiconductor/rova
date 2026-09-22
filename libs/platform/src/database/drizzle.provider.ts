import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import * as schema from '../../../../db/schema';
import { resolvePoolConfig } from '../../../../db/pg-pool-config';
import { DbPoolMetrics } from '@quynhonsemiconductor/observability';

export const DRIZZLE = Symbol('DRIZZLE');

export type DrizzleDB = ReturnType<typeof drizzle<typeof schema>>;
export type DrizzleTx = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

/**
 * A database executor — either the root connection or an open transaction.
 *
 * Repository methods accept an optional `DbExecutor` so they can enlist in a
 * caller-owned transaction (Unit of Work).  When omitted they fall back to the
 * injected root `DrizzleDB`, preserving the simple single-statement path.
 */
export type DbExecutor = DrizzleDB | DrizzleTx;

export const InjectDrizzle = () => Inject(DRIZZLE);

@Injectable()
export class DrizzleProvider implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DrizzleProvider.name);
  private pool: Pool;
  private db: DrizzleDB;

  constructor(
    private readonly config: AppConfigService,
    poolMetrics: DbPoolMetrics,
  ) {
    this.pool = new Pool({
      // Composed from DATABASE_* parts when no complete URL is supplied, so the
      // deployed path reads the RDS-managed secret directly and never holds a
      // copy of a rotating password. See db/database-url.ts.
      // UNDER DATABASE_AUTH=iam THIS SUPPLIES `password` AS A FUNCTION, which pg calls
      // once per connection. See db/pg-iam.ts for why a string cannot work: a token
      // lives 15 minutes, and a pod that read one at startup fails only later, only
      // when the pool grows, and never in a test.
      ...resolvePoolConfig({
        DATABASE_AUTH: config.get('DATABASE_AUTH'),
        DATABASE_URL: config.get('DATABASE_URL'),
        DATABASE_HOST: config.get('DATABASE_HOST'),
        DATABASE_PORT: config.get('DATABASE_PORT'),
        DATABASE_NAME: config.get('DATABASE_NAME'),
        DATABASE_USER: config.get('DATABASE_USER'),
        DATABASE_PASSWORD: config.get('DATABASE_PASSWORD'),
        DATABASE_SSLMODE: config.get('DATABASE_SSLMODE'),
        AWS_REGION: config.get('AWS_REGION'),
      }),
      // `min` DOES NOT PRE-CREATE CONNECTIONS, and this option used to be here on the
      // belief that it did. Read pg-pool's source before changing it back: in
      // pg-pool@3.14.0 the value is touched in exactly three places —
      // `this.options.min = this.options.min || 0` in the constructor, and
      // `_isAboveMin() { return this._clients.length > this.options.min }`, which is
      // consulted only by the idle-timeout reaper (`if (this.options.idleTimeoutMillis
      // && this._isAboveMin())`). Nothing anywhere dials out to reach `min`. A fresh
      // pool therefore starts with ZERO clients whatever this says, which is why the
      // warm-up in `onModuleInit` below exists.
      //
      // It is nevertheless KEPT, for the reaping behaviour it really does govern, and
      // that behaviour is what makes the warm-up worth anything. Production serves a
      // measured 1-4 requests/day against `idleTimeoutMillis: 30_000`; without a
      // floor, the connections `onModuleInit` opens would be reaped 30 seconds after
      // boot and the next request — the following morning — would pay the full TCP +
      // TLS + SCRAM handshake again on a 0.25 vCPU task. `min` is what pins the warm
      // clients in place between requests. Dropping it and keeping only the warm-up
      // would fix the first request after a deploy and nothing else.
      min: config.get('DATABASE_POOL_MIN'),
      max: config.get('DATABASE_POOL_MAX'),
      // Fail fast on idle connections to surface misconfiguration
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    this.db = drizzle(this.pool, { schema, logger: config.get('LOG_SQL') });

    // Pool saturation is the usual cause of a latency cliff: requests queue for a
    // connection while every individual query still looks fast. Registered as a
    // pull-based gauge, so OTel reads the live pool at collection time and there is
    // no timer here to own or to fall out of step with the export interval.
    poolMetrics.register(() => ({
      inUse: this.pool.totalCount - this.pool.idleCount,
      waiting: this.pool.waitingCount,
    }));
  }

  get instance(): DrizzleDB {
    return this.db;
  }

  /**
   * Open `DATABASE_POOL_MIN` connections BEFORE the process accepts traffic.
   *
   * WHY THIS IS NEEDED AT ALL. `min` on `new Pool` does not do it — see the note on
   * that option above for the pg-pool source that proves it. So a freshly started
   * task had an empty pool, and nothing in the admission path noticed: the ALB target
   * group health-checks `/v1/healthz`, which returns 200 without touching a
   * dependency (deliberately — see the REDIS_URL note in env.schema.ts), so the task
   * was registered and serving before it had ever spoken to RDS. The first real
   * request then paid TCP + TLS + SCRAM authentication to RDS on a 256-CPU-unit
   * (0.25 vCPU) task. At the measured production volume of 1-4 requests/day that one
   * cold request IS the p99, and `api.min_count = 1` means every deploy replaces the
   * only task and re-arms it.
   *
   * WHY THIS SEAM. Nest awaits every `onModuleInit` inside `app.init()`, and
   * `NestApplication.listen()` calls `await this.init()` before it binds the socket
   * (@nestjs/core 11.1.27, `nest-application.js`: `init()` runs `await
   * this.callInitHook()` ahead of `registerRouterHooks()`, and `listen()` opens with
   * `if (!this.isInitialized) await this.init()`). `apps/api/src/main.ts` goes
   * straight from `bootstrapApp(app)` to `app.listen(...)` and never calls `init()`
   * itself, so the ordering holds and main.ts needs no change. Warming from main.ts
   * instead was the alternative and was rejected: it would have to reach into the
   * provider for its pool, and the worker (`createApplicationContext`, no listen at
   * all) would get no warm-up despite draining outboxes on the same cold pool.
   *
   * WHY A FAILURE IS ONLY A WARNING. The deploy pipeline gates on `/v1/readyz`, which
   * does check the database, so a genuinely broken database still fails the deploy and
   * rolls back. Throwing here would add nothing to that and would convert a slow or
   * briefly unreachable dependency — an RDS failover, a transient DNS blip — into a
   * boot crash loop, taking the task down for a condition it would have recovered
   * from in seconds. A cold pool is a latency problem; refusing to boot is an outage.
   *
   * The clients are all acquired BEFORE any is released, on purpose. Releasing each
   * one before requesting the next hands the same physical connection back to
   * `pool.connect()` every time, so the loop would "warm" one connection N times.
   */
  async onModuleInit(): Promise<void> {
    const target = this.config.get('DATABASE_POOL_MIN');
    const startedAt = Date.now();

    // allSettled, not all: a partial failure must still release the clients that DID
    // open, or they are leaked for the process lifetime and count against `max`.
    const results = await Promise.allSettled(
      Array.from({ length: target }, () => this.pool.connect()),
    );

    const failures: unknown[] = [];
    let opened = 0;
    for (const result of results) {
      if (result.status === 'fulfilled') {
        opened += 1;
        result.value.release();
      } else {
        failures.push(result.reason);
      }
    }

    const durationMs = Date.now() - startedAt;
    if (failures.length > 0) {
      this.logger.warn({
        msg: 'Database pool warm-up incomplete — continuing boot; first requests may be slow',
        target,
        opened,
        durationMs,
        err: failures[0],
      });
      return;
    }

    this.logger.log({ msg: 'Database pool warmed', opened, durationMs });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
