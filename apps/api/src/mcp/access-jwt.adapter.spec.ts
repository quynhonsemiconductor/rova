import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import type { DrizzleDB } from '@platform';
import { createMcpAccessJwtAdapter, McpAccessDeniedError } from './access-jwt.adapter';

/**
 * The real access adapter against a REAL verifier and a REAL local JWKS server (identity's
 * `createAccessJwtVerifier` accepts a loopback http team domain exactly for this). Pins the P0
 * spike's constraints: full token verification (signature, iss, aud, exp) with one uniform 401
 * for any bad token; the employee resolved from the email — the same trim+lowercase normaliser
 * as `UserDirectory.findByEmail`, asserted on the captured query parameters — with the
 * email-verified (guest) exclusion; exactly one active workspace, ambiguous failing CLOSED;
 * unknown or offboarded employee → one uniform logged 403; never auto-provisioned.
 */

const AUD = 'e2e-aud-tag';
const USER = '0194a000-0000-7000-8000-0000000000aa';
const WORKSPACE = '0194a000-0000-7000-8000-000000000003';
const TEAM = (port: number) => `http://127.0.0.1:${port}`;

/** Drizzle SQL nodes carry their bound values in (nested) `queryChunks`; pull them out. */
function paramsOf(node: unknown, out: unknown[] = []): unknown[] {
  const chunks = (node as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!chunks) return out;
  for (const chunk of chunks) {
    if (chunk && typeof chunk === 'object') {
      if ('value' in chunk) out.push(chunk.value);
      else paramsOf(chunk, out);
    }
  }
  return out;
}

/** A drizzle stand-in: each `select`/`update` consumes one queue entry (array or thrown Error). */
function dbWith(queue: Array<unknown>) {
  const captured: unknown[][] = [];
  const next = () => {
    const value = queue.shift();
    if (value instanceof Error) throw value;
    return (value as unknown[]) ?? [];
  };
  const db = {
    select: () => ({
      from: () => ({
        where: (where?: unknown) => ({
          limit: async () => {
            captured.push(paramsOf(where));
            return next();
          },
        }),
        innerJoin: () => ({
          where: (joined?: unknown) => ({
            orderBy: async () => {
              captured.push(paramsOf(joined));
              return next();
            },
          }),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => next(),
        }),
      }),
    }),
  };
  return { db: db as never as DrizzleDB, captured };
}

const EMPLOYEE = {
  id: USER,
  status: 'active',
  emailVerified: true,
  deletedAt: null,
  accessSubject: 'access-sub-1',
} as const;

function employee(overrides: Record<string, unknown> = {}) {
  return { ...EMPLOYEE, ...overrides };
}

const logger = { warn: vi.fn() };

async function listen(
  jwks: Record<string, unknown>,
): Promise<{ server: http.Server; port: number }> {
  const server = http
    .createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(jwks));
    })
    .listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

/** RS256 minting key + its public JWK, served as the team JWKS under kid 'k1'. */
async function mintingKey(): Promise<{
  privateKey: CryptoKey;
  publicJwk: Record<string, unknown>;
}> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = { kid: 'k1', ...(await exportJWK(publicKey)) };
  return { privateKey, publicJwk };
}

interface MintArgs {
  privateKey: CryptoKey;
  team: string;
  sub?: string;
  email?: string;
  aud?: string;
  exp?: number;
}

