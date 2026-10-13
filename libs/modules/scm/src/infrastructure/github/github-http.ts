/**
 * Deadlines for GitHub calls.
 *
 * Neither `fetch` nor the callers had one, so a GitHub call that never answered held the backfill relay's
 * row (and, before the lease-and-fence relay, its transaction) for as long as the socket stayed open.
 *
 *   - every request is capped at {@link GITHUB_CALL_TIMEOUT_MS};
 *   - a whole run is capped by the caller's `signal` (see `BACKFILL_RUN_BUDGET_MS`), which is merged in, so
 *     the request in flight when the budget runs out is cancelled rather than left to finish a call whose
 *     result nobody will read.
 *
 * The relay's lease is derived from the run budget plus one call timeout, so it always outlives the work.
 */

/** The longest any single GitHub request may take, headers and body. */
export const GITHUB_CALL_TIMEOUT_MS = 30_000;

/** A signal that aborts after one call's deadline, or sooner when the run's `external` signal does. */
export function githubCallSignal(external?: AbortSignal): AbortSignal {
  const perCall = AbortSignal.timeout(GITHUB_CALL_TIMEOUT_MS);
  return external ? AbortSignal.any([perCall, external]) : perCall;
}
