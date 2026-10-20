import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EXPIRY_DAYS,
  MAX_EXPIRY_DAYS,
  assertExpiryDays,
  hashToken,
  hashesMatch,
  mintToken,
  prefixOf,
} from './api-token';

describe('mintToken', () => {
  it('returns a prefixed credential, its prefix, and its hash', () => {
    const minted = mintToken();

    expect(minted.plaintext.startsWith('rly_')).toBe(true);
    expect(minted.prefix).toBe(minted.plaintext.slice(0, 'rly_'.length + 8));
    expect(minted.tokenHash).toBe(hashToken(minted.plaintext));
  });

  it('never repeats', () => {
    // 200 mints is not a randomness test — it is a guard against a constant slipping in where the
    // CSPRNG call should be, which is the only way this function realistically breaks.
    const seen = new Set(Array.from({ length: 200 }, () => mintToken().plaintext));
    expect(seen.size).toBe(200);
  });

  it('produces a URL- and shell-safe secret', () => {
    // base64url, so nothing has to escape it in a header, a URL, a YAML file or an env var — the four
    // places a machine credential actually lives.
    for (let i = 0; i < 50; i += 1) {
      expect(mintToken().plaintext).toMatch(/^rly_[A-Za-z0-9_-]+$/);
    }
  });

  it('carries at least 256 bits of entropy', () => {
    // The reason sha256 is an adequate storage hash: there is nothing to brute-force. If the secret
    // ever shrinks, this fails and the storage decision has to be revisited.
    const secret = mintToken().plaintext.slice('rly_'.length);
    expect(secret.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url, unpadded
  });
});

describe('prefixOf', () => {
  it('recovers the stored prefix from a raw token', () => {
    const minted = mintToken();
    expect(prefixOf(minted.plaintext)).toBe(minted.prefix);
  });

  it('rejects anything that is not a Rova token', () => {
    expect(prefixOf('eyJhbGciOiJFUzI1NiJ9.e30.sig')).toBeNull();
    expect(prefixOf('rly_short')).toBeNull();
    expect(prefixOf('')).toBeNull();
  });
});

describe('hashesMatch', () => {
  it('accepts identical hashes and rejects different ones', () => {
    const hash = hashToken('rly_abc');
    expect(hashesMatch(hash, hashToken('rly_abc'))).toBe(true);
    expect(hashesMatch(hash, hashToken('rly_abd'))).toBe(false);
  });

  it('returns false rather than throwing on a length mismatch', () => {
    // `timingSafeEqual` throws on unequal lengths, which would turn a malformed credential into a 500
    // and leak the mismatch through the error rather than the comparison.
    expect(hashesMatch(hashToken('rly_abc'), 'deadbeef')).toBe(false);
  });
});

describe('assertExpiryDays', () => {
  it('accepts a lifetime from one day up to the cap', () => {
    expect(() => assertExpiryDays(DEFAULT_EXPIRY_DAYS)).not.toThrow();
    expect(() => assertExpiryDays(1)).not.toThrow();
    expect(() => assertExpiryDays(MAX_EXPIRY_DAYS)).not.toThrow();
    expect(DEFAULT_EXPIRY_DAYS).toBe(90);
  });

  it('refuses a lifetime past the cap, zero, negative or fractional', () => {
    // The cap is the whole point of having expiry at all: the real agile ALM tool's keys never expire, which is why
    // nobody rotates them. An unbounded `expiresInDays` would reproduce that.
    for (const days of [0, -1, 1.5, MAX_EXPIRY_DAYS + 1, Number.NaN]) {
      expect(() => assertExpiryDays(days)).toThrow(RangeError);
    }
  });
});
