import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { API_TOKEN_PREFIX } from '@platform';

/**
 * Token generation and verification. Pure functions, no IO — the repository stores what these produce
 * and the resolver compares with what these derive.
 */

/** Bytes of CSPRNG output behind every token. 32 bytes ≈ 256 bits, rendered base64url. */
const SECRET_BYTES = 32;

/** Characters of the secret kept in `prefix`, after the `rly_` literal. */
const PREFIX_BODY_LENGTH = 8;

export interface MintedToken {
  /** The credential. Returned to the caller ONCE and never stored in any form. */
  readonly plaintext: string;
  /** `rly_` + the first 8 characters. Identifies the token without holding it. */
  readonly prefix: string;
  /** `sha256(plaintext)`, hex. What the database stores. */
  readonly tokenHash: string;
}

/**
 * Mint a token.
 *
 * base64url rather than hex so the same entropy is a third shorter, and rather than a custom alphabet
 * so nothing has to escape it in a header, a URL, a YAML file or a shell variable — the four places a
 * machine credential actually lives.
 */
export function mintToken(): MintedToken {
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const plaintext = `${API_TOKEN_PREFIX}${secret}`;
  return {
    plaintext,
    prefix: `${API_TOKEN_PREFIX}${secret.slice(0, PREFIX_BODY_LENGTH)}`,
    tokenHash: hashToken(plaintext),
  };
}

/**
 * Hash a token for storage and lookup.
 *
 * sha256, deliberately, and the reasoning is in migration 0125: the input is high-entropy random, so a
 * work factor defends nothing, and this runs on every authenticated request. Do not "upgrade" this to
 * bcrypt or argon2 without also moving authentication off the hot path.
 */
export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/** The prefix a raw token would have been stored under, or null when it is not a Rova token. */
export function prefixOf(plaintext: string): string | null {
  if (!plaintext.startsWith(API_TOKEN_PREFIX)) return null;
  const body = plaintext.slice(API_TOKEN_PREFIX.length);
  if (body.length < PREFIX_BODY_LENGTH) return null;
  return `${API_TOKEN_PREFIX}${body.slice(0, PREFIX_BODY_LENGTH)}`;
}

/**
 * Constant-time comparison of two hex hashes.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak a bit and crash the request,
 * so the lengths are checked first and unequal ones are simply false. Both inputs here are sha256 hex
 * so a mismatch means malformed input rather than a near miss.
 */
export function hashesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Expiry bounds.
 *
 * A default rather than an unbounded choice, and a cap rather than a suggestion: real Rally's keys
 * never expire, which is why nobody rotates them, and Atlassian settled on one year as the outer limit
 * for the same class of credential. 90 days is short enough that an abandoned token disappears on its
 * own and long enough that a quarterly rotation is not a weekly chore.
 */
export const DEFAULT_EXPIRY_DAYS = 90;
export const MAX_EXPIRY_DAYS = 365;

/**
 * Refuse a lifetime outside the bounds. The expiry INSTANT is not computed here: it is `now()` plus the
 * lifetime in the database's INSERT, so the stored clock is the database's, never the host's.
 */
export function assertExpiryDays(days: number): void {
  if (!Number.isInteger(days) || days < 1 || days > MAX_EXPIRY_DAYS) {
    throw new RangeError(`expiresInDays must be an integer between 1 and ${MAX_EXPIRY_DAYS}`);
  }
}
