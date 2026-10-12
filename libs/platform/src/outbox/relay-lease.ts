/**
 * Lease arithmetic for outbox relays.
 *
 * A relay's lease on a row must outlast the longest `deliver` for it, or another relay takes the row
 * mid-call and the call is made twice. The longest `deliver` is its external calls × their per-call
 * deadline, so the lease is DERIVED from the same constants that bound the calls rather than written down as
 * a second number that can drift away from them.
 *
 * Calls here go through `ResilienceService`, whose presets retry. cockatiel's `maxAttempts` is the RETRY
 * count, not the total (`retries < maxAttempts`), so `3` means four executions, and each execution is capped
 * by the preset's timeout. The worst case of one resilient call is therefore `(maxAttempts + 1) × timeout`
 * plus the (sub-second) jittered backoff, which the margin absorbs.
 */
import { RESILIENCE_PRESETS } from '../resilience/resilience.presets';
import type { ResiliencePreset } from '../resilience/resilience.types';

/** Added to every lease: database round trips, scheduling, bulkhead queueing, jittered backoff. */
export const LEASE_MARGIN_MS = 60_000;

/** The rows' hold is `batchSize × lease`; a crash strands a batch for at most this long (see the batch-hold spec). */
export const MAX_STRAND_MS = 15 * 60_000;

/** Longest wall time one resilient external call can take: every execution runs to its timeout. */
export function worstCaseCallMs(preset: ResiliencePreset): number {
  const options = RESILIENCE_PRESETS[preset];
  const executions = (options.retry?.maxAttempts ?? 0) + 1;
  return executions * (options.timeout?.durationMs ?? 0);
}

/** A lease that covers `calls` resilient calls of `preset`, plus the margin. */
export function leaseForResilience(preset: ResiliencePreset, calls = 1): number {
  return calls * worstCaseCallMs(preset) + LEASE_MARGIN_MS;
}
