/**
 * Two-session proof for the Access `sub` first-bind.
 *
 * `bindAccessSubject` is the one SQL path the MCP adapter uses: `UPDATE ... WHERE
 * access_subject IS NULL RETURNING id`. Two independent pools race to bind different Access
 * identities to the same account; exactly one may win, and the loser must be refused. The row
 * then carries the winner's subject.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bindAccessSubject } from '../../apps/api/src/mcp/access-jwt.adapter';
import * as schema from '../../db/schema';

const url = process.env['DATABASE_MIGRATION_URL'] ?? process.env['DATABASE_URL'];
if (!url) throw new Error('this spec needs DATABASE_URL (or DATABASE_MIGRATION_URL)');

const userId = randomUUID();
const email = `mcp-sub-race-${randomUUID()}@qnsc.vn`;
const pools: Pool[] = [];

function pool(): Pool {
  const created = new Pool({ connectionString: url, max: 1 });
  pools.push(created);
  return created;
}

describe('MCP Access sub binding (real Postgres)', () => {
  beforeAll(async () => {
    const admin = pool();
    await admin.query(
      `INSERT INTO identity.users (id, email, display_name, status, email_verified)
       VALUES ($1, $2, 'MCP Race', 'active', true)`,
      [userId, email],
    );
  });

  afterAll(async () => {
    const admin = pool();
    await admin.query('DELETE FROM identity.users WHERE id = $1', [userId]);
    await Promise.all(pools.map((p) => p.end()));
  });

  it('lets exactly one of two sessions bind a different sub, and the loser sees the winner', async () => {
    const dbA = drizzle(pool(), { schema });
    const dbB = drizzle(pool(), { schema });

    const results = await Promise.allSettled([
      bindAccessSubject(dbA, userId, 'access-sub-a'),
      bindAccessSubject(dbB, userId, 'access-sub-b'),
    ]);

    const values = results.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
    const winner = values[0] === 'bound' ? 'access-sub-a' : 'access-sub-b';
    const loser = winner === 'access-sub-a' ? 'access-sub-b' : 'access-sub-a';
    expect([...values].sort()).toEqual(['bound', 'mismatch']);
    expect(values).not.toContain('same');

    const check = await pool().query<{ access_subject: string }>(
      'SELECT access_subject FROM identity.users WHERE id = $1',
      [userId],
    );
    expect(check.rows[0]?.access_subject).toBe(winner);

    // A later session presenting the losing identity is refused; the winner is idempotent.
    const after = drizzle(pool(), { schema });
    await expect(bindAccessSubject(after, userId, loser)).resolves.toBe('mismatch');
    await expect(bindAccessSubject(after, userId, winner)).resolves.toBe('same');
  });
});
