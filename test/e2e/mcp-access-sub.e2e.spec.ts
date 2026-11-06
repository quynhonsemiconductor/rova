/**
 * Two-session proof for the Access `sub` first-bind — through the REAL adapter.
 *
 * The API connects as the runtime role (`rova_app`, the CI DSN), the fixtures as the migrator.
 * Two independent pools present two Access identities for the same email at the same time;
 * exactly one verifies, the loser is refused with the same error the route turns into a 403, and
 * the row carries the winner's subject. Binding happens only after the workspace check, so a
 * refused session never leaves a permanent subject behind.
 */
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMcpAccessJwtAdapter,
  McpAccessDeniedError,
} from '../../apps/api/src/mcp/access-jwt.adapter';
import * as schema from '../../db/schema';

const AUD = 'e2e-aud-tag';
/** CI's E2E job sets this to the restricted role; the migrator env is the owner. */
const runtimeUrl = process.env['DATABASE_URL'];
const migrationUrl = process.env['DATABASE_MIGRATION_URL'] ?? runtimeUrl;
if (!runtimeUrl || !migrationUrl) {
  throw new Error('this spec needs DATABASE_URL (runtime role) and DATABASE_MIGRATION_URL (owner)');
}

const userId = randomUUID();
const workspaceId = randomUUID();
const email = `mcp-sub-race-${randomUUID()}@qnsc.vn`;
const pools: Pool[] = [];
let jwksServer: http.Server | undefined;

function pool(url: string): Pool {
  const created = new Pool({ connectionString: url, max: 1 });
  pools.push(created);
  return created;
}

interface MintArgs {
  privateKey: CryptoKey;
  team: string;
  sub: string;
  email: string;
}

async function mint(a: MintArgs): Promise<string> {
  return new SignJWT({ email: a.email })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setSubject(a.sub)
    .setIssuer(a.team)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
    .setNotBefore(Math.floor(Date.now() / 1000) - 5)
    .sign(a.privateKey);
}

async function listenJwks(keys: unknown[]): Promise<string> {
  jwksServer = http
    .createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys }));
    })
    .listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => jwksServer!.once('listening', resolve));
  return `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}`;
}

describe('MCP Access sub binding (real Postgres, real adapter)', () => {
  beforeAll(async () => {
    const admin = pool(migrationUrl);
    await admin.query(
      `INSERT INTO identity.users (id, email, display_name, status, email_verified)
       VALUES ($1, $2, 'MCP Race', 'active', true)`,
      [userId, email],
    );
    await admin.query(
      `INSERT INTO workspace.workspaces (id, slug, name, status) VALUES ($1, $2, 'MCP Race', 'active')`,
      [workspaceId, `mcp-race-${workspaceId.slice(0, 8)}`],
    );
    await admin.query(
      `INSERT INTO workspace.workspace_members (id, workspace_id, user_id, status)
       VALUES ($1, $2, $3, 'active')`,
      [randomUUID(), workspaceId, userId],
    );
  });

  afterAll(async () => {
    const admin = pool(migrationUrl);
    await admin.query('DELETE FROM workspace.workspace_members WHERE user_id = $1', [userId]);
    await admin.query('DELETE FROM workspace.workspaces WHERE id = $1', [workspaceId]);
    await admin.query('DELETE FROM identity.users WHERE id = $1', [userId]);
    await Promise.all(pools.map((p) => p.end()));
    if (jwksServer) await new Promise<void>((resolve) => jwksServer!.close(() => resolve()));
  });

  it('lets exactly one session bind, and the loser gets the uniform denial', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    const publicJwk = { kid: 'k1', ...(await exportJWK(publicKey)) };
    const team = await listenJwks([publicJwk]);

    // Two independent RUNTIME-role pools, exactly as two API replicas would be.
    const poolA = pool(runtimeUrl);
    const poolB = pool(runtimeUrl);
    const role = await poolA.query<{ current_user: string }>('SELECT current_user');
    // The e2e job runs the app as rova_app; locally a developer's owner DSN is accepted.
    if (process.env['CI']) expect(role.rows[0]?.current_user).toBe('rova_app');

    const adapterA = createMcpAccessJwtAdapter({
      db: drizzle(poolA, { schema }),
      teamDomain: team,
      audience: AUD,
    });
    const adapterB = createMcpAccessJwtAdapter({
      db: drizzle(poolB, { schema }),
      teamDomain: team,
      audience: AUD,
    });

    const tokenA = await mint({ privateKey, team, sub: 'sub-a', email });
    const tokenB = await mint({ privateKey, team, sub: 'sub-b', email });

    const results = await Promise.allSettled([adapterA.verify(tokenA), adapterB.verify(tokenB)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0]?.status !== 'rejected') throw new Error('unreachable');
    expect(rejected[0].reason).toBeInstanceOf(McpAccessDeniedError);

    const winnerToken = results[0]?.status === 'fulfilled' ? tokenA : tokenB;
    const loserToken = winnerToken === tokenA ? tokenB : tokenA;
    const winnerSub = winnerToken === tokenA ? 'sub-a' : 'sub-b';
    expect((fulfilled[0] as PromiseFulfilledResult<{ workspaceId: string }>).value).toEqual({
      userId,
      workspaceId,
    });

    const check = await pool(migrationUrl).query<{ access_subject: string }>(
      'SELECT access_subject FROM identity.users WHERE id = $1',
      [userId],
    );
    expect(check.rows[0]?.access_subject).toBe(winnerSub);

    // A later session with the losing identity is refused; the winner is idempotent.
    const later = createMcpAccessJwtAdapter({
      db: drizzle(pool(runtimeUrl), { schema }),
      teamDomain: team,
      audience: AUD,
    });
    await expect(later.verify(loserToken)).rejects.toBeInstanceOf(McpAccessDeniedError);
    await expect(later.verify(winnerToken)).resolves.toEqual({ userId, workspaceId });
  });
});
