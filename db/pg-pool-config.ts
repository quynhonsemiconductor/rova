/**
 * The pool configuration node-postgres receives: a connection string (and TLS), from `DATABASE_URL` or composed
 * from the discrete `DATABASE_*` parts. See `database-url.ts` for the two ways to supply it and `pg-ssl.ts` for TLS.
 *
 * THERE IS NO IAM AUTHENTICATION HERE ANY MORE. This used to carry a second mode (`DATABASE_AUTH=iam`) that minted
 * an RDS IAM token per connection, for a Kubernetes estate on RDS with IRSA. The on-prem estate runs CloudNativePG,
 * whose roles have ordinary passwords from a Secret, so the mode had no consumer: it was ~250 lines (a token
 * signer, a per-connection password callback, a URL-with-token builder) and a dependency on `@aws-sdk/rds-signer`,
 * all unreachable. If RDS IAM auth is ever wanted again, it is in git history (`db/pg-iam.ts`).
 */
import { resolveDatabaseUrl, type DatabaseUrlParts } from './database-url';
import { pgOptions, type PgTlsInput } from './pg-ssl';

export type PoolConnectionConfig = ReturnType<typeof pgOptions>;

/** The TLS input rides alongside the URL parts: `DATABASE_SSL_CA` opts into verification. */
export type DatabaseConfigEnv = DatabaseUrlParts & { DATABASE_SSL_CA?: string; NODE_ENV?: string };

export function resolvePoolConfig(env: DatabaseConfigEnv = process.env): PoolConnectionConfig {
  return pgOptions(resolveDatabaseUrl(env), tlsInput(env));
}

/**
 * The MIGRATION connection.
 *
 * `DATABASE_MIGRATION_URL` wins when set: the escape hatch for a privileged credential supplied by hand. Otherwise
 * this is the ordinary resolution.
 *
 * Note which role that is: the deployed migrator's `DATABASE_USER` is `<product>_migrate`, never the application
 * role, whose `statement_timeout` would kill a long migration and whose rights do not include DDL.
 */
function tlsInput(env: { DATABASE_SSL_CA?: string; NODE_ENV?: string }): PgTlsInput {
  return { caFile: env.DATABASE_SSL_CA, isProduction: env.NODE_ENV === 'production' };
}

/**
 * Session timeouts (ms) for the migration connection, sent as startup parameters so they bind before the
 * first statement and win over any role default.
 *
 * `lock_timeout` 5 s: an `ALTER TABLE` waits in the lock queue behind a long runtime query (the worker
 * role allows 300 s) and, while it waits, every later query on that table queues behind IT. Failing
 * after 5 s turns that stall into a clean Job failure the GitOps retry handles. `statement_timeout`
 * 10 min: a runaway statement must not hold the PreSync hook (and the deploy) forever, yet an index
 * build on a real table fits. Both are overridable for a one-off heavy migration.
 */
export const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 5_000;
export const DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS = 600_000;

export type MigrationTimeoutEnv = {
  MIGRATION_LOCK_TIMEOUT_MS?: string;
  MIGRATION_STATEMENT_TIMEOUT_MS?: string;
};

function positiveMs(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} must be a positive integer number of milliseconds (got "${raw}")`);
  }
  return Number(raw);
}

export function resolveMigrationTimeouts(env: MigrationTimeoutEnv = process.env): {
  lock_timeout: number;
  statement_timeout: number;
} {
  return {
    lock_timeout: positiveMs(
      'MIGRATION_LOCK_TIMEOUT_MS',
      env.MIGRATION_LOCK_TIMEOUT_MS,
      DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
    ),
    statement_timeout: positiveMs(
      'MIGRATION_STATEMENT_TIMEOUT_MS',
      env.MIGRATION_STATEMENT_TIMEOUT_MS,
      DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS,
    ),
  };
}

export function resolveMigrationPoolConfig(
  env: DatabaseConfigEnv & { DATABASE_MIGRATION_URL?: string } & MigrationTimeoutEnv = process.env,
): PoolConnectionConfig & ReturnType<typeof resolveMigrationTimeouts> {
  const connection = env.DATABASE_MIGRATION_URL
    ? pgOptions(env.DATABASE_MIGRATION_URL, tlsInput(env))
    : resolvePoolConfig(env);
  return { ...connection, ...resolveMigrationTimeouts(env) };
}
