import { beforeEach, describe, expect, it, vi } from 'vitest';

import { hashToken, prefixOf } from '../domain/api-token';
import type { ApiTokenRow } from '../infrastructure/persistence/api-token.drizzle-repository';
import { ApiTokensService } from './api-tokens.service';

const WORKSPACE = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const OTHER_USER = '33333333-3333-3333-3333-333333333333';

/** In-memory stand-in for the repository. The service owns the credential rules; this owns nothing. */
class FakeRepo {
  rows: ApiTokenRow[] = [];
  touched: string[] = [];
  /** Requested lifetime per token id, as the service handed it to the INSERT. */
  lifetimes = new Map<string, number>();

  create = vi.fn(
    async (
      input: Omit<ApiTokenRow, 'id' | 'lastUsedAt' | 'revokedAt' | 'createdAt' | 'expiresAt'> & {
        expiresInDays: number;
      },
    ) => {
      const { expiresInDays, ...columns } = input;
      const row: ApiTokenRow = {
        id: `token-${this.rows.length + 1}`,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: new Date('2026-08-19T00:00:00.000Z'),
        // The database computes `expires_at` (now() + lifetime). This double only needs a Date there;
        // the expiry instant itself is asserted against the database in api-tokens-db-clock.e2e.spec.ts.
        expiresAt: new Date('2026-11-17T00:00:00.000Z'),
        ...columns,
      };
      this.lifetimes.set(row.id, expiresInDays);
      this.rows.push(row);
      return row;
    },
  );

  /** The lookup excludes revoked rows; expiry is decided by the database clock, which this double lacks. */
  findLiveByPrefix = vi.fn(
    async (prefix: string) =>
      this.rows.find((r) => r.prefix === prefix && r.revokedAt === null) ?? null,
  );

  findById = vi.fn(
    async (workspaceId: string, id: string) =>
      this.rows.find((r) => r.workspaceId === workspaceId && r.id === id) ?? null,
  );

  listForUser = vi.fn(async (workspaceId: string, userId: string) =>
    this.rows.filter((r) => r.workspaceId === workspaceId && r.userId === userId),
  );

  listActiveForWorkspace = vi.fn(async (workspaceId: string) =>
    this.rows.filter((r) => r.workspaceId === workspaceId && r.revokedAt === null),
  );

  revoke = vi.fn(async (workspaceId: string, id: string) => {
    const row = this.rows.find((r) => r.workspaceId === workspaceId && r.id === id);
    if (!row || row.revokedAt) return false;
    row.revokedAt = new Date();
    return true;
  });

  revokeAllForUser = vi.fn(async (workspaceId: string, userId: string) => {
    const live = this.rows.filter(
      (r) => r.workspaceId === workspaceId && r.userId === userId && r.revokedAt === null,
    );
    live.forEach((r) => (r.revokedAt = new Date()));
    return live.length;
  });

  touch = vi.fn(async (workspaceId: string, id: string) => {
    // Signature mirrors the repository's: `touch` carries its own workspace predicate rather than
    // trusting the primary key, so a double that ignored the first argument would hide a caller passing
    // them in the wrong order.
    this.touched.push(`${workspaceId}:${id}`);
  });
}

