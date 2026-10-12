/**
 * The three columns that let a relay hold a row without holding a transaction.
 *
 * A relay CLAIMS rows in a short transaction (`attempts = attempts + 1`, a fresh `lease_token`,
 * `locked_until = now() + lease`), calls the outside world with no transaction open, and FINISHES in a
 * new one fenced on `lease_token`. See `libs/platform/src/outbox/abstract-outbox-relay.ts`.
 *
 * Before this the relay opened one transaction, locked a batch `FOR UPDATE SKIP LOCKED`, made every
 * external call inside it and committed at the end. The worker's database role has
 * `idle_in_transaction_session_timeout = 300s` (migration 0073); a call that outlasted it had its SESSION
 * killed, which rolled back the whole batch AND its attempt counters, so the row never reached
 * `maxAttempts`, never dead-lettered, and was retried for ever.
 *
 *   seq          claim order. A bigserial, so it is assigned in insert order and is the unique tie-breaker
 *                the ordering ratchet requires.
 *   lease_token  who holds the row; NULL when nobody does.
 *   locked_until when the hold lapses; NULL when nobody holds it.
 */
import { bigserial, timestamp, uuid } from 'drizzle-orm/pg-core';

export const outboxLease = () => ({
  seq: bigserial('seq', { mode: 'number' }).notNull(),
  leaseToken: uuid('lease_token'),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
});
