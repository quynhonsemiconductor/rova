import { Injectable, Logger } from '@nestjs/common';

import { NotFoundException, PermissionDeniedException } from '@platform';
import { PERMISSION } from '@shared-kernel';
import type { Permission } from '@shared-kernel';

import {
  DEFAULT_EXPIRY_DAYS,
  assertExpiryDays,
  hashesMatch,
  hashToken,
  mintToken,
  prefixOf,
} from '../domain/api-token';
import {
  ApiTokenDrizzleRepository,
  type ApiTokenRow,
} from '../infrastructure/persistence/api-token.drizzle-repository';

export interface MintRequest {
  workspaceId: string;
  userId: string;
  name: string;
  expiresInDays?: number;
  /** Narrowing only. Absent or empty means the token inherits the user's permissions unchanged. */
  scopes?: string[];
}

export interface MintResult {
  token: ApiTokenView;
  /** The credential. The ONLY time it exists outside the caller's own storage. */
  plaintext: string;
}

export interface ApiTokenView {
  id: string;
  name: string;
  prefix: string;
  scopes: string[] | null;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  userId: string;
}

export interface VerifiedToken {
  id: string;
  workspaceId: string;
  userId: string;
  scopes: string[] | null;
  /** The row's own instants. Carried so the principal's `iat`/`exp` are facts, not placeholders. */
  createdAt: Date;
  expiresAt: Date;
}

/**
 * The set a token's `scopes` may name.
 *
 * Validated at mint time rather than trusted at use time, because a typo in a scope is otherwise
 * indistinguishable from a permission the user does not hold: both intersect to nothing, and the
 * request fails with a 403 that says the wrong thing. Failing at mint puts the error where the mistake
 * was made.
 */
const KNOWN_PERMISSIONS = new Set<string>(Object.values(PERMISSION));

@Injectable()
export class ApiTokensService {
  private readonly logger = new Logger(ApiTokensService.name);

  constructor(private readonly repo: ApiTokenDrizzleRepository) {}

  /**
   * Mint a token for the calling user.
   *
   * The plaintext is returned once and never persisted in any form, so a lost token is reset rather
   * than recovered — the same contract as real Rally's API Key, and the reason `token_hash` can be a
   * one-way hash at all.
   */
  async mint(request: MintRequest): Promise<MintResult> {
    const scopes = this.validateScopes(request.scopes);
    const expiresInDays = request.expiresInDays ?? DEFAULT_EXPIRY_DAYS;
    assertExpiryDays(expiresInDays);
    const minted = mintToken();

    // The expiry instant is computed by the database in the INSERT (`now()` + lifetime), not here.
    const row = await this.repo.create({
      workspaceId: request.workspaceId,
      userId: request.userId,
      name: request.name.trim(),
      prefix: minted.prefix,
      tokenHash: minted.tokenHash,
      scopes,
      expiresInDays,
    });

    // Prefix, never the token: this line exists so an operator can correlate a mint with a later use,
    // and a log that carried the credential would defeat storing only its hash.
    this.logger.log(
      { tokenId: row.id, prefix: row.prefix, userId: row.userId, expiresAt: row.expiresAt },
      'API token minted',
    );
    return { token: toView(row), plaintext: minted.plaintext };
  }

  /**
   * Authenticate a raw token.
   *
   * Returns null for every failure — unknown, malformed, expired, revoked — and never says which. The
   * caller turns that into one 401 with one message: distinguishing "expired" from "never existed"
   * tells an attacker which of their guesses was once real.
   */
  async verify(rawToken: string): Promise<VerifiedToken | null> {
    const prefix = prefixOf(rawToken);
    if (!prefix) return null;

    // Expired and revoked tokens are excluded by the lookup itself, against the database clock.
    const row = await this.repo.findLiveByPrefix(prefix);
    if (!row) return null;
    if (!hashesMatch(row.tokenHash, hashToken(rawToken))) return null;

    // Fire-and-forget: `last_used_at` is forensic, and making authentication wait on a throttled
    // write would put a database round trip in front of every request to buy nothing.
    void this.repo.touch(row.workspaceId, row.id).catch((err: unknown) => {
      this.logger.warn({ err, tokenId: row.id }, 'Failed to record API token use');
    });

    return {
      id: row.id,
      workspaceId: row.workspaceId,
      userId: row.userId,
      scopes: row.scopes,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  }

  /** A user's own tokens, revoked ones included — the list is also the audit surface. */
  async listOwn(workspaceId: string, userId: string): Promise<ApiTokenView[]> {
    const rows = await this.repo.listForUser(workspaceId, userId);
    return rows.map(toView);
  }

  /** Every live token in the workspace. Requires `api_token:manage_all` at the route. */
  async listWorkspace(workspaceId: string): Promise<ApiTokenView[]> {
    const rows = await this.repo.listActiveForWorkspace(workspaceId);
    return rows.map(toView);
  }

  /**
   * Revoke one of the caller's own tokens.
   *
   * Ownership is enforced here rather than by a permission code, because "your own" is not a permission
   * — it is a property of the row, and `PolicyGuard` has no way to express it. A token belonging to
   * someone else is reported as NOT FOUND, not as forbidden: a 403 would confirm that a token id
   * exists, which is exactly what an enumeration attempt is looking for.
   */
  async revokeOwn(workspaceId: string, userId: string, tokenId: string): Promise<void> {
    const row = await this.repo.findById(workspaceId, tokenId);
    if (!row || row.userId !== userId) {
      throw new NotFoundException('API_TOKEN_NOT_FOUND', 'API token not found');
    }
    await this.repo.revoke(workspaceId, tokenId);
    this.logger.log({ tokenId, userId }, 'API token revoked by owner');
  }

  /** Revoke any token in the workspace. The administrator's path. */
  async revokeAsAdmin(workspaceId: string, tokenId: string, actorId: string): Promise<void> {
    const row = await this.repo.findById(workspaceId, tokenId);
    if (!row) {
      throw new NotFoundException('API_TOKEN_NOT_FOUND', 'API token not found');
    }
    await this.repo.revoke(workspaceId, tokenId);
    this.logger.log(
      { tokenId, ownerId: row.userId, actorId },
      'API token revoked by workspace administrator',
    );
  }

  /**
   * Revoke every token of one user. Called by offboarding.
   *
   * Sessions are already revoked when a user is deactivated; tokens have to be too, or a departed
   * user's automation keeps its access until the token expires — up to a year. The user-level denylist
   * covers the request-scale window, this write covers the rest.
   */
  async revokeAllForUser(workspaceId: string, userId: string): Promise<number> {
    const count = await this.repo.revokeAllForUser(workspaceId, userId);
    if (count > 0) {
      this.logger.log({ userId, count }, 'API tokens revoked for user');
    }
    return count;
  }

  private validateScopes(scopes: string[] | undefined): string[] | null {
    if (!scopes || scopes.length === 0) return null;
    const unknown = scopes.filter((scope) => !KNOWN_PERMISSIONS.has(scope));
    if (unknown.length > 0) {
      throw new PermissionDeniedException(
        'API_TOKEN_UNKNOWN_SCOPE',
        `Unknown permission code(s): ${unknown.join(', ')}`,
      );
    }
    return [...new Set(scopes)] as Permission[];
  }
}

function toView(row: ApiTokenRow): ApiTokenView {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    userId: row.userId,
  };
}