describe('ApiTokensService', () => {
  let repo: FakeRepo;
  let service: ApiTokensService;

  beforeEach(() => {
    repo = new FakeRepo();
    service = new ApiTokensService(repo as never);
  });

  describe('mint', () => {
    it('returns the credential once and stores only its hash', async () => {
      const { token, plaintext } = await service.mint({
        workspaceId: WORKSPACE,
        userId: USER,
        name: 'ci',
      });

      const stored = repo.rows[0];
      expect(stored.tokenHash).toBe(hashToken(plaintext));
      // The plaintext must appear nowhere in the row — not in a column, not in the name.
      expect(JSON.stringify(stored)).not.toContain(plaintext);
      expect(token.prefix).toBe(prefixOf(plaintext));
    });

    it('trims the name and defaults the lifetime to 90 days', async () => {
      const { token } = await service.mint({
        workspaceId: WORKSPACE,
        userId: USER,
        name: '  ci  ',
      });

      expect(token.name).toBe('ci');
      expect(repo.lifetimes.get(token.id)).toBe(90);
    });

    it('refuses an unknown scope, naming it', async () => {
      // Rejected at mint, where the mistake was made. At use time a typo and a permission the user
      // does not hold are indistinguishable: both narrow to nothing and both look like a 403.
      await expect(
        service.mint({
          workspaceId: WORKSPACE,
          userId: USER,
          name: 'typo',
          scopes: ['work_item:view', 'work_item:vieww'],
        }),
      ).rejects.toThrow(/work_item:vieww/);
      expect(repo.rows).toHaveLength(0);
    });

    it('deduplicates scopes and treats an empty list as no narrowing', async () => {
      await service.mint({
        workspaceId: WORKSPACE,
        userId: USER,
        name: 'dupes',
        scopes: ['work_item:view', 'work_item:view'],
      });
      expect(repo.rows[0].scopes).toEqual(['work_item:view']);

      await service.mint({ workspaceId: WORKSPACE, userId: USER, name: 'none', scopes: [] });
      // NULL, not `[]`: an empty array would be indistinguishable from "narrowed to nothing".
      expect(repo.rows[1].scopes).toBeNull();
    });
  });

  describe('verify', () => {
    it('authenticates a live token and records the use', async () => {
      const { plaintext } = await service.mint({
        workspaceId: WORKSPACE,
        userId: USER,
        name: 'ci',
      });

      const verified = await service.verify(plaintext);

      expect(verified).toMatchObject({ workspaceId: WORKSPACE, userId: USER });
      expect(repo.touched).toEqual([`${WORKSPACE}:${repo.rows[0].id}`]);
    });

    it('returns null for an unknown, malformed or revoked token', async () => {
      // One outcome for every failure. Distinguishing "expired" from "never existed" tells an attacker
      // which of their guesses was once real.
      expect(await service.verify('rly_deadbeefdeadbeef')).toBeNull();
      expect(await service.verify('not-a-rally-token')).toBeNull();

      // Expiry by database time is asserted in api-tokens-db-clock.e2e.spec.ts: the lookup excludes it.
      const revoked = await service.mint({ workspaceId: WORKSPACE, userId: USER, name: 'revoked' });
      await service.revokeOwn(WORKSPACE, USER, repo.rows[repo.rows.length - 1].id);
      expect(await service.verify(revoked.plaintext)).toBeNull();
    });

    it('rejects a token whose prefix matches but whose secret does not', async () => {
      // The prefix is an index, not a credential. This is the case a lookup-by-prefix without a hash
      // comparison would wave through.
      const { plaintext } = await service.mint({
        workspaceId: WORKSPACE,
        userId: USER,
        name: 'ci',
      });
      const forged = `${plaintext.slice(0, 12)}${'A'.repeat(plaintext.length - 12)}`;

      expect(forged.slice(0, 12)).toBe(plaintext.slice(0, 12));
      expect(await service.verify(forged)).toBeNull();
    });

    it('survives a failed use-recording write', async () => {
      // `last_used_at` is forensic. Losing it must not cost the request its authentication.
      repo.touch.mockRejectedValueOnce(new Error('database gone'));
      const { plaintext } = await service.mint({
        workspaceId: WORKSPACE,
        userId: USER,
        name: 'ci',
      });

      await expect(service.verify(plaintext)).resolves.not.toBeNull();
    });
  });

  describe('revocation', () => {
    it("reports another user's token as not found, not as forbidden", async () => {
      // A 403 would confirm the id exists, which is what an enumeration attempt is looking for.
      await service.mint({ workspaceId: WORKSPACE, userId: OTHER_USER, name: 'theirs' });

      await expect(service.revokeOwn(WORKSPACE, USER, repo.rows[0].id)).rejects.toThrow(
        /not found/i,
      );
      expect(repo.rows[0].revokedAt).toBeNull();
    });

    it('is idempotent', async () => {
      const { plaintext } = await service.mint({
        workspaceId: WORKSPACE,
        userId: USER,
        name: 'ci',
      });
      const id = repo.rows[0].id;

      await service.revokeOwn(WORKSPACE, USER, id);
      const firstRevocation = repo.rows[0].revokedAt;
      await service.revokeOwn(WORKSPACE, USER, id);

      // The second call must not re-date the first: `revoked_at` is the field an incident review reads.
      expect(repo.rows[0].revokedAt).toBe(firstRevocation);
      expect(await service.verify(plaintext)).toBeNull();
    });

    it('revokes every token of a user for offboarding', async () => {
      await service.mint({ workspaceId: WORKSPACE, userId: USER, name: 'one' });
      await service.mint({ workspaceId: WORKSPACE, userId: USER, name: 'two' });
      await service.mint({ workspaceId: WORKSPACE, userId: OTHER_USER, name: 'theirs' });

      expect(await service.revokeAllForUser(WORKSPACE, USER)).toBe(2);
      expect(repo.rows.filter((r) => r.revokedAt !== null)).toHaveLength(2);
      // Someone else's automation must keep working.
      expect(repo.rows[2].revokedAt).toBeNull();
    });
  });

  describe('listing', () => {
    it("includes revoked tokens in the owner's list and excludes them from the admin's", async () => {
      // Different questions: the owner's list is a history, the admin's answers "what still has access".
      await service.mint({ workspaceId: WORKSPACE, userId: USER, name: 'live' });
      await service.mint({ workspaceId: WORKSPACE, userId: USER, name: 'dead' });
      await service.revokeOwn(WORKSPACE, USER, repo.rows[1].id);

      expect(await service.listOwn(WORKSPACE, USER)).toHaveLength(2);
      expect(await service.listWorkspace(WORKSPACE)).toHaveLength(1);
    });

    it('never projects the hash', async () => {
      await service.mint({ workspaceId: WORKSPACE, userId: USER, name: 'ci' });
      const [view] = await service.listOwn(WORKSPACE, USER);

      // Not secret in the way the token is, but it is the verifier — nothing outside the database has
      // any use for it, and a response that carries it invites offline comparison.
      expect(view).not.toHaveProperty('tokenHash');
    });
  });
});
