/**
 * The pool configuration node-postgres actually receives.
 *
 * This exists because IAM authentication and URL-based authentication cannot share a
 * shape. A URL carries its credential INSIDE the string, fixed at the moment it is
 * built; an IAM token must be produced per connection by a callback. `pg` supports
 * both, but not at once — so the choice is made here, in one place, rather than
 * discovered at the call site.
 *
 * ── THE TWO MODES ──────────────────────────────────────────────────────────────
 *
 *   DATABASE_AUTH=password  (default)  Unchanged legacy behaviour: DATABASE_URL, or
 *                                      the discrete parts composed into a URL. Used
 *                                      by local dev, CI, and the ECS estate.
 *
 *   DATABASE_AUTH=iam                  Discrete parts with NO password. The password
 *                                      is a callback that mints an RDS IAM token per
 *                                      connection. Used by the Kubernetes estate.
 *
 * WHY THE DEFAULT IS `password`. The ECS estate is still serving production and its
 * task definitions supply `DATABASE_PASSWORD` from the RDS-managed secret. A default
 * of `iam` would change the behaviour of every running task the moment this ships.
 * The new estate opts IN explicitly, which is also what makes this safe to merge
 * before anything is cut over.
 */
import { resolveDatabaseUrl, type DatabaseUrlParts } from './database-url';
import { iamPasswordProvider } from './pg-iam';
import { pgOptions } from './pg-ssl';

export type DatabaseAuthMode = 'password' | 'iam';

export interface PoolAuthParts extends DatabaseUrlParts {
  DATABASE_AUTH?: string;
  AWS_REGION?: string;
}

/**
 * A `pg` PoolConfig subset. `password` is deliberately a union: `pg` accepts a
 * function and calls it once per connection, which is the only mechanism that keeps
 * a 15-minute token valid in a process that runs for weeks.
 */
export interface PoolConnectionConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string | (() => Promise<string>);
  ssl?: { rejectUnauthorized: false };
}

function requiredForIam(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Database configuration incomplete: ${name} is required when DATABASE_AUTH=iam. ` +
        'IAM authentication composes the connection from discrete parts and mints the ' +
        'credential per connection, so DATABASE_HOST, DATABASE_PORT, DATABASE_NAME and ' +
        'DATABASE_USER must all be set. DATABASE_PASSWORD is NOT used.',
    );
  }
  return value;
}

export function resolveAuthMode(env: PoolAuthParts = process.env): DatabaseAuthMode {
  const raw = env.DATABASE_AUTH?.trim().toLowerCase();
  if (!raw || raw === 'password') return 'password';
  if (raw === 'iam') return 'iam';
  throw new Error(`DATABASE_AUTH must be "password" or "iam", received "${env.DATABASE_AUTH}".`);
}

export function resolvePoolConfig(env: PoolAuthParts = process.env): PoolConnectionConfig {
  if (resolveAuthMode(env) === 'password') {
    return pgOptions(resolveDatabaseUrl(env));
  }

  // A URL carries a password; IAM mode has none. Being handed both means two
  // conflicting intents, and the one that would silently win is whichever this code
  // happens to check first. Failing here is the only outcome that cannot surprise.
  if (env.DATABASE_URL) {
    throw new Error(
      'DATABASE_AUTH=iam and DATABASE_URL are mutually exclusive: a URL embeds a static ' +
        'password, which IAM authentication replaces. Supply the discrete DATABASE_* parts ' +
        'and leave DATABASE_URL unset.',
    );
  }

  const host = requiredForIam('DATABASE_HOST', env.DATABASE_HOST);
  const port = Number(requiredForIam('DATABASE_PORT', env.DATABASE_PORT?.toString()));
  const database = requiredForIam('DATABASE_NAME', env.DATABASE_NAME);
  const user = requiredForIam('DATABASE_USER', env.DATABASE_USER);
  const region = env.AWS_REGION ?? 'ap-southeast-1';

  return {
    host,
    port,
    database,
    user,
    password: iamPasswordProvider({ hostname: host, port, username: user, region }),
    // NOT OPTIONAL, AND NOT THE SAME DECISION AS pg-ssl's. RDS REJECTS an IAM-token
    // handshake on an unencrypted connection, so this is a correctness requirement
    // rather than the hardening choice it is in password mode. `rejectUnauthorized`
    // stays false for the reason pg-ssl.ts documents: the Alpine base image has no
    // Amazon RDS CA bundle, so verification fails with SELF_SIGNED_CERT_IN_CHAIN.
    // Traffic is encrypted either way and never leaves the VPC.
    ssl: { rejectUnauthorized: false },
  };
}
