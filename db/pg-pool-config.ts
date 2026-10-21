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

export function resolveMigrationPoolConfig(
  env: DatabaseConfigEnv & { DATABASE_MIGRATION_URL?: string } = process.env,
): PoolConnectionConfig {
  if (env.DATABASE_MIGRATION_URL) return pgOptions(env.DATABASE_MIGRATION_URL, tlsInput(env));
  return resolvePoolConfig(env);
}
