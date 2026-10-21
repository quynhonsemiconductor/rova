import { describe, expect, it } from 'vitest';
import { retryAfterMsFrom } from './retry-after';

const headers = (h: Record<string, string>) => ({
  get: (name: string) => h[name.toLowerCase()] ?? null,
});
const NOW = Date.parse('2026-10-12T12:00:00Z');

describe('retryAfterMsFrom', () => {
  it('reads Retry-After in seconds', () => {
    expect(retryAfterMsFrom(headers({ 'retry-after': '120' }), NOW)).toBe(120_000);
    expect(retryAfterMsFrom(headers({ 'retry-after': '0' }), NOW)).toBe(0);
  });

  it('reads Retry-After as an HTTP date, relative to now', () => {
    expect(retryAfterMsFrom(headers({ 'retry-after': 'Mon, 12 Oct 2026 12:01:30 GMT' }), NOW)).toBe(
      90_000,
    );
  });

  it('a date in the past is zero, never negative', () => {
    expect(retryAfterMsFrom(headers({ 'retry-after': 'Mon, 12 Oct 2026 11:00:00 GMT' }), NOW)).toBe(
      0,
    );
  });

  it("reads GitHub's primary rate limit reset ONLY when the window is spent", () => {
    const reset = String(Math.floor(NOW / 1000) + 600);
    expect(
      retryAfterMsFrom(headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }), NOW),
    ).toBe(600_000);
    // Requests left: the reset header is just the end of the current window, not a reason to wait.
    expect(
      retryAfterMsFrom(
        headers({ 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': reset }),
        NOW,
      ),
    ).toBeUndefined();
  });

  it('prefers Retry-After over the reset header', () => {
    expect(
      retryAfterMsFrom(
        headers({
          'retry-after': '30',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(NOW / 1000) + 600),
        }),
        NOW,
      ),
    ).toBe(30_000);
  });

  it.each(['', '  ', 'soon', '-5', 'NaN', 'Infinity'])('ignores a malformed value %j', (value) => {
    expect(retryAfterMsFrom(headers({ 'retry-after': value }), NOW)).toBeUndefined();
  });

  it('is undefined when neither header is present', () => {
    expect(retryAfterMsFrom(headers({}), NOW)).toBeUndefined();
  });

  it('does not clamp: the relay does, so a hostile hint is visible here and bounded there', () => {
    expect(retryAfterMsFrom(headers({ 'retry-after': '99999999' }), NOW)).toBe(99_999_999_000);
  });
});
