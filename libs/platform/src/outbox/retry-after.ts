/**
 * Reads how long an HTTP server asked us to wait, so a relay can back a throttled row off for exactly that long
 * (via {@link RetryAfterError}) instead of for its ordinary 30 s curve.
 *
 * Two headers carry it:
 *   - `Retry-After`: delta-seconds, or an HTTP date (RFC 9110 §10.2.3). Microsoft Graph sends it on 429/503; GitHub
 *     sends it on secondary rate limits.
 *   - `x-ratelimit-reset` (GitHub primary rate limit): epoch SECONDS at which the window resets. It only means
 *     "wait" when `x-ratelimit-remaining` is `0`; on any other response it is just the next window's end.
 *
 * Returns undefined when neither yields a finite, non-negative number. The relay clamps the result to
 * MAX_RETRY_AFTER_MS, so a hostile value cannot park a row for ever; this function does not clamp, so a test can see
 * the raw hint.
 */
export function retryAfterMsFrom(
  headers: { get(name: string): string | null },
  now: number = Date.now(),
): number | undefined {
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null && retryAfter.trim() !== '') {
    const trimmed = retryAfter.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const seconds = Number(trimmed);
      if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    } else if (/[A-Za-z]{3}/.test(trimmed)) {
      // An HTTP-date names its day and month; anything else Date.parse would happily read ("-5") is not one.
      const at = Date.parse(trimmed);
      if (Number.isFinite(at)) return Math.max(0, at - now);
    }
  }

  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  if (
    remaining !== null &&
    remaining.trim() === '0' &&
    reset !== null &&
    /^\d+$/.test(reset.trim())
  ) {
    const at = Number(reset.trim()) * 1000;
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  return undefined;
}
