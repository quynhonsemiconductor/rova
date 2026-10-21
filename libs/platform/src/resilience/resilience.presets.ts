import { ResilienceOptions, ResiliencePattern, ResiliencePreset } from './resilience.types';

/**
 * Presets tuned for specific integration categories.
 * Pass `ResiliencePreset.X` to `ResilienceService.execute(name, fn, preset)`.
 */
export const RESILIENCE_PRESETS: Record<ResiliencePreset, ResilienceOptions> = {
  [ResiliencePreset.EXTERNAL_API]: {
    patterns: [
      ResiliencePattern.RETRY,
      ResiliencePattern.CIRCUIT_BREAKER,
      ResiliencePattern.TIMEOUT,
      ResiliencePattern.BULKHEAD,
    ],
    retry: { maxAttempts: 3, useJitter: true },
    timeout: { durationMs: 30_000 },
    circuitBreaker: { failureThreshold: 5, halfOpenAfterMs: 60_000 },
    bulkhead: { maxConcurrent: 10, maxQueue: 5 },
  },

  [ResiliencePreset.DATABASE]: {
    patterns: [
      ResiliencePattern.RETRY,
      ResiliencePattern.CIRCUIT_BREAKER,
      ResiliencePattern.TIMEOUT,
    ],
    retry: { maxAttempts: 3, useJitter: true },
    timeout: { durationMs: 5_000 },
    circuitBreaker: { failureThreshold: 5, halfOpenAfterMs: 30_000 },
  },

  [ResiliencePreset.CACHE]: {
    patterns: [ResiliencePattern.TIMEOUT, ResiliencePattern.CIRCUIT_BREAKER],
    timeout: { durationMs: 500 },
    circuitBreaker: { failureThreshold: 5, halfOpenAfterMs: 30_000 },
  },

  [ResiliencePreset.EMAIL]: {
    patterns: [
      ResiliencePattern.RETRY,
      ResiliencePattern.CIRCUIT_BREAKER,
      ResiliencePattern.TIMEOUT,
      ResiliencePattern.BULKHEAD,
    ],
    retry: { maxAttempts: 5, useJitter: true },
    timeout: { durationMs: 30_000 },
    circuitBreaker: { failureThreshold: 3, halfOpenAfterMs: 120_000 },
    bulkhead: { maxConcurrent: 5, maxQueue: 10 },
  },

  /**
   * S3 / external object storage, for BACKGROUND callers — the worker's reaper
   * (`apps/worker/src/cron/cleanup.cron.ts` → `deleteObject`) and anything else with
   * nobody waiting on it. AWS SDK has its own retry but we add a circuit breaker so a
   * full S3 degradation fails fast instead of queue-filling.
   *
   * The 60s budget is DELIBERATE HERE and wrong on the request path. Note also that
   * `maxAttempts` is cockatiel's RETRY count, not the total: `RetryPolicy.js` gates on
   * `retries < this.options.maxAttempts`, so `3` means four executions and the real
   * worst case is ~4 x 60s plus backoff, not 180s. A cron job that takes four minutes
   * to give up on one object is fine; a user holding an HTTP request for four minutes
   * is not. Use STORAGE_INTERACTIVE from the request path instead of lowering this.
   */
  [ResiliencePreset.STORAGE]: {
    patterns: [
      ResiliencePattern.RETRY,
      ResiliencePattern.CIRCUIT_BREAKER,
      ResiliencePattern.TIMEOUT,
    ],
    retry: { maxAttempts: 3, useJitter: true },
    timeout: { durationMs: 60_000 },
    circuitBreaker: { failureThreshold: 5, halfOpenAfterMs: 60_000 },
  },

  /**
   * Object storage on the SYNCHRONOUS request path, where a user is holding an open
   * HTTP connection for the whole thing. Currently `headObject` from
   * `AttachmentsService.confirm()`, which is the confirm step of an upload the browser
   * has already completed.
   *
   * WHY IT EXISTS. `confirm()` ran under STORAGE, so a Cloudflare R2 blip produced a
   * request that took MINUTES and then answered 200 (or 412, because `headObject`
   * swallows its error and returns null, which the service reads as
   * ATTACHMENT_NOT_UPLOADED). Invisible to the 5xx-rate alert — nothing failed — and
   * invisible in the latency histogram too, whose top finite bucket was 10000ms, so
   * 10s and 240s were the same number. Two presets rather than one lowered value
   * because the acceptable wait is a property of the CALLER: the reaper genuinely
   * wants to keep trying, and lowering STORAGE would have made a background job give
   * up on work nobody was waiting for.
   *
   * THE NUMBERS.
   *  - `timeout: 3_000`. A HEAD against R2 from the same region is single-digit
   *    milliseconds warm; 3s is roughly three orders of magnitude of headroom, so it
   *    fires only when the dependency is genuinely wedged rather than merely slow.
   *  - `maxAttempts: 1`. This is cockatiel's RETRY count (see the STORAGE note above),
   *    so it means two executions total — the initial call plus one retry. That is the
   *    "at most 2 attempts" this preset is specified for; writing `2` here would give
   *    three. One retry is worth having because the failure this exists for is
   *    usually a single dropped connection, and a second one is not: if two HEADs in a
   *    row cannot answer in 3s each, R2 is having an incident and a third attempt is
   *    just more of the user's time.
   *  - Worst case is therefore ~6.1s (2 x 3s plus the 100ms first backoff step),
   *    which lands under the ALB's 60s idle timeout with a wide margin and inside the
   *    7500ms histogram bucket, so a degraded confirm is now distinguishable from a
   *    healthy one instead of being clamped at the top of the range.
   *  - The circuit breaker keeps STORAGE's shape but halves `failureThreshold` to 3.
   *    Failing fast is worth more when someone is watching: three consecutive 3s
   *    failures is ~19s of evidence, after which every subsequent confirm answers
   *    immediately rather than each buying its own 6s. It is a SEPARATE circuit from
   *    STORAGE's by construction — `ResilienceService` caches policies by NAME, so the
   *    two budgets must never share a policy name (`StorageService.headObject`
   *    derives the name from the preset for exactly this reason).
   */
  [ResiliencePreset.STORAGE_INTERACTIVE]: {
    patterns: [
      ResiliencePattern.RETRY,
      ResiliencePattern.CIRCUIT_BREAKER,
      ResiliencePattern.TIMEOUT,
    ],
    retry: { maxAttempts: 1, useJitter: true },
    timeout: { durationMs: 3_000 },
    circuitBreaker: { failureThreshold: 3, halfOpenAfterMs: 60_000 },
  },
};

export const RESILIENCE_DEFAULTS: ResilienceOptions = {
  patterns: [ResiliencePattern.RETRY, ResiliencePattern.CIRCUIT_BREAKER, ResiliencePattern.TIMEOUT],
  retry: { maxAttempts: 3, useJitter: true },
  timeout: { durationMs: 30_000 },
  circuitBreaker: { failureThreshold: 5, halfOpenAfterMs: 60_000 },
  bulkhead: { maxConcurrent: 10, maxQueue: 5 },
};
