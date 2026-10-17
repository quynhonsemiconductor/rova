import type { JwtPayload } from './principal';

/**
 * Prefix every API token carries.
 *
 * Load-bearing in three places: the guard tells an opaque token from anything else in the same header by it, secret
 * scanners key on it, and a leaked string in a log or a commit is identifiable at a glance as a Rova credential. Shared
 * here so the minting service and the guard cannot disagree about it.
 */
export const API_TOKEN_PREFIX = 'rly_';

/** True when a Bearer value is an API token. */
export function isApiTokenValue(value: string): boolean {
  return value.startsWith(API_TOKEN_PREFIX);
}

/** The credential in an `Authorization: Bearer <value>` header, or undefined. */
export function bearerValue(authorization: string | string[] | undefined): string | undefined {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  if (typeof header !== 'string') return undefined;
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith('bearer ')) return undefined;
  return trimmed.slice('bearer '.length).trim() || undefined;
}

/** A principal authenticated by an API token. */
export type ApiTokenPrincipal = JwtPayload & { apiTokenId: string };