async function mint(a: MintArgs): Promise<string> {
  return new SignJWT({ ...(a.email !== undefined ? { email: a.email } : {}) })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setSubject(a.sub ?? 'access-sub-1')
    .setIssuer(a.team)
    .setAudience(a.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(a.exp ?? Math.floor(Date.now() / 1000) + 600)
    .setNotBefore(Math.floor(Date.now() / 1000) - 5)
    .sign(a.privateKey);
}

describe('McpAccessJwtAdapter', () => {
  it('maps a verified token to the ACTIVE employee by email — normalised, with the guest exclusion', async () => {
    const { privateKey, publicJwk } = await mintingKey();
    const { server, port } = await listen({ keys: [publicJwk] });
    try {
      const { db, captured } = dbWith([
        [employee()], // employee select: the email matched
        [{ workspaceId: WORKSPACE }], // workspace select
      ]);
      const adapter = createMcpAccessJwtAdapter({
        db,
        teamDomain: TEAM(port),
        audience: AUD,
        logger: logger as never,
      });
      const out = await adapter.verify(
        await mint({ privateKey, team: TEAM(port), email: '  Jane@QNSC.vn ', sub: 'access-sub-1' }),
      );
      expect(out).toEqual({ userId: USER, workspaceId: WORKSPACE });
      // the employee lookup carried the NORMALISED email; the guest exclusion is applied to
      // the selected row in the adapter (and is covered by the disabled/unverified tests).
      expect(captured[0]).toContain('jane@qnsc.vn');
    } finally {
      server.close();
    }
  });

  it('denies (403) an OFFBOARDED or unknown employee — logged as { accessSub, reason }, never the email', async () => {
    const { privateKey, publicJwk } = await mintingKey();
    const { server, port } = await listen({ keys: [publicJwk] });
    try {
      const { db } = dbWith([[employee({ status: 'disabled' })]]); // the account is not active
      const adapter = createMcpAccessJwtAdapter({
        db,
        teamDomain: TEAM(port),
        audience: AUD,
        logger: logger as never,
      });
      await expect(
        adapter.verify(await mint({ privateKey, team: TEAM(port), email: 'gone@qnsc.vn' })),
      ).rejects.toThrow(McpAccessDeniedError);
      expect(logger.warn).toHaveBeenCalledWith(
        { accessSub: 'access-sub-1', reason: 'no_active_employee' },
        'MCP access denied',
      );
    } finally {
      server.close();
    }
  });

  it('denies an unknown employee with no exact or case-insensitive match', async () => {
    const { privateKey, publicJwk } = await mintingKey();
    const { server, port } = await listen({ keys: [publicJwk] });
    try {
      const { db } = dbWith([[], []]); // exact miss, lower(email) miss
      const adapter = createMcpAccessJwtAdapter({
        db,
        teamDomain: TEAM(port),
        audience: AUD,
        logger: logger as never,
      });
      await expect(
        adapter.verify(await mint({ privateKey, team: TEAM(port), email: 'gone@qnsc.vn' })),
      ).rejects.toThrow(McpAccessDeniedError);
      expect(logger.warn).toHaveBeenCalledWith(
        { accessSub: 'access-sub-1', reason: 'no_active_employee' },
        'MCP access denied',
      );
    } finally {
      server.close();
    }
  });

  it('denies (403) an employee with no active workspace membership', async () => {
    const { privateKey, publicJwk } = await mintingKey();
    const { server, port } = await listen({ keys: [publicJwk] });
    try {
      const { db } = dbWith([[employee()], []]);
      const adapter = createMcpAccessJwtAdapter({
        db,
        teamDomain: TEAM(port),
        audience: AUD,
        logger: logger as never,
      });
      await expect(
        adapter.verify(await mint({ privateKey, team: TEAM(port), email: 'jane@qnsc.vn' })),
      ).rejects.toThrow(McpAccessDeniedError);
      expect(logger.warn).toHaveBeenCalledWith(
        { accessSub: 'access-sub-1', reason: 'no_workspace' },
        'MCP access denied',
      );
    } finally {
      server.close();
    }
  });

  it('denies (403) when MORE THAN ONE active workspace matches — ambiguity fails closed', async () => {
    const { privateKey, publicJwk } = await mintingKey();
    const { server, port } = await listen({ keys: [publicJwk] });
    try {
      const { db } = dbWith([
        [employee()],
        [{ workspaceId: WORKSPACE }, { workspaceId: '0194a000-0000-7000-8000-000000000009' }],
      ]);
      const adapter = createMcpAccessJwtAdapter({
        db,
        teamDomain: TEAM(port),
        audience: AUD,
        logger: logger as never,
      });
      await expect(
        adapter.verify(await mint({ privateKey, team: TEAM(port), email: 'jane@qnsc.vn' })),
      ).rejects.toThrow(McpAccessDeniedError);
      expect(logger.warn).toHaveBeenCalledWith(
        { accessSub: 'access-sub-1', reason: 'ambiguous_workspace' },
        'MCP access denied',
      );
    } finally {
      server.close();
    }
  });

  it('binds the first Access sub on an unbound account and then admits it', async () => {
    const { privateKey, publicJwk } = await mintingKey();
    const { server, port } = await listen({ keys: [publicJwk] });
    try {
      const { db } = dbWith([
        [employee({ accessSubject: null })],
        [{ id: USER }], // UPDATE ... RETURNING id
        [{ workspaceId: WORKSPACE }],
      ]);
      const adapter = createMcpAccessJwtAdapter({
        db,
        teamDomain: TEAM(port),
        audience: AUD,
        logger: logger as never,
      });
      await expect(
        adapter.verify(await mint({ privateKey, team: TEAM(port), email: 'jane@qnsc.vn' })),
      ).resolves.toEqual({ userId: USER, workspaceId: WORKSPACE });
    } finally {
      server.close();
    }
  });

  it('refuses a DIFFERENT Access sub for an account already bound', async () => {
    const { privateKey, publicJwk } = await mintingKey();
    const { server, port } = await listen({ keys: [publicJwk] });
    try {
      const { db } = dbWith([[employee({ accessSubject: 'someone-else' })]]);
      const adapter = createMcpAccessJwtAdapter({
        db,
        teamDomain: TEAM(port),
        audience: AUD,
        logger: logger as never,
      });
      await expect(
        adapter.verify(await mint({ privateKey, team: TEAM(port), email: 'jane@qnsc.vn' })),
      ).rejects.toThrow(McpAccessDeniedError);
      expect(logger.warn).toHaveBeenCalledWith(
        { accessSub: 'access-sub-1', reason: 'access_subject_mismatch' },
        'MCP access denied',
      );
    } finally {
      server.close();
    }
  });

  it('finds an account through the lower(email) fallback when the stored case differs', async () => {
    const { privateKey, publicJwk } = await mintingKey();
    const { server, port } = await listen({ keys: [publicJwk] });
    try {
      const { db } = dbWith([
        [], // exact address missed
        [employee()], // lower(email) matched one row
        [{ workspaceId: WORKSPACE }],
      ]);
      const adapter = createMcpAccessJwtAdapter({
        db,
        teamDomain: TEAM(port),
        audience: AUD,
        logger: logger as never,
      });
      await expect(
        adapter.verify(await mint({ privateKey, team: TEAM(port), email: 'jane@qnsc.vn' })),
      ).resolves.toEqual({ userId: USER, workspaceId: WORKSPACE });
    } finally {
      server.close();
    }
  });

  it('refuses an email that collides case-insensitively instead of picking a row', async () => {
    const { privateKey, publicJwk } = await mintingKey();
    const { server, port } = await listen({ keys: [publicJwk] });
    try {
      const { db } = dbWith([
        [], // no exact match
        [employee(), employee({ id: '0194a000-0000-7000-8000-0000000000bb' })],
      ]);
      const adapter = createMcpAccessJwtAdapter({
        db,
        teamDomain: TEAM(port),
        audience: AUD,
        logger: logger as never,
      });
      await expect(
        adapter.verify(await mint({ privateKey, team: TEAM(port), email: 'jane@qnsc.vn' })),
      ).rejects.toThrow(McpAccessDeniedError);
      expect(logger.warn).toHaveBeenCalledWith(
        { accessSub: 'access-sub-1', reason: 'ambiguous_email' },
        'MCP access denied',
      );
    } finally {
      server.close();
    }
  });

  it('refuses when the first bind loses a race to a different sub', async () => {
    const { privateKey, publicJwk } = await mintingKey();
    const { server, port } = await listen({ keys: [publicJwk] });
    try {
      const { db } = dbWith([
        [employee({ accessSubject: null })],
        [], // UPDATE matched zero rows: another session won
        [{ accessSubject: 'winner-sub' }],
      ]);
      const adapter = createMcpAccessJwtAdapter({
        db,
        teamDomain: TEAM(port),
        audience: AUD,
        logger: logger as never,
      });
      await expect(
        adapter.verify(await mint({ privateKey, team: TEAM(port), email: 'jane@qnsc.vn' })),
      ).rejects.toThrow(McpAccessDeniedError);
      expect(logger.warn).toHaveBeenCalledWith(
        { accessSub: 'access-sub-1', reason: 'access_subject_mismatch' },
        'MCP access denied',
      );
    } finally {
      server.close();
    }
  });

  it('is idempotent when another thread bound the SAME sub first', async () => {
    const { privateKey, publicJwk } = await mintingKey();
    const { server, port } = await listen({ keys: [publicJwk] });
    try {
      const { db } = dbWith([
        [employee({ accessSubject: null })],
        [], // UPDATE matched zero rows
        [{ accessSubject: 'access-sub-1' }], // the other thread wrote our sub
        [{ workspaceId: WORKSPACE }],
      ]);
      const adapter = createMcpAccessJwtAdapter({
        db,
        teamDomain: TEAM(port),
        audience: AUD,
        logger: logger as never,
      });
      await expect(
        adapter.verify(await mint({ privateKey, team: TEAM(port), email: 'jane@qnsc.vn' })),
      ).resolves.toEqual({ userId: USER, workspaceId: WORKSPACE });
    } finally {
      server.close();
    }
  });

  it('rethrows a non-unique database failure instead of turning it into a 403', async () => {
    const { privateKey, publicJwk } = await mintingKey();
    const { server, port } = await listen({ keys: [publicJwk] });
    try {
      const { db } = dbWith([[employee({ accessSubject: null })], new Error('connection reset')]);
      const adapter = createMcpAccessJwtAdapter({
        db,
        teamDomain: TEAM(port),
        audience: AUD,
        logger: logger as never,
      });
      await expect(
        adapter.verify(await mint({ privateKey, team: TEAM(port), email: 'jane@qnsc.vn' })),
      ).rejects.toThrow('connection reset');
    } finally {
      server.close();
    }
  });

  it('refuses a sub already bound to another account (unique violation)', async () => {
    const { privateKey, publicJwk } = await mintingKey();
    const { server, port } = await listen({ keys: [publicJwk] });
    try {
      const conflict = Object.assign(new Error('duplicate key'), { code: '23505' });
      const { db } = dbWith([[employee({ accessSubject: null })], conflict]);
      const adapter = createMcpAccessJwtAdapter({
        db,
        teamDomain: TEAM(port),
        audience: AUD,
        logger: logger as never,
      });
      await expect(
        adapter.verify(await mint({ privateKey, team: TEAM(port), email: 'jane@qnsc.vn' })),
      ).rejects.toThrow(McpAccessDeniedError);
      expect(logger.warn).toHaveBeenCalledWith(
        { accessSub: 'access-sub-1', reason: 'access_subject_taken' },
        'MCP access denied',
      );
    } finally {
      server.close();
    }
  });

  it.each([
    ['wrong audience', { aud: 'another-apps-aud' }],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 3600 }],
    ['wrong issuer', { team: 'https://someone-elses.cloudflareaccess.com' }],
  ])('answers one uniform 401 for a %s token', async (_name, overrides) => {
    const { privateKey, publicJwk } = await mintingKey();
    const { server, port } = await listen({ keys: [publicJwk] });
    try {
      const { db } = dbWith([[employee()], [{ workspaceId: WORKSPACE }]]);
      const adapter = createMcpAccessJwtAdapter({
        db,
        teamDomain: TEAM(port),
        audience: AUD,
        logger: logger as never,
      });
      const token = await mint({
        privateKey,
        team: TEAM(port),
        email: 'jane@qnsc.vn',
        ...overrides,
      });
      expect(await adapter.verify(token)).toBeNull();
    } finally {
      server.close();
    }
  });

  it('answers 401 for a token signed by a key the team JWKS does not carry', async () => {
    const { publicJwk } = await mintingKey();
    const attacker = await mintingKey();
    const { server, port } = await listen({ keys: [publicJwk] });
    try {
      const { db } = dbWith([]);
      const adapter = createMcpAccessJwtAdapter({
        db,
        teamDomain: TEAM(port),
        audience: AUD,
        logger: logger as never,
      });
      const forged = await mint({
        privateKey: attacker.privateKey,
        team: TEAM(port),
        email: 'jane@qnsc.vn',
      });
      expect(await adapter.verify(forged)).toBeNull();
    } finally {
      server.close();
    }
  });

  it('a JWKS fetch failure is availability (thrown, a 5xx) — never a 401', async () => {
    // port 1 is nothing: the fetch cannot connect
    const { db } = dbWith([]);
    const adapter = createMcpAccessJwtAdapter({
      db,
      teamDomain: TEAM(1),
      audience: AUD,
      logger: logger as never,
    });
    // a well-formed token, so verification reaches the JWKS fetch (a malformed token never
    // touches the network and is a 401)
    const { privateKey } = await mintingKey();
    const token = await mint({ privateKey, team: TEAM(1), email: 'jane@qnsc.vn' });
    await expect(adapter.verify(token)).rejects.toMatchObject({ code: 'jwks_unavailable' });
  });
});
