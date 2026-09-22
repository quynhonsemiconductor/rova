/**
 * IAM authentication for RDS Postgres.
 *
 * WHY THIS EXISTS AT ALL. The estate's product databases are created with roles that
 * are members of `rds_iam` and have NO password:
 *
 *     rolname       | rolcanlogin | rds_iam
 *     rova          | t           | t
 *     rova_migrator | t           | t
 *
 * A role in `rds_iam` cannot authenticate by password — Postgres delegates the check
 * to RDS, which accepts only a signed token. So there was no password to put in
 * `DATABASE_PASSWORD`, no valid `DATABASE_URL` to put in Secrets Manager, and the
 * application could not reach its database by ANY route. This module is the missing
 * half of that design, not a new feature.
 *
 * WHAT A TOKEN IS. A 15-minute, SigV4-signed string used in place of a password. It
 * is derived locally from the caller's credentials — minting one is a signing
 * operation, NOT a network call to AWS — so this is cheap and cannot fail from an
 * API outage. It CAN fail if the pod has no usable credentials, which under IRSA
 * means the service account annotation or the role trust policy is wrong.
 *
 * ── WHY `password` IS A FUNCTION AND NOT A STRING ──────────────────────────────
 *
 * The 15-minute lifetime is the whole problem. A token read once at startup works,
 * then stops working roughly a quarter of an hour later — and it stops working only
 * for connections opened AFTER it expires. Existing connections are unaffected,
 * because the token authenticates the HANDSHAKE and nothing re-checks it afterwards.
 *
 * That failure mode is vicious: a healthy pod serves traffic indefinitely on its warm
 * pool, and then fails only when it needs to grow the pool or replace a reaped
 * connection — i.e. under load, or after an idle period, and never in a test. It
 * presents as intermittent `28P01` under exactly the conditions that make it hardest
 * to reproduce.
 *
 * node-postgres accepts `password` as a function returning a promise and calls it
 * ONCE PER CONNECTION, at connect time. That is precisely the hook required: every
 * connection gets a token minted moments before it is used, and the TTL stops being
 * something this code has to track, refresh, or get wrong. There is no timer here
 * and deliberately so — a refresh timer is a second clock to fall out of step with
 * the one that matters.
 *
 * DO NOT "optimise" this into a cached string with a refresh interval. The cache
 * below is bounded to a few seconds for connection STORMS only, which is a different
 * problem with a different safe answer.
 */
import { Signer } from '@aws-sdk/rds-signer';

export interface IamTokenOptions {
  hostname: string;
  port: number;
  username: string;
  region: string;
}

/**
 * How long a minted token may be reused.
 *
 * Tokens are valid for 15 minutes, so this could be far larger — and MUST NOT BE.
 * The point of this cache is a connection storm: a pool warming 10 connections, or
 * a rollout starting several replicas, would otherwise sign 10 tokens within the
 * same millisecond for no benefit. Five seconds collapses that to one signature.
 *
 * Keeping the window this short means the cache can never be the reason a stale
 * token is presented: even a clock skew measured in minutes cannot make a
 * five-second-old token expired. The long TTL stays unexploited on purpose — it is
 * the margin that makes this safe, not headroom to be spent.
 */
const TOKEN_REUSE_MS = 5_000;

/**
 * THE CACHED VALUE IS A PROMISE, NOT A TOKEN, and that distinction is the whole
 * point of this cache rather than an implementation detail.
 *
 * Caching the resolved string only ever de-duplicates SEQUENTIAL callers. A pool
 * warming ten connections opens them concurrently: all ten find an empty cache in
 * the same tick, all ten sign, and all ten then write their own result. The cache
 * appears to work in every sequential test and does nothing whatsoever in the one
 * situation it was added for.
 *
 * Storing the in-flight promise makes the ten callers await ONE signing operation.
 * A rejected promise is evicted below, so a transient credential failure is never
 * held and replayed to later connections.
 */
interface CacheEntry {
  token: Promise<string>;
  mintedAt: number;
}

/**
 * Keyed by the full connection identity, not just the host: the app role and the
 * migrator role connect to the SAME host and must never share a token, because the
 * token encodes the username it was signed for. A host-only key would hand the
 * migrator's token to the app role and fail with a signature error that names
 * neither role.
 */
const cache = new Map<string, CacheEntry>();

function cacheKey(o: IamTokenOptions): string {
  return `${o.region}|${o.hostname}|${o.port}|${o.username}`;
}

/**
 * Mint (or briefly reuse) an RDS IAM auth token.
 *
 * Exported for tests and for the migrator, which needs a token embedded in a URL
 * rather than supplied through a callback. Prefer `iamPasswordProvider` in
 * long-lived processes.
 */
export async function getIamAuthToken(options: IamTokenOptions): Promise<string> {
  const key = cacheKey(options);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.mintedAt < TOKEN_REUSE_MS) return hit.token;

  const signer = new Signer({
    hostname: options.hostname,
    port: options.port,
    username: options.username,
    region: options.region,
  });

  // No network call — this is a local SigV4 signing operation over the caller's
  // credentials. It rejects when there are NO resolvable credentials, which under
  // IRSA means the projected token is missing or the role trust is wrong.
  //
  // The promise is cached BEFORE it is awaited: that is what makes concurrent
  // callers share one signature instead of racing.
  const pending = signer.getAuthToken();
  cache.set(key, { token: pending, mintedAt: Date.now() });

  try {
    return await pending;
  } catch (error) {
    // Never hold a failure. Keeping it would turn one transient credential error
    // into five seconds of guaranteed connection failures.
    if (cache.get(key)?.token === pending) cache.delete(key);
    throw error;
  }
}

/**
 * The value to hand to node-postgres as `password`.
 *
 * pg calls this once per new connection. Errors propagate as connection errors,
 * which is correct: a pod that cannot sign a token must fail its readiness probe
 * rather than serve requests that will fail at the first query.
 */
export function iamPasswordProvider(options: IamTokenOptions): () => Promise<string> {
  return () => getIamAuthToken(options);
}

/** Reset the reuse cache. Tests only. */
export function __resetIamTokenCache(): void {
  cache.clear();
}
